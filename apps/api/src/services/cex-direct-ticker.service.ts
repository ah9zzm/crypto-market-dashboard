import { Injectable } from '@nestjs/common';
import type { MarketTicker, RowSource } from '@cmd/shared-types';
import { BinanceLiveTickerService } from './binance-live-ticker.service';

interface DirectTickerValue {
  lastPrice: number | null;
  volume24hUsd: number | null;
  lastTradedAt: string | null;
  source: RowSource;
}

@Injectable()
export class CexDirectTickerService {
  private readonly timeoutMs = 8_000;

  constructor(private readonly binanceLiveTickerService: BinanceLiveTickerService) {}

  async enrichMarkets(markets: MarketTicker[]): Promise<MarketTicker[]> {
    const enrichedRows = await Promise.all(markets.map((row) => this.enrichRow(row)));
    return enrichedRows;
  }

  private async enrichRow(row: MarketTicker): Promise<MarketTicker> {
    if (row.marketType !== 'CEX' || row.instrumentType !== 'spot') {
      return row;
    }

    const directTicker = await this.fetchDirectTicker(row);
    if (!directTicker) {
      return row;
    }

    return {
      ...row,
      lastPrice: directTicker.lastPrice ?? row.lastPrice,
      volume24hUsd: directTicker.volume24hUsd ?? row.volume24hUsd,
      lastTradedAt: directTicker.lastTradedAt ?? row.lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(directTicker.lastTradedAt ?? row.lastTradedAt),
      source: directTicker.source,
    } satisfies MarketTicker;
  }

  private async fetchDirectTicker(row: MarketTicker): Promise<DirectTickerValue | null> {
    switch (row.exchangeCode) {
      case 'binance':
        return this.binanceLiveTickerService.getTickerForMarket(row) ?? this.fetchBinanceTicker(`${row.baseAsset}${row.quoteAsset}`);
      case 'kucoin':
        return this.fetchKuCoinTicker(`${row.baseAsset}-${row.quoteAsset}`);
      case 'gate':
        return this.fetchGateTicker(`${row.baseAsset}_${row.quoteAsset}`);
      case 'mxc':
        return this.fetchMexcTicker(`${row.baseAsset}${row.quoteAsset}`);
      default:
        return null;
    }
  }

  private async fetchBinanceTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!payload) return null;
    return {
      lastPrice: this.toFiniteNumber(payload.lastPrice),
      volume24hUsd: this.toFiniteNumber(payload.quoteVolume),
      lastTradedAt: this.toIsoString(payload.closeTime),
      source: 'binance',
    };
  }

  private async fetchKuCoinTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.data;
    if (!data) return null;
    return {
      lastPrice: this.toFiniteNumber(data.last),
      volume24hUsd: this.toFiniteNumber(data.volValue),
      lastTradedAt: this.toIsoString(data.time),
      source: 'kucoin',
    };
  }

  private async fetchGateTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any[]>(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`);
    const data = Array.isArray(payload) ? payload[0] : null;
    if (!data) return null;
    return {
      lastPrice: this.toFiniteNumber(data.last),
      volume24hUsd: this.toFiniteNumber(data.quote_volume),
      lastTradedAt: new Date().toISOString(),
      source: 'gate',
    };
  }

  private async fetchMexcTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!payload) return null;
    return {
      lastPrice: this.toFiniteNumber(payload.lastPrice),
      volume24hUsd: this.toFiniteNumber(payload.quoteVolume),
      lastTradedAt: this.toIsoString(payload.closeTime),
      source: 'mexc',
    };
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
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private formatUpdatedAtLabel(lastTradedAt: string | null) {
    if (!lastTradedAt) {
      return '업데이트 정보 없음';
    }

    const diffMs = Date.now() - new Date(lastTradedAt).getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

    if (diffMinutes < 1) {
      return '방금';
    }
    if (diffMinutes < 60) {
      return `${diffMinutes}분 전`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}시간 전`;
    }
    return `${Math.floor(diffHours / 24)}일 전`;
  }
}
