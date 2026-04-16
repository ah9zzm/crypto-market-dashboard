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

interface BackfillCandle {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
}

const ALL_TIMEFRAMES: readonly OhlcvTimeframe[] = ['tick', '1m', '5m', '15m', '1h', '4h', '1d', '1M'];

const FIXED_TIMEFRAME_MS: Record<Exclude<OhlcvTimeframe, 'tick' | '1M'>, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

const EXCHANGE_PRIORITY = ['binance', 'okx', 'bybit', 'bitget', 'bingx', 'gate'] as const;
const SUPPORTED_BACKFILL_TIMEFRAMES: ReadonlySet<OhlcvTimeframe> = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1M']);

@Injectable()
export class MarketOhlcvService {
  private readonly maxCandles = 240;
  private readonly maxBackfillMarketsPerAsset = 18;
  private readonly backfillCooldownMs = 90_000;
  private readonly backfillTimeoutMs = 8_000;
  private readonly seriesMeta = new Map<string, SeriesMeta>();
  private readonly seriesCandles = new Map<string, MutableOhlcvCandle[]>();
  private readonly latestMarketsByAsset = new Map<string, Map<string, MarketTicker>>();
  private readonly backfillAttemptedAtMs = new Map<string, number>();
  private readonly backfillInFlight = new Map<string, Promise<void>>();

  recordSnapshot(assetId: string, markets: MarketTicker[], capturedAt: string) {
    const normalizedAssetId = assetId.trim().toLowerCase();
    const capturedAtMs = this.toTimestamp(capturedAt);
    this.latestMarketsByAsset.set(normalizedAssetId, new Map(markets.map((market) => [market.marketId, market])));

    for (const market of markets) {
      if (market.lastPrice === null) {
        continue;
      }

      for (const timeframe of ALL_TIMEFRAMES) {
        this.recordCandle(normalizedAssetId, market, timeframe, capturedAtMs);
      }
    }
  }

  async getAssetOhlcv(assetId: string, timeframe: OhlcvTimeframe, limit = 120): Promise<AssetOhlcvResponse> {
    const normalizedAssetId = assetId.trim().toLowerCase();

    if (SUPPORTED_BACKFILL_TIMEFRAMES.has(timeframe)) {
      await this.ensureExchangeBackfill(normalizedAssetId, timeframe, limit);
    }

    return this.buildAssetOhlcvResponse(normalizedAssetId, timeframe, limit);
  }

