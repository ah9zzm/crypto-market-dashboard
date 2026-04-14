import { Injectable } from '@nestjs/common';
import type { AssetOhlcvResponse, MarketOhlcvSeries, MarketTicker, OhlcvCandle, OhlcvTimeframe } from '@cmd/shared-types';

interface MutableOhlcvCandle extends OhlcvCandle {
  bucketStartMs: number;
}

interface SeriesMeta {
  assetId: string;
  marketId: string;
  rank: number;
  exchangeName: string;
  symbol: string;
  source: MarketTicker['source'];
}

const TIMEFRAME_MS: Record<OhlcvTimeframe, number> = {
  tick: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
};

@Injectable()
export class MarketOhlcvService {
  private readonly maxCandles = 240;
  private readonly seriesMeta = new Map<string, SeriesMeta>();
  private readonly seriesCandles = new Map<string, MutableOhlcvCandle[]>();

  recordSnapshot(assetId: string, markets: MarketTicker[], capturedAt: string) {
    const capturedAtMs = this.toTimestamp(capturedAt);

    for (const market of markets) {
      if (market.lastPrice === null) {
        continue;
      }

      for (const timeframe of Object.keys(TIMEFRAME_MS) as OhlcvTimeframe[]) {
        this.recordCandle(assetId, market, timeframe, capturedAtMs);
      }
    }
  }

  getAssetOhlcv(assetId: string, timeframe: OhlcvTimeframe, limit = 120): AssetOhlcvResponse {
    const normalizedAssetId = assetId.trim().toLowerCase();
    const markets: MarketOhlcvSeries[] = [];

    for (const [seriesKey, meta] of this.seriesMeta.entries()) {
      if (meta.assetId !== normalizedAssetId || !seriesKey.endsWith(`:${timeframe}`)) {
        continue;
      }

      const candles = (this.seriesCandles.get(seriesKey) ?? [])
        .slice(-limit)
        .map(({ bucketStartMs: _bucketStartMs, ...candle }) => candle);

      if (candles.length === 0) {
        continue;
      }

      markets.push({
        marketId: meta.marketId,
        rank: meta.rank,
        exchangeName: meta.exchangeName,
        symbol: meta.symbol,
        source: meta.source,
        candles,
      });
    }

    markets.sort((left, right) => left.rank - right.rank);

    return {
      assetId: normalizedAssetId,
      timeframe,
      capturedAt: new Date().toISOString(),
      markets,
    };
  }

  private recordCandle(assetId: string, market: MarketTicker, timeframe: OhlcvTimeframe, capturedAtMs: number) {
    const bucketMs = TIMEFRAME_MS[timeframe];
    const bucketStartMs = timeframe === 'tick' ? capturedAtMs : Math.floor(capturedAtMs / bucketMs) * bucketMs;
    const bucketCloseMs = timeframe === 'tick' ? capturedAtMs : bucketStartMs + bucketMs - 1;
    const seriesKey = this.seriesKey(assetId, market.marketId, timeframe);

    this.seriesMeta.set(seriesKey, {
      assetId,
      marketId: market.marketId,
      rank: market.rank,
      exchangeName: market.exchangeName,
      symbol: market.symbol,
      source: market.source,
    });

    const candles = this.seriesCandles.get(seriesKey) ?? [];
    const lastCandle = candles.at(-1);
    const price = market.lastPrice ?? 0;

    if (timeframe !== 'tick' && lastCandle && lastCandle.bucketStartMs === bucketStartMs) {
      lastCandle.high = Math.max(lastCandle.high, price);
      lastCandle.low = Math.min(lastCandle.low, price);
      lastCandle.close = price;
      lastCandle.closeTime = new Date(bucketCloseMs).toISOString();
      lastCandle.volumeUsd = market.volume24hUsd;
      return;
    }

    candles.push({
      bucketStartMs,
      openTime: new Date(bucketStartMs).toISOString(),
      closeTime: new Date(bucketCloseMs).toISOString(),
      open: price,
      high: price,
      low: price,
      close: price,
      volumeUsd: market.volume24hUsd,
    });

    this.seriesCandles.set(seriesKey, candles.slice(-this.maxCandles));
  }

  private seriesKey(assetId: string, marketId: string, timeframe: OhlcvTimeframe) {
    return `${assetId}:${marketId}:${timeframe}`;
  }

  private toTimestamp(value: string) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}
