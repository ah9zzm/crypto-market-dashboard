import { BadRequestException, Injectable } from '@nestjs/common';
import { type AssetMarketsResponse } from '@cmd/shared-types';
import { CexDirectTickerService } from './cex-direct-ticker.service';
import { CoinGeckoRequestError, CoinGeckoService } from './coingecko.service';
import { MarketMapperService } from './market-mapper.service';
import { FuturesDirectTickerService } from './futures-direct-ticker.service';
import { SimpleMemoryCacheService } from './simple-memory-cache.service';

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

  async getMarkets(assetId: string): Promise<AssetMarketsResponse> {
    const normalizedAssetId = assetId.trim().toLowerCase();

    if (!normalizedAssetId) {
      throw new BadRequestException('asset query parameter is required');
    }

    const cacheKey = `markets:${normalizedAssetId}`;
    const fresh = this.cacheService.getFresh<AssetMarketsResponse>(cacheKey);

    if (fresh) {
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
      const enrichedSpotMarkets = await this.cexDirectTickerService.enrichMarkets(mapped.markets);
      const directFuturesMarkets = await this.futuresDirectTickerService.getFuturesMarkets(mapped.asset);
      const mergedMarkets = [...enrichedSpotMarkets, ...directFuturesMarkets]
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
        return {
          asset: {
            id: normalizedAssetId,
            symbol: normalizedAssetId.toUpperCase(),
            name: normalizedAssetId,
          },
          markets: [],
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
}