  private buildAssetOhlcvResponse(assetId: string, timeframe: OhlcvTimeframe, limit: number): AssetOhlcvResponse {
    const markets: MarketOhlcvSeries[] = [];

    for (const [seriesKey, meta] of this.seriesMeta.entries()) {
      if (meta.assetId !== assetId || !seriesKey.endsWith(`:${timeframe}`)) {
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
      assetId,
      timeframe,
      capturedAt: new Date().toISOString(),
      markets,
    };
  }

  private async ensureExchangeBackfill(assetId: string, timeframe: OhlcvTimeframe, limit: number) {
    const backfillKey = `${assetId}:${timeframe}`;
    const existing = this.backfillInFlight.get(backfillKey);
    if (existing) {
      await existing;
      return;
    }

    const task = this.performExchangeBackfill(assetId, timeframe, limit).finally(() => {
      this.backfillInFlight.delete(backfillKey);
    });

    this.backfillInFlight.set(backfillKey, task);
    await task;
  }

  private async performExchangeBackfill(assetId: string, timeframe: OhlcvTimeframe, limit: number) {
    const marketMap = this.latestMarketsByAsset.get(assetId);
    if (!marketMap || marketMap.size === 0) {
      return;
    }

    const minimumCandles = this.minimumCandlesForTimeframe(timeframe, limit);
    const candidates = [...marketMap.values()]
      .filter((market) => this.canBackfillMarket(market))
      .sort((left, right) => this.compareBackfillPriority(left, right))
      .slice(0, this.maxBackfillMarketsPerAsset);

    for (const market of candidates) {
      const seriesKey = this.seriesKey(assetId, market.marketId, timeframe);
      const existingCandles = this.seriesCandles.get(seriesKey) ?? [];
      if (existingCandles.length >= minimumCandles) {
        continue;
      }

      const lastAttemptAt = this.backfillAttemptedAtMs.get(seriesKey) ?? 0;
      if (Date.now() - lastAttemptAt < this.backfillCooldownMs) {
        continue;
      }

      this.backfillAttemptedAtMs.set(seriesKey, Date.now());
      const backfilledCandles = await this.fetchExchangeCandles(market, timeframe, Math.max(limit, minimumCandles));
      if (backfilledCandles.length === 0) {
        continue;
      }

      this.mergeBackfilledCandles(assetId, market, timeframe, backfilledCandles);
    }
  }

  private minimumCandlesForTimeframe(timeframe: OhlcvTimeframe, requestedLimit: number) {
    if (timeframe === '1m') {
      return Math.min(60, Math.max(24, requestedLimit));
    }

    if (timeframe === '5m') {
      return Math.min(48, Math.max(18, requestedLimit));
    }

    if (timeframe === '15m') {
      return Math.min(40, Math.max(16, requestedLimit));
    }

    if (timeframe === '1h') {
      return Math.min(48, Math.max(18, requestedLimit));
    }

    if (timeframe === '4h') {
      return Math.min(42, Math.max(14, requestedLimit));
    }

    if (timeframe === '1d') {
      return Math.min(36, Math.max(12, requestedLimit));
    }

    return Math.min(24, Math.max(8, requestedLimit));
  }

  private canBackfillMarket(market: MarketTicker) {
    if (market.marketType !== 'CEX') {
      return false;
    }

    const exchangeCode = this.normalizeExchangeCode(market.exchangeCode);
    if (market.instrumentType === 'futures') {
      return ['binance', 'okx', 'bybit', 'bitget', 'bingx', 'gate'].includes(exchangeCode);
    }

    return ['binance', 'okx', 'bybit', 'bitget', 'bingx', 'gate'].includes(exchangeCode);
  }

  private compareBackfillPriority(left: MarketTicker, right: MarketTicker) {
    const leftExchange = this.normalizeExchangeCode(left.exchangeCode);
    const rightExchange = this.normalizeExchangeCode(right.exchangeCode);
    const leftPriority = EXCHANGE_PRIORITY.indexOf(leftExchange as (typeof EXCHANGE_PRIORITY)[number]);
    const rightPriority = EXCHANGE_PRIORITY.indexOf(rightExchange as (typeof EXCHANGE_PRIORITY)[number]);

    if (leftPriority !== rightPriority) {
      if (leftPriority === -1) return 1;
      if (rightPriority === -1) return -1;
      return leftPriority - rightPriority;
    }

    if (left.instrumentType !== right.instrumentType) {
      return left.instrumentType === 'spot' ? -1 : 1;
    }

    return left.rank - right.rank;
  }

  private async fetchExchangeCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const exchangeCode = this.normalizeExchangeCode(market.exchangeCode);

    switch (exchangeCode) {
      case 'binance':
        return this.fetchBinanceCandles(market, timeframe, limit);
      case 'okx':
        return this.fetchOkxCandles(market, timeframe, limit);
      case 'bybit':
        return this.fetchBybitCandles(market, timeframe, limit);
      case 'bitget':
        return this.fetchBitgetCandles(market, timeframe, limit);
      case 'bingx':
        return this.fetchBingxCandles(market, timeframe, limit);
      case 'gate':
        return this.fetchGateCandles(market, timeframe, limit);
      default:
        return [];
    }
  }

  private async fetchBinanceCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const interval = this.toBinanceInterval(timeframe);
    if (!interval) {
      return [];
    }

    const symbol = `${market.baseAsset}${market.quoteAsset}`.toUpperCase();
    const endpoint =
      market.instrumentType === 'futures'
        ? 'https://fapi.binance.com/fapi/v1/klines'
        : 'https://api.binance.com/api/v3/klines';

    const payload = await this.fetchJson<unknown[]>(
      `${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${this.normalizeLimit(limit)}`,
    );

