import { Injectable } from '@nestjs/common';
import type { AssetDescriptor, MarketTicker, RowSource, TrustScore } from '@cmd/shared-types';
import { BinanceLiveTickerService } from './binance-live-ticker.service';

interface DirectTickerValue {
  lastPrice: number | null;
  volume24hUsd: number | null;
  spreadPct?: number | null;
  lastTradedAt: string | null;
  source: RowSource;
  tradeUrl?: string | null;
}

interface PreferredSpotTickerResult extends DirectTickerValue {
  exchangeCode: 'binance' | 'okx' | 'bybit' | 'bitget' | 'bingx' | 'gate';
  exchangeName: string;
  baseAsset: string;
  quoteAsset: 'USDT';
}

@Injectable()
export class CexDirectTickerService {
  private readonly timeoutMs = 8_000;

  constructor(private readonly binanceLiveTickerService: BinanceLiveTickerService) {}

  async getPreferredSpotMarkets(asset: AssetDescriptor): Promise<MarketTicker[]> {
    const baseAsset = asset.symbol.toUpperCase();
    const results = await Promise.all([
      this.fetchPreferredBinanceSpot(baseAsset),
      this.fetchPreferredOkxSpot(baseAsset),
      this.fetchPreferredBybitSpot(baseAsset),
      this.fetchPreferredBitgetSpot(baseAsset),
      this.fetchPreferredBingxSpot(baseAsset),
      this.fetchPreferredGateSpot(baseAsset),
    ]);

    return results
      .filter((row): row is PreferredSpotTickerResult => Boolean(row && row.lastPrice !== null))
      .map((row) => this.toPreferredSpotMarketTicker(asset.id, row));
  }

  async enrichMarkets(markets: MarketTicker[]): Promise<MarketTicker[]> {
    const enrichedRows = await Promise.all(markets.map((row) => this.enrichRow(row)));
    return enrichedRows;
  }

