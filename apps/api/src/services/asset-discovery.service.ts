import { BadRequestException, Injectable } from '@nestjs/common';
import { type AssetSearchResponse } from '@cmd/shared-types';
import { CoinGeckoRequestError, CoinGeckoService } from './coingecko.service';
import { MarketMapperService } from './market-mapper.service';
import { SimpleMemoryCacheService } from './simple-memory-cache.service';

@Injectable()
export class AssetDiscoveryService {
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly staleTtlMs = 30 * 60 * 1000;

  constructor(
    private readonly coinGeckoService: CoinGeckoService,
    private readonly marketMapperService: MarketMapperService,
    private readonly cacheService: SimpleMemoryCacheService,
  ) {}

  async searchAssets(query: string): Promise<AssetSearchResponse> {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      throw new BadRequestException('q query parameter must be at least 2 characters long');
    }

    const cacheKey = `assets:${trimmed.toLowerCase()}`;
    const fresh = this.cacheService.getFresh<AssetSearchResponse>(cacheKey);

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
      const response = await this.coinGeckoService.searchAssets(trimmed);
      const results = this.marketMapperService.mapSearchCoins(trimmed, response.coins ?? []);
      const payload: AssetSearchResponse = {
        query: trimmed,
        results,
        source: {
          provider: 'coingecko',
          cache: 'miss',
          fetchedAt: new Date().toISOString(),
        },
      };

      this.cacheService.set(cacheKey, payload, this.ttlMs, this.staleTtlMs);
      return payload;
    } catch (error) {
      const stale = this.cacheService.getStale<AssetSearchResponse>(cacheKey);

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
          query: trimmed,
          results: [],
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
