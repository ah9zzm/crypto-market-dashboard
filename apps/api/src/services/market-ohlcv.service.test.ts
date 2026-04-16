import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketTicker } from '@cmd/shared-types';
import { MarketOhlcvService } from './market-ohlcv.service';

const market = (price: number, timestamp: string): MarketTicker => ({
  rank: 1,
  marketId: 'bitcoin:binance:BTC:USDT:CEX',
  exchangeCode: 'binance',
  exchangeName: 'Binance',
  marketType: 'CEX',
  instrumentType: 'spot',
  symbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  lastPrice: price,
  volume24hUsd: 1000,
  spreadPct: 0.1,
  trustScore: 'green',
  lastTradedAt: timestamp,
  updatedAtLabel: '방금',
  source: 'binance',
  tradeUrl: 'https://example.com',
});

describe('MarketOhlcvService', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates prices into timeframe candles', async () => {
    const service = new MarketOhlcvService();

    service.recordSnapshot('bitcoin', [market(100, '2026-04-11T14:00:10.000Z')], '2026-04-11T14:00:10.000Z');
    service.recordSnapshot('bitcoin', [market(110, '2026-04-11T14:00:40.000Z')], '2026-04-11T14:00:40.000Z');
    service.recordSnapshot('bitcoin', [market(105, '2026-04-11T14:01:05.000Z')], '2026-04-11T14:01:05.000Z');

    const tick = await service.getAssetOhlcv('bitcoin', 'tick', 10);
    const oneMinute = await service.getAssetOhlcv('bitcoin', '1m', 10);
    const fiveMinute = await service.getAssetOhlcv('bitcoin', '5m', 10);

    expect(tick.markets).toHaveLength(1);
    expect(tick.markets[0]?.candles).toHaveLength(3);
    expect(tick.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 100, low: 100, close: 100 });
    expect(tick.markets[0]?.candles[1]).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
    expect(tick.markets[0]?.candles[2]).toMatchObject({ open: 105, high: 105, low: 105, close: 105 });

    expect(oneMinute.markets).toHaveLength(1);
    expect(oneMinute.markets[0]?.candles).toHaveLength(2);
    expect(oneMinute.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 110 });
    expect(oneMinute.markets[0]?.candles[1]).toMatchObject({ open: 105, high: 105, low: 105, close: 105 });

    expect(fiveMinute.markets[0]?.candles).toHaveLength(1);
    expect(fiveMinute.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 105 });
  });

  it('aggregates longer timeframes with calendar month buckets', async () => {
    const service = new MarketOhlcvService();

    service.recordSnapshot('bitcoin', [market(100, '2026-04-11T14:10:00.000Z')], '2026-04-11T14:10:00.000Z');
    service.recordSnapshot('bitcoin', [market(110, '2026-04-11T14:50:00.000Z')], '2026-04-11T14:50:00.000Z');
    service.recordSnapshot('bitcoin', [market(120, '2026-04-12T03:00:00.000Z')], '2026-04-12T03:00:00.000Z');
    service.recordSnapshot('bitcoin', [market(130, '2026-05-02T03:00:00.000Z')], '2026-05-02T03:00:00.000Z');

    const oneHour = await service.getAssetOhlcv('bitcoin', '1h', 10);
    const oneDay = await service.getAssetOhlcv('bitcoin', '1d', 10);
    const oneMonth = await service.getAssetOhlcv('bitcoin', '1M', 10);

    expect(oneHour.markets[0]?.candles).toHaveLength(3);
    expect(oneHour.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 110 });

    expect(oneDay.markets[0]?.candles).toHaveLength(3);
    expect(oneDay.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 110 });
    expect(oneDay.markets[0]?.candles[1]).toMatchObject({ open: 120, high: 120, low: 120, close: 120 });
    expect(oneDay.markets[0]?.candles[2]).toMatchObject({ open: 130, high: 130, low: 130, close: 130 });

    expect(oneMonth.markets[0]?.candles).toHaveLength(2);
    expect(oneMonth.markets[0]?.candles[0]).toMatchObject({ open: 100, high: 120, low: 100, close: 120 });
    expect(oneMonth.markets[0]?.candles[1]).toMatchObject({ open: 130, high: 130, low: 130, close: 130 });
  });
});
