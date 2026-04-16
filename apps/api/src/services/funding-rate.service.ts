import { Injectable } from '@nestjs/common';
import type { AssetDescriptor, AssetFundingRateResponse, FundingRatePoint } from '@cmd/shared-types';

interface FundingRateHint {
  symbol?: string;
  name?: string;
}

interface BinanceFundingRateEntry {
  symbol?: string;
  fundingRate?: string;
  fundingTime?: number;
}

interface BinancePremiumIndexEntry {
  symbol?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

@Injectable()
export class FundingRateService {
  private readonly timeoutMs = 8_000;
  private readonly defaultLimit = 90;

  async getAssetFundingRates(assetId: string, hint?: FundingRateHint, limit?: number): Promise<AssetFundingRateResponse> {
    const asset = this.toAssetDescriptor(assetId, hint);
    const normalizedLimit = this.normalizeLimit(limit);

    for (const baseAsset of this.baseAssetCandidates(asset.symbol)) {
      const symbol = `${baseAsset}USDT`;
      const [historyPayload, premiumPayload] = await Promise.all([
        this.fetchJson<BinanceFundingRateEntry[]>(
          `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${normalizedLimit}`,
        ),
        this.fetchJson<BinancePremiumIndexEntry>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
      ]);

      const points = this.normalizeFundingPoints(historyPayload ?? []);
      const premium = premiumPayload?.symbol === symbol ? premiumPayload : null;

      if (points.length === 0 && !premium) {
        continue;
      }

      return {
        assetId: asset.id,
        symbol,
        exchangeCode: 'binance',
        exchangeName: 'Binance',
        capturedAt: new Date().toISOString(),
        currentFundingRate: this.toFiniteNumber(premium?.lastFundingRate) ?? points.at(-1)?.fundingRate ?? null,
        nextFundingTime: this.toIsoString(premium?.nextFundingTime) ?? null,
        points,
      };
    }

    return {
      assetId: asset.id,
      symbol: null,
      exchangeCode: 'binance',
      exchangeName: 'Binance',
      capturedAt: new Date().toISOString(),
      currentFundingRate: null,
      nextFundingTime: null,
      points: [],
    };
  }

  private toAssetDescriptor(assetId: string, hint?: FundingRateHint): AssetDescriptor {
    const normalizedAssetId = assetId.trim().toLowerCase();

    return {
      id: normalizedAssetId,
      symbol: (hint?.symbol?.trim() || normalizedAssetId).toUpperCase(),
      name: hint?.name?.trim() || hint?.symbol?.trim() || normalizedAssetId,
    };
  }

  private normalizeFundingPoints(entries: BinanceFundingRateEntry[]): FundingRatePoint[] {
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries
      .map((entry) => {
        const fundingRate = this.toFiniteNumber(entry?.fundingRate);
        const fundingTime = this.toIsoString(entry?.fundingTime);

        if (fundingRate === null || !fundingTime) {
          return null;
        }

        return {
          fundingRate,
          fundingTime,
        } satisfies FundingRatePoint;
      })
      .filter((point): point is FundingRatePoint => Boolean(point))
      .sort((left, right) => new Date(left.fundingTime).getTime() - new Date(right.fundingTime).getTime());
  }

  private normalizeLimit(limit?: number) {
    if (!Number.isFinite(limit)) {
      return this.defaultLimit;
    }

    return Math.min(200, Math.max(24, Math.floor(limit ?? this.defaultLimit)));
  }

  private baseAssetCandidates(symbol: string): string[] {
    const normalized = symbol.toUpperCase().trim();
    if (!normalized) {
      return [];
    }

    if (normalized.startsWith('1000')) {
      return [normalized];
    }

    return [normalized, `1000${normalized}`];
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toFiniteNumber(value: unknown): number | null {
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(num) ? num : null;
  }

  private toIsoString(value: unknown): string | null {
    const timestamp = this.toFiniteNumber(value);
    if (timestamp === null) {
      return null;
    }

    const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
}
