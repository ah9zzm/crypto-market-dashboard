import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { MarketTicker } from '@cmd/shared-types';

interface DirectTickerValue {
  lastPrice: number | null;
  volume24hUsd: number | null;
  lastTradedAt: string | null;
  source: 'binance';
}

interface CachedTickerValue extends DirectTickerValue {
  receivedAtMs: number;
}

interface BinanceAssetMarket {
  marketId: string;
  symbol: string;
}

export interface BinanceTickerUpdateEvent {
  assetId: string;
  marketId: string;
  ticker: DirectTickerValue;
}

interface BinanceTickerMessage {
  s?: string;
  c?: string;
  q?: string;
  E?: number;
}

@Injectable()
export class BinanceLiveTickerService implements OnModuleDestroy {
  private readonly baseWsUrl = 'wss://stream.binance.com:9443/stream?streams=';
  private readonly reconnectDelayMs = 3_000;
  private readonly cacheTtlMs = 30_000;
  private readonly assetMarkets = new Map<string, BinanceAssetMarket[]>();
  private readonly latestTickers = new Map<string, CachedTickerValue>();
  private readonly listeners = new EventEmitter();
  private socket: { close: (code?: number, reason?: string) => void } | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private socketRevision = 0;

  onModuleDestroy() {
    this.clearReconnectTimer();
    this.closeSocket();
    this.listeners.removeAllListeners();
  }

  registerAssetMarkets(assetId: string, markets: MarketTicker[]) {
    const relevantMarkets = markets
      .filter((row) => row.marketType === 'CEX' && row.instrumentType === 'spot' && row.exchangeCode === 'binance')
      .map((row) => ({
        marketId: row.marketId,
        symbol: this.toBinanceSymbol(row),
      }))
      .filter((row) => row.symbol.length > 0);

    if (relevantMarkets.length === 0) {
      this.unregisterAssetMarkets(assetId);
      return;
    }

    this.assetMarkets.set(assetId, relevantMarkets);
    this.reconnectSocket();
  }

  unregisterAssetMarkets(assetId: string) {
    if (!this.assetMarkets.delete(assetId)) {
      return;
    }

    this.pruneUnusedTickers();

    if (this.assetMarkets.size === 0) {
      this.clearReconnectTimer();
      this.closeSocket();
      return;
    }

    this.reconnectSocket();
  }

  getTickerForMarket(row: MarketTicker): DirectTickerValue | null {
    if (row.marketType !== 'CEX' || row.instrumentType !== 'spot' || row.exchangeCode !== 'binance') {
      return null;
    }

    const cached = this.latestTickers.get(this.toBinanceSymbol(row));
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.receivedAtMs > this.cacheTtlMs) {
      this.latestTickers.delete(this.toBinanceSymbol(row));
      return null;
    }

    const { receivedAtMs: _receivedAtMs, ...ticker } = cached;
    return ticker;
  }

  onTickerUpdate(listener: (event: BinanceTickerUpdateEvent) => void) {
    this.listeners.on('ticker', listener);
    return () => {
      this.listeners.off('ticker', listener);
    };
  }

  private reconnectSocket() {
    this.clearReconnectTimer();
    this.closeSocket();

    const streamNames = this.getStreamNames();
    if (streamNames.length === 0) {
      return;
    }

    this.socketRevision += 1;
    const currentRevision = this.socketRevision;
    const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket?: new (url: string) => any }).WebSocket;

    if (!WebSocketCtor) {
      return;
    }

    const socket = new WebSocketCtor(`${this.baseWsUrl}${streamNames.join('/')}`);
    this.socket = socket;

    socket.addEventListener('message', (event: { data?: unknown }) => {
      if (currentRevision !== this.socketRevision) {
        return;
      }
      this.handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      if (currentRevision !== this.socketRevision) {
        return;
      }
      this.socket = null;
      if (this.assetMarkets.size > 0) {
        this.reconnectTimer = setTimeout(() => this.reconnectSocket(), this.reconnectDelayMs);
      }
    });

    socket.addEventListener('error', () => {
      if (currentRevision !== this.socketRevision) {
        return;
      }
      try {
        socket.close();
      } catch {
        // ignore close failures
      }
    });
  }

  private handleMessage(rawData: unknown) {
    if (typeof rawData !== 'string') {
      return;
    }

    try {
      const payload = JSON.parse(rawData) as { stream?: string; data?: BinanceTickerMessage };
      const symbol = payload.data?.s?.toUpperCase();
      if (!symbol) {
        return;
      }

      const ticker: CachedTickerValue = {
        lastPrice: this.toFiniteNumber(payload.data?.c),
        volume24hUsd: this.toFiniteNumber(payload.data?.q),
        lastTradedAt: this.toIsoString(payload.data?.E),
        source: 'binance',
        receivedAtMs: Date.now(),
      };

      this.latestTickers.set(symbol, ticker);
      this.emitTicker(symbol, ticker);
    } catch {
      // ignore malformed payloads
    }
  }

  private emitTicker(symbol: string, ticker: DirectTickerValue) {
    for (const [assetId, markets] of this.assetMarkets.entries()) {
      for (const market of markets) {
        if (market.symbol !== symbol) {
          continue;
        }

        this.listeners.emit('ticker', {
          assetId,
          marketId: market.marketId,
          ticker,
        } satisfies BinanceTickerUpdateEvent);
      }
    }
  }

  private getStreamNames() {
    return [...new Set(
      [...this.assetMarkets.values()]
        .flat()
        .map((market) => market.symbol.toLowerCase())
        .filter(Boolean)
        .map((symbol) => `${symbol}@ticker`),
    )].sort();
  }

  private toBinanceSymbol(row: Pick<MarketTicker, 'baseAsset' | 'quoteAsset'>) {
    return `${row.baseAsset}${row.quoteAsset}`.toUpperCase();
  }

  private pruneUnusedTickers() {
    const activeSymbols = new Set(
      [...this.assetMarkets.values()]
        .flat()
        .map((market) => market.symbol),
    );

    for (const symbol of this.latestTickers.keys()) {
      if (!activeSymbols.has(symbol)) {
        this.latestTickers.delete(symbol);
      }
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

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeSocket() {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.close(1000, 'reconnect');
    } catch {
      // ignore close failures
    }

    this.socket = null;
  }
}
