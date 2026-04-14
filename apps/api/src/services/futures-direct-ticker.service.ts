import { Injectable } from '@nestjs/common';
import type { AssetDescriptor, MarketTicker, RowSource, TrustScore } from '@cmd/shared-types';

interface FuturesTickerResult {
  exchangeCode: 'binance' | 'okx' | 'bingx' | 'bybit' | 'bitget';
  exchangeName: string;
  baseAsset: string;
  quoteAsset: 'USDT';
  lastPrice: number | null;
  volume24hUsd: number | null;
  spreadPct: number | null;
  lastTradedAt: string | null;
  source: RowSource;
  tradeUrl?: string | null;
}

@Injectable()
export class FuturesDirectTickerService {
  private readonly timeoutMs = 8_000;

  async getFuturesMarkets(asset: AssetDescriptor): Promise<MarketTicker[]> {
    const baseAsset = asset.symbol.toUpperCase();
    const results = await Promise.all([
      this.fetchBinance(baseAsset),
      this.fetchOkx(baseAsset),
      this.fetchBingx(baseAsset),
      this.fetchBybit(baseAsset),
      this.fetchBitget(baseAsset),
    ]);

    return results
      .filter((row): row is FuturesTickerResult => Boolean(row && row.lastPrice !== null))
      .map((row) => this.toMarketTicker(asset.id, row));
  }

  private toMarketTicker(assetId: string, row: FuturesTickerResult): MarketTicker {
    return {
      rank: 0,
      marketId: `${assetId}:${row.exchangeCode}:${row.baseAsset}:${row.quoteAsset}:CEX:futures`,
      exchangeCode: row.exchangeCode,
      exchangeName: row.exchangeName,
      marketType: 'CEX',
      instrumentType: 'futures',
      symbol: `${row.baseAsset}/${row.quoteAsset}`,
      baseAsset: row.baseAsset,
      quoteAsset: row.quoteAsset,
      lastPrice: row.lastPrice,
      volume24hUsd: row.volume24hUsd,
      spreadPct: row.spreadPct,
      trustScore: null satisfies TrustScore,
      lastTradedAt: row.lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(row.lastTradedAt),
      tradeUrl: row.tradeUrl ?? null,
      source: row.source,
    };
  }

  private async fetchBinance(baseAsset: string): Promise<FuturesTickerResult | null> {
    const symbol = `${baseAsset}USDT`;
    const payload = await this.fetchJson<any>(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!payload?.symbol) return null;
    return {
      exchangeCode: 'binance',
      exchangeName: 'Binance',
      baseAsset,
      quoteAsset: 'USDT',
      lastPrice: this.toFiniteNumber(payload.lastPrice),
      volume24hUsd: this.toFiniteNumber(payload.quoteVolume),
      spreadPct: null,
      lastTradedAt: this.toIsoString(payload.closeTime),
      source: 'binance',
      tradeUrl: `https://www.binance.com/en/futures/${symbol}`,
    };
  }

  private async fetchBybit(baseAsset: string): Promise<FuturesTickerResult | null> {
    const symbol = `${baseAsset}USDT`;
    const payload = await this.fetchJson<any>(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.result?.list?.[0];
    if (!data?.symbol) return null;
    return {
      exchangeCode: 'bybit',
      exchangeName: 'Bybit',
      baseAsset,
      quoteAsset: 'USDT',
      lastPrice: this.toFiniteNumber(data.lastPrice),
      volume24hUsd: this.toFiniteNumber(data.turnover24h),
      spreadPct: this.spreadPct(data.bid1Price, data.ask1Price),
      lastTradedAt: new Date().toISOString(),
      source: 'bybit',
      tradeUrl: `https://www.bybit.com/trade/usdt/${symbol}`,
    };
  }

  private async fetchOkx(baseAsset: string): Promise<FuturesTickerResult | null> {
    const instId = `${baseAsset}-USDT-SWAP`;
    const payload = await this.fetchJson<any>(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const data = payload?.data?.[0];
    if (!data?.instId) return null;
    const lastPrice = this.toFiniteNumber(data.last);
    const volumeBase = this.toFiniteNumber(data.volCcy24h);
    return {
      exchangeCode: 'okx',
      exchangeName: 'OKX',
      baseAsset,
      quoteAsset: 'USDT',
      lastPrice,
      volume24hUsd: lastPrice !== null && volumeBase !== null ? lastPrice * volumeBase : null,
      spreadPct: this.spreadPct(data.bidPx, data.askPx),
      lastTradedAt: this.toIsoString(data.ts),
      source: 'okx',
      tradeUrl: `https://www.okx.com/trade-swap/${baseAsset.toLowerCase()}-usdt-swap`,
    };
  }

  private async fetchBitget(baseAsset: string): Promise<FuturesTickerResult | null> {
    const symbol = `${baseAsset}USDT`;
    const payload = await this.fetchJson<any>(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES`);
    const data = payload?.data?.[0];
    if (!data?.symbol) return null;
    return {
      exchangeCode: 'bitget',
      exchangeName: 'Bitget',
      baseAsset,
      quoteAsset: 'USDT',
      lastPrice: this.toFiniteNumber(data.lastPr),
      volume24hUsd: this.toFiniteNumber(data.usdtVolume ?? data.quoteVolume),
      spreadPct: this.spreadPct(data.bidPr, data.askPr),
      lastTradedAt: this.toIsoString(data.ts),
      source: 'bitget',
      tradeUrl: `https://www.bitget.com/futures/usdt/${symbol}`,
    };
  }

  private async fetchBingx(baseAsset: string): Promise<FuturesTickerResult | null> {
    const symbol = `${baseAsset}-USDT`;
    const payload = await this.fetchJson<any>(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(symbol)}`);
    const data = payload?.data;
    if (!data?.symbol) return null;
    return {
      exchangeCode: 'bingx',
      exchangeName: 'BingX',
      baseAsset,
      quoteAsset: 'USDT',
      lastPrice: this.toFiniteNumber(data.lastPrice),
      volume24hUsd: this.toFiniteNumber(data.quoteVolume),
      spreadPct: this.spreadPct(data.bidPrice, data.askPrice),
      lastTradedAt: this.toIsoString(data.closeTime),
      source: 'bingx',
      tradeUrl: `https://bingx.com/en-us/futures/forward/${baseAsset}USDT/`,
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
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(num)) {
      return null;
    }
    const millis = num > 10_000_000_000 ? num : num * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

  private formatUpdatedAtLabel(lastTradedAt: string | null) {
    if (!lastTradedAt) {
      return '업데이트 정보 없음';
    }

    const diffMs = Date.now() - new Date(lastTradedAt).getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMinutes < 1) return '방금';
    if (diffMinutes < 60) return `${diffMinutes}분 전`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}시간 전`;
    return `${Math.floor(diffHours / 24)}일 전`;
  }
}
