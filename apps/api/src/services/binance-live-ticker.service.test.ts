import { describe, expect, it, vi } from 'vitest';
import type { MarketTicker } from '@cmd/shared-types';
import { BinanceLiveTickerService } from './binance-live-ticker.service';

const market: MarketTicker = {
  rank: 1,
  marketId: 'bitcoin:binance:BTC:USDT:CEX',
  exchangeCode: 'binance',
  exchangeName: 'Binance',
  marketType: 'CEX',
  instrumentType: 'spot',
  symbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  lastPrice: 100,
  volume24hUsd: 1000,
  spreadPct: 0.1,
  trustScore: 'green',
  lastTradedAt: '2026-04-11T14:00:00.000Z',
  updatedAtLabel: '방금',
  source: 'coingecko',
  tradeUrl: 'https://example.com',
};

describe('BinanceLiveTickerService', () => {
  it('returns null for stale cached tickers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T14:01:00.000Z'));
    const service = new BinanceLiveTickerService();

    (service as any).latestTickers.set('BTCUSDT', {
      lastPrice: 101,
      volume24hUsd: 2000,
      lastTradedAt: '2026-04-11T14:00:00.000Z',
      source: 'binance',
      receivedAtMs: Date.now() - 31_000,
    });

    expect(service.getTickerForMarket(market)).toBeNull();
    expect((service as any).latestTickers.has('BTCUSDT')).toBe(false);
    vi.useRealTimers();
  });

  it('prunes cached symbols when the last asset unsubscribes', () => {
    const service = new BinanceLiveTickerService();

    (service as any).assetMarkets.set('bitcoin', [{ marketId: market.marketId, symbol: 'BTCUSDT' }]);
    (service as any).latestTickers.set('BTCUSDT', {
      lastPrice: 101,
      volume24hUsd: 2000,
      lastTradedAt: '2026-04-11T14:00:00.000Z',
      source: 'binance',
      receivedAtMs: Date.now(),
    });

    service.unregisterAssetMarkets('bitcoin');

    expect((service as any).latestTickers.has('BTCUSDT')).toBe(false);
  });
});
