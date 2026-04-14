import { describe, expect, it, vi } from 'vitest';
import type { MarketTicker } from '@cmd/shared-types';
import { MarketGateway } from './market.gateway';

const row = (source: MarketTicker['source']): MarketTicker => ({
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
  source,
  tradeUrl: 'https://example.com',
});

describe('MarketGateway', () => {
  it('treats row source changes as ticker updates', () => {
    const gateway = new MarketGateway(
      { getMarkets: vi.fn() } as never,
      { onTickerUpdate: vi.fn(() => () => undefined) } as never,
      { recordSnapshot: vi.fn() } as never,
    );

    const previous = new Map([[row('coingecko').marketId, row('coingecko')]]);
    const next = new Map([[row('binance').marketId, row('binance')]]);

    const changes = (gateway as any).diffMarkets(previous, next);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.marketId).toBe(row('binance').marketId);
    expect(changes[0]?.source).toBe('binance');
  });
});
