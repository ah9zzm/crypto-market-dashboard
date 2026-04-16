import { BadRequestException, Injectable } from '@nestjs/common';
import { type AssetMarketsResponse } from '@cmd/shared-types';
import { CexDirectTickerService } from './cex-direct-ticker.service';
import { CoinGeckoRequestError, CoinGeckoService } from './coingecko.service';
import { MarketMapperService } from './market-mapper.service';
import { FuturesDirectTickerService } from './futures-direct-ticker.service';
import { SimpleMemoryCacheService } from './simple-memory-cache.service';

export interface AssetIdentityHint {
  symbol?: string;
  name?: string;
}

interface GetMarketsOptions {
  refreshDirectTickers?: boolean;
}

@Injectable()
export class MarketDiscoveryService {
  private readonly ttlMs = 60 * 1000;
  private readonly staleTtlMs = 10 * 60 * 1000;

  constructor(
    private readonly coinGeckoService: CoinGeckoService,
    private readonly marketMapperService: MarketMapperService,
    private readonly cacheService: SimpleMemoryCacheService,
    private readonly cexDirectTickerService: CexDirectTickerService,
    private readonly futuresDirectTickerService: FuturesDirectTickerService,
  ) {}

  async getMarkets(assetId: string, assetHint?: AssetIdentityHint, options?: GetMarketsOptions): Promise<AssetMarketsResponse> {
    const normalizedAssetId = assetId.trim().toLowerCase();

    if (!normalizedAssetId) {
      throw new BadRequestException('asset query parameter is required');
    }

    const cacheKey = `markets:${normalizedAssetId}`;
    const fresh = this.cacheService.getFresh<AssetMarketsResponse>(cacheKey);

    if (fresh) {
      if (options?.refreshDirectTickers) {
        return this.refreshCachedMarkets(fresh.value);
      }

      return {
        ...fresh.value,
        source: {
          ...fresh.value.source,
          cache: 'hit',
          fetchedAt: fresh.fetchedAt,
        },
      };
    }

    try {
      const response = await this.coinGeckoService.getCoinTickers(normalizedAssetId);
      const mapped = this.marketMapperService.mapMarkets(normalizedAssetId, response);
      const preferredSpotMarkets = await this.cexDirectTickerService.getPreferredSpotMarkets(mapped.asset);
      const enrichedSpotMarkets = await this.cexDirectTickerService.enrichMarkets(mapped.markets);
      const directFuturesMarkets = await this.futuresDirectTickerService.getFuturesMarkets(mapped.asset);
      const mergedMarkets = this.rankMarkets(this.mergeMarkets(enrichedSpotMarkets, [...preferredSpotMarkets, ...directFuturesMarkets]));
      const payload: AssetMarketsResponse = {
        ...mapped,
        markets: mergedMarkets,
        source: {
          provider: 'coingecko',
          cache: 'miss',
          fetchedAt: new Date().toISOString(),
        },
      };

      this.cacheService.set(cacheKey, payload, this.ttlMs, this.staleTtlMs);
      return payload;
    } catch (error) {
      const stale = this.cacheService.getStale<AssetMarketsResponse>(cacheKey);

      if (stale) {
        return {
          ...stale.value,
          source: {
            ...stale.value.source,
            cache: 'stale',
            degraded: true,
            fetchedAt: stale.fetchedAt,
          },
        };
      }

      if (error instanceof CoinGeckoRequestError) {
        const fallbackAsset = {
          id: normalizedAssetId,
          symbol: (assetHint?.symbol?.trim() || normalizedAssetId).toUpperCase(),
          name: assetHint?.name?.trim() || assetHint?.symbol?.trim() || normalizedAssetId,
        };
        const directSpotMarkets = await this.cexDirectTickerService.getPreferredSpotMarkets(fallbackAsset);
        const directFuturesMarkets = await this.futuresDirectTickerService.getFuturesMarkets(fallbackAsset);

        return {
          asset: fallbackAsset,
          markets: this.rankMarkets(this.mergeMarkets([], [...directSpotMarkets, ...directFuturesMarkets])),
          source: {
            provider: 'coingecko',
            cache: 'fallback',
            degraded: true,
            fetchedAt: new Date().toISOString(),
          },
        };
      }

      throw error;
    }
  }

  private async refreshCachedMarkets(cached: AssetMarketsResponse): Promise<AssetMarketsResponse> {
    const preferredSpotMarkets = await this.cexDirectTickerService.getPreferredSpotMarkets(cached.asset);
    const enrichedSpotMarkets = await this.cexDirectTickerService.enrichMarkets(cached.markets);
    const directFuturesMarkets = await this.futuresDirectTickerService.getFuturesMarkets(cached.asset);

    return {
      ...cached,
      markets: this.rankMarkets(this.mergeMarkets(enrichedSpotMarkets, [...preferredSpotMarkets, ...directFuturesMarkets])),
      source: {
        ...cached.source,
        cache: cached.source.cache === 'fallback' ? 'fallback' : 'hit',
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  private mergeMarkets(baseMarkets: AssetMarketsResponse['markets'], overlayMarkets: AssetMarketsResponse['markets']) {
    const merged = new Map(baseMarkets.map((market) => [market.marketId, market]));

    for (const market of overlayMarkets) {
      const existing = merged.get(market.marketId);
      if (!existing) {
        merged.set(market.marketId, market);
        continue;
      }

      merged.set(market.marketId, {
        ...existing,
        ...market,
        trustScore: existing.trustScore ?? market.trustScore,
        spreadPct: market.spreadPct ?? existing.spreadPct,
        tradeUrl: market.tradeUrl ?? existing.tradeUrl,
      });
    }

    return [...merged.values()];
  }

  private rankMarkets(markets: AssetMarketsResponse['markets']) {
    return [...markets]
      .sort((left, right) => {
        const leftVolume = left.volume24hUsd ?? -1;
        const rightVolume = right.volume24hUsd ?? -1;
        if (leftVolume !== rightVolume) {
          return rightVolume - leftVolume;
        }
        return left.exchangeName.localeCompare(right.exchangeName);
      })
      .slice(0, 80)
      .map((market, index) => ({
        ...market,
        rank: index + 1,
      }));
  }
}
