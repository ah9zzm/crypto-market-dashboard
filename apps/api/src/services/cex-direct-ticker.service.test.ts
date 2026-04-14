import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketTicker } from '@cmd/shared-types';
import { CexDirectTickerService } from './cex-direct-ticker.service';

const binanceLiveTickerService = {
  getTickerForMarket: vi.fn(),
};

const baseMarket: MarketTicker = {
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
  updatedAtLabel: '1분 전',
  source: 'coingecko',
  tradeUrl: 'https://example.com',
};

describe('CexDirectTickerService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('prefers live Binance cache over REST fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T14:00:30.000Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    binanceLiveTickerService.getTickerForMarket.mockReturnValue({
      lastPrice: 101.25,
      volume24hUsd: 5000,
      lastTradedAt: '2026-04-11T14:00:29.000Z',
      source: 'binance',
    });

    const service = new CexDirectTickerService(binanceLiveTickerService as never);
    const [result] = await service.enrichMarkets([baseMarket]);

    expect(result?.lastPrice).toBe(101.25);
    expect(result?.volume24hUsd).toBe(5000);
    expect(result?.source).toBe('binance');
    expect(result?.updatedAtLabel).toBe('방금');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('falls back to REST for non-cached Binance rows', async () => {
    binanceLiveTickerService.getTickerForMarket.mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        lastPrice: '102.50',
        quoteVolume: '9000',
        closeTime: 1_744_381_230_000,
      }),
    } as Response);

    const service = new CexDirectTickerService(binanceLiveTickerService as never);
    const [result] = await service.enrichMarkets([baseMarket]);

    expect(result?.lastPrice).toBe(102.5);
    expect(result?.volume24hUsd).toBe(9000);
    expect(result?.source).toBe('binance');
  });
});
