export type MarketType = 'CEX' | 'DEX';
export type InstrumentType = 'spot' | 'futures';
export type CacheStatus = 'miss' | 'hit' | 'stale' | 'fallback';
export type TrustScore = 'green' | 'yellow' | 'red' | null;
export type RowSource = 'coingecko' | 'mock' | 'binance' | 'kucoin' | 'gate' | 'mexc' | 'bybit' | 'okx' | 'bingx' | 'bitget';

export interface DataSourceMeta {
  provider: 'coingecko';
  cache: CacheStatus;
  degraded?: boolean;
  fetchedAt: string;
}

export interface AssetSearchItem {
  id: string;
  symbol: string;
  name: string;
  imageUrl?: string;
  marketCapRank?: number | null;
  currentPriceUsd?: number | null;
}

export interface AssetSearchResponse {
  query: string;
  results: AssetSearchItem[];
  source: DataSourceMeta;
}

export interface AssetDescriptor {
  id: string;
  symbol: string;
  name: string;
}

export interface MarketTicker {
  rank: number;
  marketId: string;
  exchangeCode: string;
  exchangeName: string;
  marketType: MarketType;
  instrumentType: InstrumentType;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number | null;
  volume24hUsd: number | null;
  spreadPct: number | null;
  trustScore: TrustScore;
  lastTradedAt: string | null;
  updatedAtLabel: string;
  tradeUrl?: string | null;
  source: RowSource;
}

export interface AssetMarketsResponse {
  asset: AssetDescriptor;
  markets: MarketTicker[];
  source: DataSourceMeta;
}

export interface MarketUpdateChange {
  marketId: string;
  rank?: number;
  lastPrice?: number | null;
  volume24hUsd?: number | null;
  spreadPct?: number | null;
  trustScore?: TrustScore;
  lastTradedAt?: string | null;
  updatedAtLabel?: string;
  source?: RowSource;
}

export interface MarketSnapshotEvent {
  assetId: string;
  version: number;
  emittedAt: string;
  kind: 'snapshot';
  data: AssetMarketsResponse;
}

export interface MarketUpdateEvent {
  assetId: string;
  version: number;
  emittedAt: string;
  kind: 'update';
  source: DataSourceMeta;
  changes: MarketUpdateChange[];
}

export type OhlcvTimeframe = 'tick' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1M';

export interface OhlcvCandle {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
}

export interface MarketOhlcvSeries {
  marketId: string;
  rank: number;
  exchangeName: string;
  symbol: string;
  source: RowSource;
  candles: OhlcvCandle[];
}

export interface AssetOhlcvResponse {
  assetId: string;
  timeframe: OhlcvTimeframe;
  capturedAt: string;
  markets: MarketOhlcvSeries[];
}

export interface FundingRatePoint {
  fundingTime: string;
  fundingRate: number;
}

export interface AssetFundingRateResponse {
  assetId: string;
  symbol: string | null;
  exchangeCode: 'binance';
  exchangeName: 'Binance';
  capturedAt: string;
  currentFundingRate: number | null;
  nextFundingTime: string | null;
  points: FundingRatePoint[];
}
