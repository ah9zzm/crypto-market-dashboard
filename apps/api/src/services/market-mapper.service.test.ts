import { describe, expect, it, vi } from 'vitest';
import { MarketMapperService } from './market-mapper.service';

const mapper = new MarketMapperService();

describe('MarketMapperService', () => {
  it('prioritizes exact symbol matches and deduplicates assets', () => {
    const results = mapper.mapSearchCoins('btc', [
      { id: 'wrapped-bitcoin', symbol: 'WBTC', name: 'Wrapped Bitcoin', market_cap_rank: 15 },
      { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1 },
      { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1 },
      { id: 'bitcoin-cash', symbol: 'BCH', name: 'Bitcoin Cash', market_cap_rank: 18 },
    ]);

    expect(results[0]?.id).toBe('bitcoin');
    expect(results).toHaveLength(3);
    expect(results.map((item) => item.id)).toContain('wrapped-bitcoin');
    expect(results.map((item) => item.id)).toContain('bitcoin-cash');
  });

  it('maps tickers, classifies dex markets, filters unrelated assets, and sorts by volume descending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T14:00:00.000Z'));

    const payload = mapper.mapMarkets('bitcoin', {
      name: 'Bitcoin',
      symbol: 'btc',
      tickers: [
        {
          coin_id: 'bitcoin',
          base: 'BTC',
          target: 'USDT',
          market: { name: 'Binance', identifier: 'binance' },
          last: 72000,
          converted_volume: { usd: 1000000 },
          trust_score: 'green',
          bid_ask_spread_percentage: 0.1,
          last_traded_at: '2026-04-11T13:59:40.000Z',
          trade_url: 'https://example.com/binance',
        },
        {
          coin_id: 'bitcoin',
          base: 'BTC',
          target: 'USDC',
          market: { name: 'PancakeSwap v3', identifier: 'pancakeswap-v3-bsc' },
          last: 71990,
          converted_volume: { usd: 2000000 },
          trust_score: 'yellow',
          bid_ask_spread_percentage: 0.4,
          last_traded_at: '2026-04-11T13:58:00.000Z',
          trade_url: 'https://example.com/pancake',
        },
        {
          coin_id: 'tether-gold',
          base: 'XAUT',
          target: 'BTC',
          market: { name: 'CoinUp.io', identifier: 'coinup' },
          last: 0.06,
          converted_volume: { usd: 99999999 },
        },
      ],
    });

    expect(payload.asset).toEqual({ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' });
    expect(payload.markets).toHaveLength(2);
    expect(payload.markets[0]?.exchangeCode).toBe('pancakeswap-v3-bsc');
    expect(payload.markets[0]?.marketType).toBe('DEX');
    expect(payload.markets[0]?.instrumentType).toBe('spot');
    expect(payload.markets[0]?.rank).toBe(1);
    expect(payload.markets[0]?.updatedAtLabel).toBe('2분 전');
    expect(payload.markets[1]?.rank).toBe(2);
    expect(payload.markets[1]?.instrumentType).toBe('spot');

    vi.useRealTimers();
  });

  it('classifies derivative markets as futures from ticker metadata', () => {
    const payload = mapper.mapMarkets('bitcoin', {
      name: 'Bitcoin',
      symbol: 'btc',
      tickers: [
        {
          coin_id: 'bitcoin',
          base: 'BTC',
          target: 'PERP',
          market: { name: 'Binance Futures', identifier: 'binance' },
          last: 72000,
          converted_volume: { usd: 3000000 },
          trade_url: 'https://www.binance.com/en/futures/BTCUSDT',
        },
      ],
    });

    expect(payload.markets).toHaveLength(1);
    expect(payload.markets[0]?.instrumentType).toBe('futures');
  });

  it('drops unusable rows, nulls malformed numeric fields, and sanitizes trade URLs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T14:00:00.000Z'));

    const payload = mapper.mapMarkets('test-coin', {
      name: 'Test Coin',
      symbol: 'tst',
      tickers: [
        {
          coin_id: 'test-coin',
          base: 'TST',
          target: 'USDT',
          market: { name: 'Example Exchange', identifier: 'example' },
          last: Number.NaN,
          converted_volume: { usd: Number.NaN },
          bid_ask_spread_percentage: Number.NaN,
          last_traded_at: 'bad-date',
        },
        {
          coin_id: 'test-coin',
          base: 'TST',
          target: 'USD',
          market: { name: 'Example Exchange', identifier: 'example' },
          last: 1.23,
          converted_volume: { usd: Number.NaN },
          bid_ask_spread_percentage: Number.NaN,
          last_traded_at: 'bad-date',
          trade_url: 'javascript:alert(1)',
        },
      ],
    });

    expect(payload.markets).toHaveLength(1);
    expect(payload.markets[0]?.lastPrice).toBe(1.23);
    expect(payload.markets[0]?.volume24hUsd).toBeNull();
    expect(payload.markets[0]?.spreadPct).toBeNull();
    expect(payload.markets[0]?.lastTradedAt).toBeNull();
    expect(payload.markets[0]?.tradeUrl).toBeNull();
    expect(payload.markets[0]?.updatedAtLabel).toBe('업데이트 정보 없음');

    vi.useRealTimers();
  });
});