    return this.parseArrayBackfillCandles(payload ?? [], timeframe, {
      openTimeIndex: 0,
      openIndex: 1,
      highIndex: 2,
      lowIndex: 3,
      closeIndex: 4,
      closeTimeIndex: 6,
      volumeIndexes: [7, 5],
    });
  }

  private async fetchOkxCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const bar = this.toOkxBar(timeframe);
    if (!bar) {
      return [];
    }

    const instId =
      market.instrumentType === 'futures'
        ? `${market.baseAsset}-${market.quoteAsset}-SWAP`
        : `${market.baseAsset}-${market.quoteAsset}`;

    const payload = await this.fetchJson<{ data?: unknown[] }>(
      `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${this.normalizeLimit(limit)}`,
    );

    return this.parseArrayBackfillCandles(payload?.data ?? [], timeframe, {
      openTimeIndex: 0,
      openIndex: 1,
      highIndex: 2,
      lowIndex: 3,
      closeIndex: 4,
      volumeIndexes: [7, 6, 5],
    });
  }

  private async fetchBybitCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const interval = this.toBybitInterval(timeframe);
    if (!interval) {
      return [];
    }

    const category = market.instrumentType === 'futures' ? 'linear' : 'spot';
    const symbol = `${market.baseAsset}${market.quoteAsset}`.toUpperCase();
    const payload = await this.fetchJson<{ result?: { list?: unknown[] } }>(
      `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${this.normalizeLimit(limit)}`,
    );

    return this.parseArrayBackfillCandles(payload?.result?.list ?? [], timeframe, {
      openTimeIndex: 0,
      openIndex: 1,
      highIndex: 2,
      lowIndex: 3,
      closeIndex: 4,
      volumeIndexes: [6, 5],
    });
  }

  private async fetchBitgetCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const spotGranularity = this.toBitgetSpotGranularity(timeframe);
    const futuresGranularity = this.toBitgetFuturesGranularity(timeframe);
    if (!spotGranularity || !futuresGranularity) {
      return [];
    }

    const symbol = `${market.baseAsset}${market.quoteAsset}`.toUpperCase();
    const url =
      market.instrumentType === 'futures'
        ? `https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${futuresGranularity}&limit=${this.normalizeLimit(limit)}`
        : `https://api.bitget.com/api/v2/spot/market/candles?symbol=${encodeURIComponent(symbol)}&granularity=${spotGranularity}&limit=${this.normalizeLimit(limit)}`;

    const payload = await this.fetchJson<{ data?: unknown[] }>(url);
    return this.parseArrayBackfillCandles(payload?.data ?? [], timeframe, {
      openTimeIndex: 0,
      openIndex: 1,
      highIndex: 2,
      lowIndex: 3,
      closeIndex: 4,
      volumeIndexes: [7, 6, 5],
    });
  }

  private async fetchBingxCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const interval = this.toBingxInterval(timeframe);
    if (!interval) {
      if (timeframe === '1M') {
        const dailyCandles = await this.fetchBingxCandles(market, '1d', Math.min(this.normalizeLimit(limit) * 31, this.maxCandles));
        return this.aggregateCandlesToTimeframe(dailyCandles, '1M');
      }

      return [];
    }

    const symbol = `${market.baseAsset}-${market.quoteAsset}`.toUpperCase();
    const endpoint =
      market.instrumentType === 'futures'
        ? 'https://open-api.bingx.com/openApi/swap/v2/quote/klines'
        : 'https://open-api.bingx.com/openApi/spot/v1/market/kline';

    const payload = await this.fetchJson<{ data?: unknown[] }>(
      `${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${this.normalizeLimit(limit)}`,
    );

    return this.parseBingxCandles(payload?.data ?? [], timeframe);
  }

  private async fetchGateCandles(market: MarketTicker, timeframe: OhlcvTimeframe, limit: number): Promise<BackfillCandle[]> {
    const spotInterval = this.toGateSpotInterval(timeframe);
    const futuresInterval = this.toGateFuturesInterval(timeframe);
    const pair = `${market.baseAsset}_${market.quoteAsset}`.toUpperCase();

    if (market.instrumentType === 'futures') {
      if (!futuresInterval) {
        if (timeframe === '1M') {
          const dailyCandles = await this.fetchGateCandles(market, '1d', Math.min(this.normalizeLimit(limit) * 31, this.maxCandles));
          return this.aggregateCandlesToTimeframe(dailyCandles, '1M');
        }

        return [];
      }

      const payload = await this.fetchJson<unknown[]>(
        `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(pair)}&interval=${futuresInterval}&limit=${this.normalizeLimit(limit)}`,
      );

      return this.parseObjectBackfillCandles(payload ?? [], timeframe, {
        openTimeKey: 't',
        openKey: 'o',
        highKey: 'h',
        lowKey: 'l',
        closeKey: 'c',
        volumeKeys: ['v'],
      });
    }

    if (!spotInterval) {
      if (timeframe === '1M') {
        const dailyCandles = await this.fetchGateCandles(market, '1d', Math.min(this.normalizeLimit(limit) * 31, this.maxCandles));
        return this.aggregateCandlesToTimeframe(dailyCandles, '1M');
      }

      return [];
    }

    const payload = await this.fetchJson<unknown[]>(
      `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${spotInterval}&limit=${this.normalizeLimit(limit)}`,
    );

    return this.parseArrayBackfillCandles(payload ?? [], timeframe, {
      openTimeIndex: 0,
      openIndex: 5,
      highIndex: 3,
      lowIndex: 4,
      closeIndex: 2,
      volumeIndexes: [6, 1],
    });
  }

  private parseBingxCandles(rows: unknown[], timeframe: OhlcvTimeframe): BackfillCandle[] {
    if (!Array.isArray(rows)) {
      return [];
    }

    const candles: BackfillCandle[] = [];

    for (const row of rows) {
      if (Array.isArray(row)) {
        const openTimeMs = this.toTimestampMs(row[0]);
        const open = this.toFiniteNumber(row[1]);
        const high = this.toFiniteNumber(row[2]);
        const low = this.toFiniteNumber(row[3]);
        const close = this.toFiniteNumber(row[4]);
        const volumeUsd = this.toFirstFiniteNumber([row[7], row[6], row[5]]);

        if (openTimeMs === null || open === null || high === null || low === null || close === null) {
          continue;
        }

        const bucketStartMs = this.getBucketStartMs(timeframe, openTimeMs);

        candles.push({
          openTimeMs,
          closeTimeMs: this.getBucketCloseMs(timeframe, bucketStartMs),
          open,
          high,
          low,
          close,
          volumeUsd,
        });
        continue;
      }

      if (!row || typeof row !== 'object') {
        continue;
      }

      const entry = row as Record<string, unknown>;
      const openTimeMs = this.toTimestampMs(entry.time ?? entry.openTime ?? entry.timestamp);
      const open = this.toFiniteNumber(entry.open);
      const high = this.toFiniteNumber(entry.high);
      const low = this.toFiniteNumber(entry.low);
      const close = this.toFiniteNumber(entry.close);
      const volumeUsd = this.toFirstFiniteNumber([entry.quoteVolume, entry.amount, entry.volume]);

      if (openTimeMs === null || open === null || high === null || low === null || close === null) {
        continue;
      }

      const bucketStartMs = this.getBucketStartMs(timeframe, openTimeMs);

      candles.push({
        openTimeMs,
        closeTimeMs: this.getBucketCloseMs(timeframe, bucketStartMs),
        open,
        high,
        low,
        close,
        volumeUsd,
      });
    }

    return candles.sort((left, right) => left.openTimeMs - right.openTimeMs);
  }

  private parseArrayBackfillCandles(
    rows: unknown[],
    timeframe: OhlcvTimeframe,
    indexes: {
      openTimeIndex: number;
      openIndex: number;
      highIndex: number;
      lowIndex: number;
      closeIndex: number;
      closeTimeIndex?: number;
      volumeIndexes: number[];
    },
  ): BackfillCandle[] {
    if (!Array.isArray(rows)) {
      return [];
    }

    const candles: BackfillCandle[] = [];

    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }

      const openTimeMs = this.toTimestampMs(row[indexes.openTimeIndex]);
      const open = this.toFiniteNumber(row[indexes.openIndex]);
      const high = this.toFiniteNumber(row[indexes.highIndex]);
      const low = this.toFiniteNumber(row[indexes.lowIndex]);
      const close = this.toFiniteNumber(row[indexes.closeIndex]);
      const bucketStartMs = openTimeMs === null ? null : this.getBucketStartMs(timeframe, openTimeMs);
      const closeTimeMs =
        this.toTimestampMs(indexes.closeTimeIndex === undefined ? null : row[indexes.closeTimeIndex]) ??
        (bucketStartMs === null ? null : this.getBucketCloseMs(timeframe, bucketStartMs));
      const volumeUsd = this.toFirstFiniteNumber(indexes.volumeIndexes.map((index) => row[index]));

      if (openTimeMs === null || closeTimeMs === null || open === null || high === null || low === null || close === null) {
        continue;
      }

      candles.push({
        openTimeMs,
        closeTimeMs,
        open,
        high,
        low,
        close,
        volumeUsd,
      });
    }

    return candles.sort((left, right) => left.openTimeMs - right.openTimeMs);
  }

  private parseObjectBackfillCandles(
    rows: unknown[],
    timeframe: OhlcvTimeframe,
    keys: {
      openTimeKey: string;
      openKey: string;
      highKey: string;
      lowKey: string;
      closeKey: string;
      closeTimeKey?: string;
      volumeKeys: string[];
    },
  ): BackfillCandle[] {
    if (!Array.isArray(rows)) {
      return [];
    }

    const candles: BackfillCandle[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        continue;
      }

      const entry = row as Record<string, unknown>;
      const openTimeMs = this.toTimestampMs(entry[keys.openTimeKey]);
      const open = this.toFiniteNumber(entry[keys.openKey]);
      const high = this.toFiniteNumber(entry[keys.highKey]);
      const low = this.toFiniteNumber(entry[keys.lowKey]);
      const close = this.toFiniteNumber(entry[keys.closeKey]);
      const bucketStartMs = openTimeMs === null ? null : this.getBucketStartMs(timeframe, openTimeMs);
      const closeTimeMs =
        this.toTimestampMs(keys.closeTimeKey ? entry[keys.closeTimeKey] : null) ??
        (bucketStartMs === null ? null : this.getBucketCloseMs(timeframe, bucketStartMs));
      const volumeUsd = this.toFirstFiniteNumber(keys.volumeKeys.map((key) => entry[key]));

      if (openTimeMs === null || closeTimeMs === null || open === null || high === null || low === null || close === null) {
        continue;
      }

      candles.push({
        openTimeMs,
        closeTimeMs,
        open,
        high,
        low,
        close,
        volumeUsd,
      });
    }

    return candles.sort((left, right) => left.openTimeMs - right.openTimeMs);
  }

  private mergeBackfilledCandles(assetId: string, market: MarketTicker, timeframe: OhlcvTimeframe, backfilled: BackfillCandle[]) {
    const seriesKey = this.seriesKey(assetId, market.marketId, timeframe);
    const current = this.seriesCandles.get(seriesKey) ?? [];
    const byBucket = new Map<number, MutableOhlcvCandle>(current.map((candle) => [candle.bucketStartMs, { ...candle }]));

    for (const candle of backfilled) {
      const bucketStartMs = this.getBucketStartMs(timeframe, candle.openTimeMs);
      const bucketCloseMs = this.getBucketCloseMs(timeframe, bucketStartMs);
      const existing = byBucket.get(bucketStartMs);

      if (existing) {
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
        existing.closeTime = new Date(bucketCloseMs).toISOString();
        existing.volumeUsd = candle.volumeUsd ?? existing.volumeUsd;
        continue;
      }

      byBucket.set(bucketStartMs, {
        bucketStartMs,
        openTime: new Date(bucketStartMs).toISOString(),
        closeTime: new Date(bucketCloseMs).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volumeUsd: candle.volumeUsd,
      });
    }

    this.seriesMeta.set(seriesKey, {
      assetId,
      marketId: market.marketId,
      rank: market.rank,
      exchangeName: market.exchangeName,
      symbol: market.symbol,
      source: market.source,
    });

    const merged = [...byBucket.values()]
      .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
      .slice(-this.maxCandles);
    this.seriesCandles.set(seriesKey, merged);
  }

  private aggregateCandlesToTimeframe(candles: BackfillCandle[], timeframe: Exclude<OhlcvTimeframe, 'tick'>) {
    const byBucket = new Map<number, BackfillCandle>();

    for (const candle of [...candles].sort((left, right) => left.openTimeMs - right.openTimeMs)) {
      const bucketStartMs = this.getBucketStartMs(timeframe, candle.openTimeMs);
      const bucketCloseMs = this.getBucketCloseMs(timeframe, bucketStartMs);
      const existing = byBucket.get(bucketStartMs);

      if (existing) {
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
        existing.closeTimeMs = bucketCloseMs;
        existing.volumeUsd = candle.volumeUsd === null || existing.volumeUsd === null ? existing.volumeUsd ?? candle.volumeUsd : existing.volumeUsd + candle.volumeUsd;
        continue;
      }

      byBucket.set(bucketStartMs, {
        openTimeMs: bucketStartMs,
        closeTimeMs: bucketCloseMs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volumeUsd: candle.volumeUsd,
      });
    }

    return [...byBucket.values()].sort((left, right) => left.openTimeMs - right.openTimeMs);
  }

  private recordCandle(assetId: string, market: MarketTicker, timeframe: OhlcvTimeframe, capturedAtMs: number) {
    const bucketStartMs = this.getBucketStartMs(timeframe, capturedAtMs);
    const bucketCloseMs = this.getBucketCloseMs(timeframe, bucketStartMs);
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

  private getBucketStartMs(timeframe: OhlcvTimeframe, timestampMs: number) {
    if (timeframe === 'tick') {
      return timestampMs;
    }

    if (timeframe === '1M') {
      const date = new Date(timestampMs);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }

    const bucketMs = FIXED_TIMEFRAME_MS[timeframe];
    return Math.floor(timestampMs / bucketMs) * bucketMs;
  }

  private getBucketCloseMs(timeframe: OhlcvTimeframe, bucketStartMs: number) {
    if (timeframe === 'tick') {
      return bucketStartMs;
    }

    if (timeframe === '1M') {
      const date = new Date(bucketStartMs);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
    }

    return bucketStartMs + FIXED_TIMEFRAME_MS[timeframe] - 1;
  }

  private normalizeExchangeCode(exchangeCode: string) {
    const normalized = exchangeCode.trim().toLowerCase();

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

    if (normalized.startsWith('binance')) {
      return 'binance';
    }

    if (normalized.startsWith('gate')) {
      return 'gate';
    }

    return normalized;
  }

  private toBinanceInterval(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1h';
      case '4h':
        return '4h';
      case '1d':
        return '1d';
      case '1M':
        return '1M';
      default:
        return null;
    }
  }

  private toOkxBar(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1H';
      case '4h':
        return '4H';
      case '1d':
        return '1Dutc';
      case '1M':
        return '1Mutc';
      default:
        return null;
    }
  }

  private toBybitInterval(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1';
      case '5m':
        return '5';
      case '15m':
        return '15';
      case '1h':
        return '60';
      case '4h':
        return '240';
      case '1d':
        return 'D';
      case '1M':
        return 'M';
      default:
        return null;
    }
  }

  private toBitgetSpotGranularity(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1min';
      case '5m':
        return '5min';
      case '15m':
        return '15min';
      case '1h':
        return '1h';
      case '4h':
        return '4h';
      case '1d':
        return '1Dutc';
      case '1M':
        return '1Mutc';
      default:
        return null;
    }
  }

  private toBitgetFuturesGranularity(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1H';
      case '4h':
        return '4H';
      case '1d':
        return '1Dutc';
      case '1M':
        return '1Mutc';
      default:
        return null;
    }
  }

  private toBingxInterval(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1h';
      case '4h':
        return '4h';
      case '1d':
        return '1d';
      default:
        return null;
    }
  }

  private toGateSpotInterval(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1h';
      case '4h':
        return '4h';
      case '1d':
        return '1d';
      default:
        return null;
    }
  }

  private toGateFuturesInterval(timeframe: OhlcvTimeframe) {
    switch (timeframe) {
      case '1m':
        return '1m';
      case '5m':
        return '5m';
      case '15m':
        return '15m';
      case '1h':
        return '1h';
      case '4h':
        return '4h';
      case '1d':
        return '1d';
      default:
        return null;
    }
  }

  private normalizeLimit(limit: number) {
    return Math.min(this.maxCandles, Math.max(16, Math.floor(limit)));
  }

  private seriesKey(assetId: string, marketId: string, timeframe: OhlcvTimeframe) {
    return `${assetId}:${marketId}:${timeframe}`;
  }

  private toTimestamp(value: string) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.backfillTimeoutMs);

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

  private toFirstFiniteNumber(values: unknown[]): number | null {
    for (const value of values) {
      const converted = this.toFiniteNumber(value);
      if (converted !== null) {
        return converted;
      }
    }

    return null;
  }

  private toTimestampMs(value: unknown): number | null {
    const numeric = this.toFiniteNumber(value);
    if (numeric === null) {
      return null;
    }

    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return Number.isFinite(millis) ? millis : null;
  }
}
