import { BadRequestException, Injectable } from '@nestjs/common';
import { type AssetSearchItem, type AssetSearchResponse } from '@cmd/shared-types';
import { CoinGeckoRequestError, CoinGeckoService } from './coingecko.service';
import { MarketMapperService } from './market-mapper.service';
import { SimpleMemoryCacheService } from './simple-memory-cache.service';

@Injectable()
export class AssetDiscoveryService {
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly staleTtlMs = 30 * 60 * 1000;
  private readonly quoteSuffixes = ['USDT', 'USDC', 'FDUSD', 'USD', 'BTC', 'ETH'];

  constructor(
    private readonly coinGeckoService: CoinGeckoService,
    private readonly marketMapperService: MarketMapperService,
    private readonly cacheService: SimpleMemoryCacheService,
  ) {}

  async searchAssets(query: string): Promise<AssetSearchResponse> {
    const trimmed = query.trim();

    if (trimmed.length < 1) {
      throw new BadRequestException('q query parameter must not be empty');
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
      const searchQueries = this.buildSearchQueries(trimmed);
      const searchResponses = await Promise.all(searchQueries.map((searchQuery) => this.coinGeckoService.searchAssets(searchQuery)));
      const mappedResults = this.mergeSearchResults(searchQueries, searchResponses);
      const results = await this.enrichSearchResultsWithPrices(mappedResults);
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

  private buildSearchQueries(query: string) {
    const normalized = query.trim().toUpperCase();
    const candidates = new Set<string>([query.trim()]);

    const collapsed = normalized.replace(/[^A-Z0-9]/g, '');
    if (collapsed && collapsed !== normalized) {
      candidates.add(collapsed);
    }

    for (const suffix of this.quoteSuffixes) {
      if (!collapsed.endsWith(suffix) || collapsed.length <= suffix.length) {
        continue;
      }

      candidates.add(collapsed.slice(0, -suffix.length));
    }

    return [...candidates].filter((candidate) => candidate.trim().length > 0);
  }

  private mergeSearchResults(searchQueries: string[], searchResponses: Array<{ coins: any[] }>) {
    const merged = new Map<string, AssetSearchItem & { candidateIndex: number; resultIndex: number }>();

    searchQueries.forEach((searchQuery, candidateIndex) => {
      const mapped = this.marketMapperService.mapSearchCoins(searchQuery, searchResponses[candidateIndex]?.coins ?? []);

      mapped.forEach((item, resultIndex) => {
        const existing = merged.get(item.id);
        const candidate = {
          ...item,
          candidateIndex,
          resultIndex,
        };

        if (!existing) {
          merged.set(item.id, candidate);
          return;
        }

        if (candidate.candidateIndex < existing.candidateIndex) {
          merged.set(item.id, candidate);
          return;
        }

        if (candidate.candidateIndex === existing.candidateIndex && candidate.resultIndex < existing.resultIndex) {
          merged.set(item.id, candidate);
        }
      });
    });

    return [...merged.values()]
      .sort((left, right) => {
        if (left.candidateIndex !== right.candidateIndex) {
          return left.candidateIndex - right.candidateIndex;
        }

        if (left.resultIndex !== right.resultIndex) {
          return left.resultIndex - right.resultIndex;
        }

        const leftRank = left.marketCapRank ?? Number.MAX_SAFE_INTEGER;
        const rightRank = right.marketCapRank ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.name.localeCompare(right.name);
      })
      .slice(0, 10)
      .map(({ candidateIndex: _candidateIndex, resultIndex: _resultIndex, ...item }) => item);
  }

  private async enrichSearchResultsWithPrices(results: AssetSearchItem[]) {
    if (results.length === 0) {
      return results;
    }

    try {
      const prices = await this.coinGeckoService.getSimplePrices(results.map((item) => item.id));

      return results.map((item) => ({
        ...item,
        currentPriceUsd: this.toFiniteNumber(prices[item.id]?.usd),
      }));
    } catch {
      return results;
    }
  }

  private toFiniteNumber(value: unknown): number | null {
    const converted = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(converted) ? converted : null;
  }
}