  private toPreferredSpotMarketTicker(assetId: string, row: PreferredSpotTickerResult): MarketTicker {
    return {
      rank: 0,
      marketId: `${assetId}:${row.exchangeCode}:${row.baseAsset}:${row.quoteAsset}:CEX:spot`,
      exchangeCode: row.exchangeCode,
      exchangeName: row.exchangeName,
      marketType: 'CEX',
      instrumentType: 'spot',
      symbol: `${row.baseAsset}/${row.quoteAsset}`,
      baseAsset: row.baseAsset,
      quoteAsset: row.quoteAsset,
      lastPrice: row.lastPrice,
      volume24hUsd: row.volume24hUsd,
      spreadPct: row.spreadPct ?? null,
      trustScore: null satisfies TrustScore,
      lastTradedAt: row.lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(row.lastTradedAt),
      tradeUrl: row.tradeUrl ?? null,
      source: row.source,
    };
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
      spreadPct: directTicker.spreadPct ?? row.spreadPct,
      lastTradedAt: directTicker.lastTradedAt ?? row.lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(directTicker.lastTradedAt ?? row.lastTradedAt),
      tradeUrl: directTicker.tradeUrl ?? row.tradeUrl,
      source: directTicker.source,
    } satisfies MarketTicker;
  }

  private async fetchDirectTicker(row: MarketTicker): Promise<DirectTickerValue | null> {
    switch (this.normalizeExchangeCode(row.exchangeCode)) {
      case 'binance':
        return this.binanceLiveTickerService.getTickerForMarket(row) ?? this.fetchBinanceTicker(`${row.baseAsset}${row.quoteAsset}`);
      case 'okx':
        return this.fetchOkxTicker(`${row.baseAsset}-${row.quoteAsset}`);
      case 'bybit':
        return this.fetchBybitTicker(`${row.baseAsset}${row.quoteAsset}`);
      case 'bitget':
        return this.fetchBitgetTicker(`${row.baseAsset}${row.quoteAsset}`);
      case 'bingx':
        return this.fetchBingxTicker(`${row.baseAsset}-${row.quoteAsset}`);
      case 'kucoin':
        return this.fetchKuCoinTicker(`${row.baseAsset}-${row.quoteAsset}`);
      case 'gate':
        return this.fetchGateTicker(`${row.baseAsset}_${row.quoteAsset}`);
      case 'mexc':
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
      spreadPct: this.spreadPct(payload.bidPrice, payload.askPrice),
      lastTradedAt: this.toIsoString(payload.closeTime),
      source: 'binance',
      tradeUrl: `https://www.binance.com/en/trade/${symbol.replace('USDT', '_USDT')}?type=spot`,
    };
  }

  private async fetchOkxTicker(instId: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const data = payload?.data?.[0];
    if (!data?.instId) return null;
    return {
      lastPrice: this.toFiniteNumber(data.last),
      volume24hUsd: this.toFiniteNumber(data.volCcy24h),
      spreadPct: this.spreadPct(data.bidPx, data.askPx),
      lastTradedAt: this.toIsoString(data.ts),
      source: 'okx',
      tradeUrl: `https://www.okx.com/trade-spot/${instId.toLowerCase()}`,
    };
  }

  private async fetchBybitTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.result?.list?.[0];
    if (!data?.symbol) return null;
    return {
      lastPrice: this.toFiniteNumber(data.lastPrice),
      volume24hUsd: this.toFiniteNumber(data.turnover24h ?? data.quoteVolume),
      spreadPct: this.spreadPct(data.bid1Price, data.ask1Price),
      lastTradedAt: new Date().toISOString(),
      source: 'bybit',
      tradeUrl: `https://www.bybit.com/trade/spot/${symbol.replace('USDT', '/USDT')}`,
    };
  }

  private async fetchBitgetTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.data?.[0];
    if (!data?.symbol) return null;
    return {
      lastPrice: this.toFiniteNumber(data.close ?? data.lastPr ?? data.last),
      volume24hUsd: this.toFiniteNumber(data.usdtVol ?? data.quoteVol ?? data.quoteVolume),
      spreadPct: this.spreadPct(data.bidPr ?? data.bidPrice, data.askPr ?? data.askPrice),
      lastTradedAt: this.toIsoString(data.ts),
      source: 'bitget',
      tradeUrl: `https://www.bitget.com/spot/${symbol}`,
    };
  }

  private async fetchBingxTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.data;
    if (!data?.symbol) return null;
    return {
      lastPrice: this.toFiniteNumber(data.lastPrice),
      volume24hUsd: this.toFiniteNumber(data.quoteVolume),
      spreadPct: this.spreadPct(data.bidPrice, data.askPrice),
      lastTradedAt: this.toIsoString(data.closeTime ?? data.ts),
      source: 'bingx',
      tradeUrl: `https://bingx.com/en-us/spot/${symbol.replace('-', '')}/`,
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
      spreadPct: this.spreadPct(data.highest_bid, data.lowest_ask),
      lastTradedAt: new Date().toISOString(),
      source: 'gate',
      tradeUrl: `https://www.gate.io/trade/${symbol}`,
    };
  }

  private async fetchMexcTicker(symbol: string): Promise<DirectTickerValue | null> {
    const payload = await this.fetchJson<any>(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!payload) return null;
    return {
      lastPrice: this.toFiniteNumber(payload.lastPrice),
      volume24hUsd: this.toFiniteNumber(payload.quoteVolume),
      spreadPct: this.spreadPct(payload.bidPrice, payload.askPrice),
      lastTradedAt: this.toIsoString(payload.closeTime),
      source: 'mexc',
    };
  }

  private async fetchPreferredBinanceSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const symbol = `${baseCandidate}USDT`;
      const ticker = await this.fetchBinanceTicker(symbol);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'binance',
        exchangeName: 'Binance',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
  }

  private async fetchPreferredOkxSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const instId = `${baseCandidate}-USDT`;
      const ticker = await this.fetchOkxTicker(instId);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'okx',
        exchangeName: 'OKX',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
  }

  private async fetchPreferredBybitSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const symbol = `${baseCandidate}USDT`;
      const ticker = await this.fetchBybitTicker(symbol);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'bybit',
        exchangeName: 'Bybit',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
  }

  private async fetchPreferredBitgetSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const symbol = `${baseCandidate}USDT`;
      const ticker = await this.fetchBitgetTicker(symbol);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'bitget',
        exchangeName: 'Bitget',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
  }

  private async fetchPreferredBingxSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const symbol = `${baseCandidate}-USDT`;
      const ticker = await this.fetchBingxTicker(symbol);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'bingx',
        exchangeName: 'BingX',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
  }

  private async fetchPreferredGateSpot(baseAsset: string): Promise<PreferredSpotTickerResult | null> {
    for (const baseCandidate of this.baseAssetCandidates(baseAsset)) {
      const symbol = `${baseCandidate}_USDT`;
      const ticker = await this.fetchGateTicker(symbol);
      if (!ticker?.lastPrice) {
        continue;
      }

      return {
        exchangeCode: 'gate',
        exchangeName: 'Gate',
        baseAsset: baseCandidate,
        quoteAsset: 'USDT',
        ...ticker,
      };
    }

    return null;
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

  private normalizeExchangeCode(exchangeCode: string) {
    const normalized = exchangeCode.trim().toLowerCase();

    if (normalized.startsWith('binance')) {
      return 'binance';
    }

    if (normalized === 'okex' || normalized.startsWith('okx')) {
      return 'okx';
    }

    if (normalized.startsWith('bybit')) {
      return 'bybit';
    }

    if (normalized.startsWith('bitget')) {
      return 'bitget';
    }

    if (normalized.startsWith('bingx')) {
      return 'bingx';
    }

    if (normalized.startsWith('kucoin')) {
      return 'kucoin';
    }

    if (normalized.startsWith('gate')) {
      return 'gate';
    }

    if (normalized === 'mxc' || normalized.startsWith('mexc')) {
      return 'mexc';
    }

    return normalized;
  }

  private spreadPct(bid: unknown, ask: unknown): number | null {
    const bidNum = this.toFiniteNumber(bid);
    const askNum = this.toFiniteNumber(ask);
    if (bidNum === null || askNum === null || bidNum <= 0 || askNum <= 0) {
      return null;
    }

    const mid = (bidNum + askNum) / 2;
    if (!Number.isFinite(mid) || mid <= 0) {
      return null;
    }

    return ((askNum - bidNum) / mid) * 100;
  }

  private baseAssetCandidates(baseAsset: string): string[] {
    const normalized = baseAsset.toUpperCase().trim();
    if (!normalized) {
      return [];
    }

    if (normalized.startsWith('1000')) {
      return [normalized];
    }

    return [normalized, `1000${normalized}`];
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
