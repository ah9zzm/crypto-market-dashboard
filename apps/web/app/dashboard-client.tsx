'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { FundingRateChart } from './components/funding-rate-chart';
import { TradingViewChart } from './components/tradingview-chart';
import type {
  AssetFundingRateResponse,
  AssetMarketsResponse,
  AssetOhlcvResponse,
  AssetSearchItem,
  AssetSearchResponse,
  InstrumentType,
  MarketSnapshotEvent,
  MarketTicker,
  MarketType,
  MarketUpdateEvent,
  OhlcvTimeframe,
  RowSource,
} from '@cmd/shared-types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const SOCKET_BASE_URL = process.env.NEXT_PUBLIC_SOCKET_BASE_URL ?? 'http://localhost:4000/markets';
const DEFAULT_ASSET_ID = 'bitcoin';
const DEFAULT_ASSET_LABEL = 'Bitcoin';
const CHART_MARKETS_STORAGE_KEY = 'cmd:selected-chart-markets';
const CHART_MARKET_SELECTIONS_STORAGE_KEY = 'cmd:selected-chart-markets-by-asset';
const CHART_MODE_STORAGE_KEY = 'cmd:chart-mode';
const RECENT_SEARCHES_STORAGE_KEY = 'cmd:recent-searches';
const FAVORITE_ASSETS_STORAGE_KEY = 'cmd:favorite-assets';
const MAX_RECENT_SEARCHES = 10;
const FAVORITE_FUNDING_LIMIT = 8;
const FAVORITE_FUNDING_TTL_MS = 10 * 60 * 1000;
const SEARCH_RESULT_SUMMARY_CONCURRENCY = 2;

type FetchState = 'idle' | 'loading' | 'success' | 'error';
type LiveStatus = 'connecting' | 'live' | 'stale' | 'disconnected';
type ChartTimeframe = OhlcvTimeframe;
type ChartMode = 'price' | 'premium';
type ChartSortMode = 'volume' | 'rank' | 'name';

type MarketsState = {
  status: FetchState;
  data: AssetMarketsResponse | null;
  error: string | null;
};

type SearchState = {
  status: FetchState;
  data: AssetSearchResponse | null;
  error: string | null;
};

type OhlcvState = {
  status: FetchState;
  data: AssetOhlcvResponse | null;
  error: string | null;
};

type FundingRateState = {
  status: FetchState;
  data: AssetFundingRateResponse | null;
  error: string | null;
};

type FavoriteFundingSummary = {
  status: FetchState;
  minFundingRate24h: number | null;
  fetchedAt: string | null;
  error: string | null;
};

type SearchResultMarketSummary = {
  status: FetchState;
  marketTypes: MarketType[];
  instrumentTypes: InstrumentType[];
  quotes: string[];
  fetchedAt: string | null;
  error: string | null;
};

type PriceHistoryPoint = {
  timestamp: number;
  price: number;
};

type PriceHistorySeries = {
  marketId: string;
  exchangeCode: string;
  exchangeName: string;
  symbol: string;
  source: RowSource;
  marketType: MarketType;
  instrumentType: InstrumentType;
  points: PriceHistoryPoint[];
};

type ExchangeMarketGroup = {
  exchangeCode: string;
  exchangeName: string;
  marketType: MarketType;
  spot: MarketTicker | null;
  futures: MarketTicker | null;
};

type StoredAssetItem = {
  id: string;
  symbol: string;
  name: string;
};

const HISTORY_LIMIT = 40;
const DEFAULT_CHART_RESET_COUNT = 6;
const DEFAULT_EXCHANGE_LIST_COUNT = 6;
const PRIORITY_EXCHANGE_CODES = ['binance', 'okx', 'bybit', 'bitget', 'bingx', 'gate'];
const PRIORITY_EXCHANGE_LABELS: Record<string, string> = {
  binance: 'Binance',
  okx: 'OKX',
  bybit: 'Bybit',
  bitget: 'Bitget',
  bingx: 'BingX',
  gate: 'Gate',
};
const CHART_PRIORITY_COLORS: Record<string, string> = {
  binance: '#F0B90B',
  okx: '#FFFFFF',
  bybit: '#F97316',
  bitget: '#38BDF8',
  bingx: '#2563EB',
  gate: '#22C55E',
};
const CHART_FALLBACK_COLOR = '#6B7280';
const PREFERRED_SPOT_QUOTES = ['USDT', 'USD', 'USDC', 'FDUSD', 'USD1'];

function formatCurrency(value: number | null, digits = 2) {
  if (value === null) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPrice(value: number | null) {
  if (value === null) {
    return '—';
  }

  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 7;
  return `$${value.toFixed(digits)}`;
}

function formatSignedPercent(value: number | null, digits = 4) {
  if (value === null) {
    return '—';
  }

  const pct = value * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

function getMinFundingRate24h(data: AssetFundingRateResponse | null) {
  if (!data) {
    return null;
  }

  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  let minimumFundingRate: number | null = null;

  for (const point of data.points) {
    const pointTimestamp = new Date(point.fundingTime).getTime();
    if (Number.isNaN(pointTimestamp) || pointTimestamp < cutoffMs) {
      continue;
    }

    if (minimumFundingRate === null || point.fundingRate < minimumFundingRate) {
      minimumFundingRate = point.fundingRate;
    }
  }

  return minimumFundingRate;
}

function summarizeSearchResultMarkets(data: AssetMarketsResponse): SearchResultMarketSummary {
  return {
    status: 'success',
    marketTypes: [...new Set(data.markets.map((market) => market.marketType))],
    instrumentTypes: [...new Set(data.markets.map((market) => market.instrumentType))],
    quotes: [...new Set(data.markets.map((market) => market.quoteAsset))],
    fetchedAt: data.source.fetchedAt,
    error: null,
  };
}

function formatCompactUsd(value: number | null) {
  if (value === null) {
    return '—';
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }

  if (absolute >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }

  if (absolute >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }

  return `$${value.toFixed(0)}`;
}

function calculatePremium(referencePrice: number | null, currentPrice: number | null) {
  if (referencePrice === null || currentPrice === null || referencePrice === 0) {
    return null;
  }

  return ((currentPrice - referencePrice) / referencePrice) * 100;
}

function getMarketPriceExtremes(markets: MarketTicker[]) {
  let lowestMarket: MarketTicker | null = null;
  let highestMarket: MarketTicker | null = null;

  for (const market of markets) {
    if (market.lastPrice === null) {
      continue;
    }

    if (!lowestMarket || market.lastPrice < (lowestMarket.lastPrice ?? Number.POSITIVE_INFINITY)) {
      lowestMarket = market;
    }

    if (!highestMarket || market.lastPrice > (highestMarket.lastPrice ?? Number.NEGATIVE_INFINITY)) {
      highestMarket = market;
    }
  }

  return {
    lowestMarket,
    highestMarket,
    lowestPrice: lowestMarket?.lastPrice ?? null,
    highestPrice: highestMarket?.lastPrice ?? null,
  };
}

function rowSourceLabel(source: RowSource) {
  switch (source) {
    case 'binance':
      return 'Binance Direct';
    case 'kucoin':
      return 'KuCoin Direct';
    case 'gate':
      return 'Gate Direct';
    case 'mexc':
      return 'MEXC Direct';
    case 'bybit':
      return 'Bybit Direct';
    case 'okx':
      return 'OKX Direct';
    case 'bingx':
      return 'BingX Direct';
    case 'bitget':
      return 'Bitget Direct';
    case 'coingecko':
      return 'CoinGecko';
    case 'mock':
      return 'Mock';
    default:
      return source;
  }
}

function compareVolume(left: MarketTicker | null, right: MarketTicker | null) {
  return (right?.volume24hUsd ?? -1) - (left?.volume24hUsd ?? -1);
}

function normalizePriorityExchangeCode(exchangeCode: string) {
  const normalized = exchangeCode.trim().toLowerCase();

  if (normalized.startsWith('bybit')) {
    return 'bybit';
  }

  if (normalized === 'okex' || normalized.startsWith('okx')) {
    return 'okx';
  }

  if (normalized.startsWith('binance')) {
    return 'binance';
  }

  if (normalized.startsWith('bitget')) {
    return 'bitget';
  }

  if (normalized.startsWith('bingx')) {
    return 'bingx';
  }

  if (normalized.startsWith('gate')) {
    return 'gate';
  }

  return normalized;
}

function getChartSeriesColor(exchangeCode: string) {
  const normalized = normalizePriorityExchangeCode(exchangeCode);
  return CHART_PRIORITY_COLORS[normalized] ?? CHART_FALLBACK_COLOR;
}

function compareMarketsBySortMode(left: MarketTicker, right: MarketTicker, sortMode: ChartSortMode) {
  const leftPriority = PRIORITY_EXCHANGE_CODES.indexOf(normalizePriorityExchangeCode(left.exchangeCode));
  const rightPriority = PRIORITY_EXCHANGE_CODES.indexOf(normalizePriorityExchangeCode(right.exchangeCode));

  if (leftPriority !== -1 || rightPriority !== -1) {
    if (leftPriority === -1) {
      return 1;
    }
    if (rightPriority === -1) {
      return -1;
    }
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
  }

  if (sortMode === 'rank') {
    return left.rank - right.rank;
  }

  if (sortMode === 'name') {
    return left.exchangeName.localeCompare(right.exchangeName);
  }

  return compareVolume(left, right);
}

function compareSpotMarketPreference(left: MarketTicker, right: MarketTicker) {
  const leftQuotePriority = PREFERRED_SPOT_QUOTES.indexOf(left.quoteAsset);
  const rightQuotePriority = PREFERRED_SPOT_QUOTES.indexOf(right.quoteAsset);

  if (leftQuotePriority !== -1 || rightQuotePriority !== -1) {
    if (leftQuotePriority === -1) {
      return 1;
    }
    if (rightQuotePriority === -1) {
      return -1;
    }
    if (leftQuotePriority !== rightQuotePriority) {
      return leftQuotePriority - rightQuotePriority;
    }
  }

  return compareVolume(left, right);
}

function compareExchangeGroupsBySortMode(left: ExchangeMarketGroup, right: ExchangeMarketGroup, sortMode: ChartSortMode) {
  const leftPriority = PRIORITY_EXCHANGE_CODES.indexOf(left.exchangeCode);
  const rightPriority = PRIORITY_EXCHANGE_CODES.indexOf(right.exchangeCode);

  if (leftPriority !== -1 || rightPriority !== -1) {
    if (leftPriority === -1) {
      return 1;
    }
    if (rightPriority === -1) {
      return -1;
    }
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
  }

  const leftPrimary = left.spot ?? left.futures;
  const rightPrimary = right.spot ?? right.futures;

  if (!leftPrimary || !rightPrimary) {
    return left.exchangeName.localeCompare(right.exchangeName);
  }

  return compareMarketsBySortMode(leftPrimary, rightPrimary, sortMode);
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    signal,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function patchMarkets(current: AssetMarketsResponse, update: MarketUpdateEvent): AssetMarketsResponse {
  const nextRows = current.markets.map((row) => {
    const change = update.changes.find((entry) => entry.marketId === row.marketId);

    if (!change) {
      return row;
    }

    return {
      ...row,
      rank: change.rank ?? row.rank,
      lastPrice: change.lastPrice ?? row.lastPrice,
      volume24hUsd: change.volume24hUsd ?? row.volume24hUsd,
      spreadPct: change.spreadPct ?? row.spreadPct,
      trustScore: change.trustScore ?? row.trustScore,
      lastTradedAt: change.lastTradedAt ?? row.lastTradedAt,
      updatedAtLabel: change.updatedAtLabel ?? row.updatedAtLabel,
      source: change.source ?? row.source,
    } satisfies MarketTicker;
  });

  nextRows.sort((left, right) => left.rank - right.rank);

  return {
    ...current,
    markets: nextRows,
    source: update.source,
  };
}

function liveStatusLabel(status: LiveStatus) {
  switch (status) {
    case 'connecting':
      return '실시간 연결 중';
    case 'live':
      return '실시간 연결 정상';
    case 'stale':
      return '업데이트 지연';
    case 'disconnected':
      return '실시간 연결 끊김';
    default:
      return status;
  }
}

function buildLinePath(points: PriceHistoryPoint[], minValue: number, maxValue: number, width: number, height: number, padding: number) {
  if (points.length === 0) {
    return '';
  }

  const innerHeight = Math.max(1, height - padding * 2);
  const valueRange = maxValue - minValue || 1;

  return points
    .map((point, index) => {
      const x = getChartXAxisPosition(index, points.length, width, padding);
      const normalizedY = (point.price - minValue) / valueRange;
      const y = height - padding - normalizedY * innerHeight;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function getChartPointCoordinates(point: PriceHistoryPoint, index: number, totalPoints: number, minValue: number, maxValue: number, width: number, height: number, padding: number) {
  const innerHeight = Math.max(1, height - padding * 2);
  const valueRange = maxValue - minValue || 1;
  const x = getChartXAxisPosition(index, totalPoints, width, padding);
  const normalizedY = (point.price - minValue) / valueRange;
  const y = height - padding - normalizedY * innerHeight;

  return { x, y };
}

function formatChartTime(timestamp: number | null) {
  if (!timestamp) {
    return '—';
  }

  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLocalDateTime(value: string | null) {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }

  return parsed.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatChartAxisTime(timestamp: number, timeframe: ChartTimeframe) {
  const date = new Date(timestamp);

  switch (timeframe) {
    case 'tick':
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    case '1m':
    case '5m':
    case '15m':
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    case '1h':
    case '4h':
      return date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    case '1d':
      return date.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
      });
    case '1M':
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
      });
    default:
      return date.toLocaleTimeString();
  }
}

function getOhlcvCacheKey(assetId: string, timeframe: ChartTimeframe) {
  return `${assetId}:${timeframe}`;
}

function getFundingRateCacheKey(assetId: string) {
  return assetId;
}

function getChartXAxisPosition(index: number, totalPoints: number, width: number, padding: number) {
  const innerWidth = Math.max(1, width - padding * 2);
  return padding + (totalPoints <= 1 ? innerWidth / 2 : (index / (totalPoints - 1)) * innerWidth);
}

function buildTimeAxisTicks(points: PriceHistoryPoint[], timeframe: ChartTimeframe, maxTickCount = 4) {
  if (points.length === 0) {
    return [] as Array<{ timestamp: number; label: string; index: number; totalPoints: number }>;
  }

  const desiredTickCount = Math.min(maxTickCount, points.length);
  const tickIndexes = new Set<number>();

  for (let step = 0; step < desiredTickCount; step += 1) {
    const ratio = desiredTickCount === 1 ? 0 : step / (desiredTickCount - 1);
    tickIndexes.add(Math.round(ratio * (points.length - 1)));
  }

  return Array.from(tickIndexes)
    .sort((left, right) => left - right)
    .map((index) => ({
      timestamp: points[index].timestamp,
      label: formatChartAxisTime(points[index].timestamp, timeframe),
      index,
      totalPoints: points.length,
    }));
}

function timeframeLabel(timeframe: ChartTimeframe) {
  switch (timeframe) {
    case 'tick':
      return '틱';
    case '1m':
      return '1분봉';
    case '5m':
      return '5분봉';
    case '15m':
      return '15분봉';
    case '1h':
      return '1시간';
    case '4h':
      return '4시간';
    case '1d':
      return '일봉';
    case '1M':
      return '월봉';
    default:
      return timeframe;
  }
}

function normalizeStoredAssetItem(value: unknown): StoredAssetItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.symbol !== 'string' || typeof candidate.name !== 'string') {
    return null;
  }

  return {
    id: candidate.id,
    symbol: candidate.symbol,
    name: candidate.name,
  };
}

function dedupeStoredAssets(items: StoredAssetItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function normalizeStoredChartSelections(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {} as Record<string, string[]>;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([assetId, marketIds]) => [
    assetId,
    Array.isArray(marketIds) ? marketIds.filter((item): item is string => typeof item === 'string') : [],
  ]);

  return Object.fromEntries(entries) as Record<string, string[]>;
}

function toStoredAssetItem(asset: AssetSearchItem | StoredAssetItem): StoredAssetItem {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
  };
}

export function DashboardClient() {
  const [query, setQuery] = useState('btc');
  const [marketTypeFilter, setMarketTypeFilter] = useState<'ALL' | MarketType>('CEX');
  const [instrumentTypeFilter, setInstrumentTypeFilter] = useState<'ALL' | InstrumentType>('ALL');
  const [quoteFilter, setQuoteFilter] = useState('USDT');
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>('1m');
  const [chartMode, setChartMode] = useState<ChartMode>('price');
  const [chartSortMode, setChartSortMode] = useState<ChartSortMode>('volume');
  const [selectedChartMarketIds, setSelectedChartMarketIds] = useState<string[]>([]);
  const [storedChartSelections, setStoredChartSelections] = useState<Record<string, string[]>>({});
  const [isExchangeListExpanded, setIsExchangeListExpanded] = useState(false);
  const [recentSearches, setRecentSearches] = useState<StoredAssetItem[]>([]);
  const [favoriteAssets, setFavoriteAssets] = useState<StoredAssetItem[]>([]);
  const [draggedFavoriteId, setDraggedFavoriteId] = useState<string | null>(null);
  const [favoriteDropTargetId, setFavoriteDropTargetId] = useState<string | null>(null);
  const [isMarketsExpanded, setIsMarketsExpanded] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AssetSearchItem | null>(null);
  const [searchState, setSearchState] = useState<SearchState>({ status: 'idle', data: null, error: null });
  const [marketsState, setMarketsState] = useState<MarketsState>({ status: 'idle', data: null, error: null });
  const [ohlcvState, setOhlcvState] = useState<OhlcvState>({ status: 'idle', data: null, error: null });
  const [fundingRateState, setFundingRateState] = useState<FundingRateState>({ status: 'idle', data: null, error: null });
  const [favoriteFundingMap, setFavoriteFundingMap] = useState<Record<string, FavoriteFundingSummary>>({});
  const [searchResultMarketMap, setSearchResultMarketMap] = useState<Record<string, SearchResultMarketSummary>>({});
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [lastLiveUpdateAt, setLastLiveUpdateAt] = useState<string | null>(null);
  const marketRequestIdRef = useRef(0);
  const currentMarketsDataRef = useRef<AssetMarketsResponse | null>(null);
  const marketAbortRef = useRef<AbortController | null>(null);
  const ohlcvAbortRef = useRef<AbortController | null>(null);
  const fundingRateAbortRef = useRef<AbortController | null>(null);
  const favoriteFundingAbortRef = useRef<AbortController | null>(null);
  const searchResultMarketAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const subscribedAssetIdRef = useRef<string | null>(null);
  const storedChartSelectionsRef = useRef<Record<string, string[]>>({});
  const ohlcvCacheRef = useRef<Record<string, AssetOhlcvResponse>>({});
  const fundingRateCacheRef = useRef<Record<string, AssetFundingRateResponse>>({});
  const favoriteFundingMapRef = useRef<Record<string, FavoriteFundingSummary>>({});
  const searchResultMarketMapRef = useRef<Record<string, SearchResultMarketSummary>>({});
  const chartSelectionInitializedRef = useRef(false);
  const chartSelectionSuppressedRef = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const storedChartSelections = window.localStorage.getItem(CHART_MARKET_SELECTIONS_STORAGE_KEY);
        if (storedChartSelections) {
          setStoredChartSelections(normalizeStoredChartSelections(JSON.parse(storedChartSelections)));
        } else {
          const storedMarketIds = window.localStorage.getItem(CHART_MARKETS_STORAGE_KEY);
          if (storedMarketIds) {
            const parsed = JSON.parse(storedMarketIds);
            if (Array.isArray(parsed)) {
              const normalized = parsed.filter((value): value is string => typeof value === 'string');
              setSelectedChartMarketIds(normalized);
              chartSelectionInitializedRef.current = true;
              chartSelectionSuppressedRef.current = normalized.length === 0;
            }
          }
        }

        const storedChartMode = window.localStorage.getItem(CHART_MODE_STORAGE_KEY);
        if (storedChartMode === 'price' || storedChartMode === 'premium') {
          setChartMode(storedChartMode);
        }

        const storedRecentSearches = window.localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY);
        if (storedRecentSearches) {
          const parsed = JSON.parse(storedRecentSearches);
          if (Array.isArray(parsed)) {
            setRecentSearches(parsed.map(normalizeStoredAssetItem).filter((item): item is StoredAssetItem => Boolean(item)));
          }
        }

        const storedFavoriteAssets = window.localStorage.getItem(FAVORITE_ASSETS_STORAGE_KEY);
        if (storedFavoriteAssets) {
          const parsed = JSON.parse(storedFavoriteAssets);
          if (Array.isArray(parsed)) {
            setFavoriteAssets(parsed.map(normalizeStoredAssetItem).filter((item): item is StoredAssetItem => Boolean(item)));
          }
        }
      } catch {
        // ignore localStorage parse failures
      }
    }

    void loadMarkets(DEFAULT_ASSET_ID, { id: DEFAULT_ASSET_ID, symbol: 'BTC', name: DEFAULT_ASSET_LABEL });

    return () => {
      marketAbortRef.current?.abort();
      ohlcvAbortRef.current?.abort();
      fundingRateAbortRef.current?.abort();
      favoriteFundingAbortRef.current?.abort();
      searchResultMarketAbortRef.current?.abort();
      searchAbortRef.current?.abort();
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    currentMarketsDataRef.current = marketsState.data;
  }, [marketsState.data]);

  useEffect(() => {
    favoriteFundingMapRef.current = favoriteFundingMap;
  }, [favoriteFundingMap]);

  useEffect(() => {
    searchResultMarketMapRef.current = searchResultMarketMap;
  }, [searchResultMarketMap]);

  useEffect(() => {
    storedChartSelectionsRef.current = storedChartSelections;
  }, [storedChartSelections]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(CHART_MODE_STORAGE_KEY, chartMode);
  }, [chartMode]);

  const activeAssetId = selectedAsset?.id ?? marketsState.data?.asset.id ?? null;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(CHART_MARKET_SELECTIONS_STORAGE_KEY, JSON.stringify(storedChartSelections));
  }, [storedChartSelections]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(recentSearches));
  }, [recentSearches]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(FAVORITE_ASSETS_STORAGE_KEY, JSON.stringify(favoriteAssets));
  }, [favoriteAssets]);

  useEffect(() => {
    const assetId = activeAssetId;
    const assetSymbol = selectedAsset?.id === assetId ? selectedAsset.symbol : (marketsState.data?.asset.id === assetId ? marketsState.data.asset.symbol : undefined);
    const assetName = selectedAsset?.id === assetId ? selectedAsset.name : (marketsState.data?.asset.id === assetId ? marketsState.data.asset.name : undefined);

    if (!assetId) {
      return;
    }

    const socket = io(SOCKET_BASE_URL, {
      transports: ['websocket'],
    });
    socketRef.current = socket;
    setLiveStatus('connecting');

    socket.on('connect', () => {
      setLiveStatus('live');
      subscribedAssetIdRef.current = assetId;
      socket.emit('subscribe_markets', { asset: assetId, symbol: assetSymbol, name: assetName });
    });

    socket.on('disconnect', () => {
      setLiveStatus('disconnected');
      setIsBackgroundRefreshing(false);
    });

    socket.on('ticker_snapshot', (event: MarketSnapshotEvent) => {
      currentMarketsDataRef.current = event.data;
      setMarketsState((current) => ({
        status: 'success',
        data: event.data,
        error: current.error,
      }));
      setLastLiveUpdateAt(event.emittedAt);
      setIsBackgroundRefreshing(false);
      setLiveStatus(event.data.source.degraded ? 'stale' : 'live');
    });

    socket.on('ticker_update', (event: MarketUpdateEvent) => {
      setMarketsState((current) => {
        if (!current.data) {
          return current;
        }

        const nextData = patchMarkets(current.data, event);
        currentMarketsDataRef.current = nextData;

        return {
          status: 'success',
          data: nextData,
          error: current.error,
        };
      });
      setLastLiveUpdateAt(event.emittedAt);
      setIsBackgroundRefreshing(false);
      setLiveStatus(event.source.degraded ? 'stale' : 'live');
    });

    socket.io.on('reconnect_attempt', () => {
      setLiveStatus('connecting');
      setIsBackgroundRefreshing(true);
    });

    return () => {
      if (subscribedAssetIdRef.current) {
        socket.emit('unsubscribe_markets', { asset: subscribedAssetIdRef.current });
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, [activeAssetId, marketsState.data?.asset.id, marketsState.data?.asset.name, marketsState.data?.asset.symbol, selectedAsset?.id, selectedAsset?.name, selectedAsset?.symbol]);

  useEffect(() => {
    const assetId = activeAssetId;
    if (!assetId) {
      return;
    }

    void loadOhlcv(assetId, chartTimeframe);
  }, [activeAssetId, chartTimeframe, lastLiveUpdateAt]);

  useEffect(() => {
    const assetId = activeAssetId;
    const assetSymbol = selectedAsset?.id === assetId ? selectedAsset.symbol : marketsState.data?.asset.id === assetId ? marketsState.data.asset.symbol : undefined;
    const assetName = selectedAsset?.id === assetId ? selectedAsset.name : marketsState.data?.asset.id === assetId ? marketsState.data.asset.name : undefined;

    if (!assetId) {
      return;
    }

    void loadFundingRates(assetId, { symbol: assetSymbol, name: assetName });
  }, [activeAssetId, marketsState.data?.asset.id, marketsState.data?.asset.name, marketsState.data?.asset.symbol, selectedAsset?.id, selectedAsset?.name, selectedAsset?.symbol]);

  useEffect(() => {
    const results = searchState.data?.results ?? [];
    if (results.length === 0) {
      searchResultMarketAbortRef.current?.abort();
      return;
    }

    const assetsToFetch = results.filter((asset) => {
      const summary = searchResultMarketMapRef.current[asset.id];
      return !summary || summary.status !== 'success';
    });

    if (assetsToFetch.length === 0) {
      return;
    }

    searchResultMarketAbortRef.current?.abort();
    const controller = new AbortController();
    searchResultMarketAbortRef.current = controller;

    setSearchResultMarketMap((current) => {
      const next = { ...current };

      for (const asset of assetsToFetch) {
        next[asset.id] = {
          status: 'loading',
          marketTypes: current[asset.id]?.marketTypes ?? [],
          instrumentTypes: current[asset.id]?.instrumentTypes ?? [],
          quotes: current[asset.id]?.quotes ?? [],
          fetchedAt: current[asset.id]?.fetchedAt ?? null,
          error: null,
        };
      }

      return next;
    });

    void (async () => {
      const queue = [...assetsToFetch];
      const fetchedSummaries: Array<{ assetId: string; summary: SearchResultMarketSummary }> = [];

      const worker = async () => {
        while (queue.length > 0) {
          const asset = queue.shift();
          if (!asset) {
            return;
          }

          const params = new URLSearchParams({
            asset: asset.id,
            symbol: asset.symbol,
            name: asset.name,
          });

          try {
            const data = await requestJson<AssetMarketsResponse>(`/markets?${params.toString()}`, controller.signal);
            fetchedSummaries.push({
              assetId: asset.id,
              summary: summarizeSearchResultMarkets(data),
            });
          } catch (error) {
            fetchedSummaries.push({
              assetId: asset.id,
              summary: {
                status: 'error',
                marketTypes: [] as MarketType[],
                instrumentTypes: [] as InstrumentType[],
                quotes: [] as string[],
                fetchedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : '마켓 요약을 불러오지 못했습니다.',
              } satisfies SearchResultMarketSummary,
            });
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(SEARCH_RESULT_SUMMARY_CONCURRENCY, assetsToFetch.length) },
          () => worker(),
        ),
      );

      if (controller.signal.aborted) {
        return;
      }

      setSearchResultMarketMap((current) => {
        const next = { ...current };

        for (const item of fetchedSummaries) {
          next[item.assetId] = item.summary;
        }

        return next;
      });
    })();

    return () => {
      controller.abort();
    };
  }, [searchState.data?.results]);

  useEffect(() => {
    if (!activeAssetId || !fundingRateState.data || !favoriteAssets.some((asset) => asset.id === activeAssetId)) {
      return;
    }

    const minFundingRate24h = getMinFundingRate24h(fundingRateState.data);
    setFavoriteFundingMap((current) => ({
      ...current,
      [activeAssetId]: {
        status: 'success',
        minFundingRate24h,
        fetchedAt: fundingRateState.data?.capturedAt ?? new Date().toISOString(),
        error: null,
      },
    }));
  }, [activeAssetId, favoriteAssets, fundingRateState.data]);

  useEffect(() => {
    if (favoriteAssets.length === 0) {
      favoriteFundingAbortRef.current?.abort();
      return;
    }

    const now = Date.now();
    const cachedSummaries: Array<{ assetId: string; summary: FavoriteFundingSummary }> = [];
    const assetsToFetch: StoredAssetItem[] = [];

    for (const asset of favoriteAssets) {
      const cachedFunding = fundingRateCacheRef.current[asset.id];
      const cachedFundingAgeMs = cachedFunding ? now - new Date(cachedFunding.capturedAt).getTime() : Number.POSITIVE_INFINITY;

      if (cachedFunding && Number.isFinite(cachedFundingAgeMs) && cachedFundingAgeMs <= FAVORITE_FUNDING_TTL_MS) {
        cachedSummaries.push({
          assetId: asset.id,
          summary: {
            status: 'success',
            minFundingRate24h: getMinFundingRate24h(cachedFunding),
            fetchedAt: cachedFunding.capturedAt,
            error: null,
          },
        });
        continue;
      }

      const currentSummary = favoriteFundingMapRef.current[asset.id];
      const summaryAgeMs = currentSummary?.fetchedAt ? now - new Date(currentSummary.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
      const isFreshSummary = currentSummary?.fetchedAt && Number.isFinite(summaryAgeMs) && summaryAgeMs <= FAVORITE_FUNDING_TTL_MS;

      if (!isFreshSummary) {
        assetsToFetch.push(asset);
      }
    }

    if (cachedSummaries.length > 0) {
      setFavoriteFundingMap((current) => {
        const next = { ...current };
        for (const entry of cachedSummaries) {
          next[entry.assetId] = entry.summary;
        }
        return next;
      });
    }

    if (assetsToFetch.length === 0) {
      return;
    }

    favoriteFundingAbortRef.current?.abort();
    const controller = new AbortController();
    favoriteFundingAbortRef.current = controller;

    setFavoriteFundingMap((current) => {
      const next = { ...current };

      for (const asset of assetsToFetch) {
        const previous = current[asset.id];
        next[asset.id] = {
          status: 'loading',
          minFundingRate24h: previous?.minFundingRate24h ?? null,
          fetchedAt: previous?.fetchedAt ?? null,
          error: null,
        };
      }

      return next;
    });

    void (async () => {
      const results = await Promise.all(
        assetsToFetch.map(async (asset) => {
          const params = new URLSearchParams({
            asset: asset.id,
            symbol: asset.symbol,
            name: asset.name,
            limit: String(FAVORITE_FUNDING_LIMIT),
          });

          try {
            const data = await requestJson<AssetFundingRateResponse>(`/markets/funding?${params.toString()}`, controller.signal);
            return {
              assetId: asset.id,
              data,
              error: null,
            };
          } catch (error) {
            return {
              assetId: asset.id,
              data: null,
              error: error instanceof Error ? error.message : '펀딩비 데이터를 불러오지 못했습니다.',
            };
          }
        }),
      );

      if (controller.signal.aborted) {
        return;
      }

      setFavoriteFundingMap((current) => {
        const next = { ...current };

        for (const result of results) {
          if (result.data) {
            fundingRateCacheRef.current[result.assetId] = result.data;
            next[result.assetId] = {
              status: 'success',
              minFundingRate24h: getMinFundingRate24h(result.data),
              fetchedAt: result.data.capturedAt,
              error: null,
            };
            continue;
          }

          next[result.assetId] = {
            status: 'error',
            minFundingRate24h: current[result.assetId]?.minFundingRate24h ?? null,
            fetchedAt: current[result.assetId]?.fetchedAt ?? new Date().toISOString(),
            error: result.error,
          };
        }

        return next;
      });
    })();

    return () => {
      controller.abort();
    };
  }, [favoriteAssets]);

  async function loadOhlcv(assetId: string, timeframe: ChartTimeframe) {
    ohlcvAbortRef.current?.abort();
    const controller = new AbortController();
    ohlcvAbortRef.current = controller;
    const cacheKey = getOhlcvCacheKey(assetId, timeframe);
    const cached = ohlcvCacheRef.current[cacheKey] ?? null;

    setOhlcvState((current) => {
      const preservedData = current.data?.assetId === assetId ? current.data : null;

      return {
        status: cached || preservedData ? 'success' : 'loading',
        data: cached ?? preservedData,
        error: null,
      };
    });

    try {
      const data = await requestJson<AssetOhlcvResponse>(
        `/markets/ohlcv?asset=${encodeURIComponent(assetId)}&timeframe=${encodeURIComponent(timeframe)}&limit=120`,
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      ohlcvCacheRef.current[cacheKey] = data;
      setOhlcvState({ status: 'success', data, error: null });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setOhlcvState((current) => ({
        status: current.data ? 'success' : 'error',
        data: current.data,
        error: error instanceof Error ? error.message : 'OHLCV 데이터를 불러오지 못했습니다.',
      }));
    }
  }

  async function loadFundingRates(assetId: string, assetMeta?: { symbol?: string; name?: string }) {
    fundingRateAbortRef.current?.abort();
    const controller = new AbortController();
    fundingRateAbortRef.current = controller;
    const cacheKey = getFundingRateCacheKey(assetId);
    const cached = fundingRateCacheRef.current[cacheKey] ?? null;

    setFundingRateState({
      status: cached ? 'success' : 'loading',
      data: cached,
      error: null,
    });

    try {
      const params = new URLSearchParams({ asset: assetId, limit: '90' });
      if (assetMeta?.symbol) {
        params.set('symbol', assetMeta.symbol);
      }
      if (assetMeta?.name) {
        params.set('name', assetMeta.name);
      }

      const data = await requestJson<AssetFundingRateResponse>(`/markets/funding?${params.toString()}`, controller.signal);
      if (controller.signal.aborted) {
        return;
      }

      fundingRateCacheRef.current[cacheKey] = data;
      setFundingRateState({ status: 'success', data, error: null });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setFundingRateState((current) => ({
        status: current.data ? 'success' : 'error',
        data: current.data,
        error: error instanceof Error ? error.message : '펀딩비 데이터를 불러오지 못했습니다.',
      }));
    }
  }

  async function loadMarkets(assetId: string, assetMeta?: AssetSearchItem, options?: { trackRecent?: boolean }) {
    marketAbortRef.current?.abort();
    const controller = new AbortController();
    marketAbortRef.current = controller;
    const requestId = ++marketRequestIdRef.current;

    setMarketsState((current) => ({
      status: 'loading',
      data: current.data,
      error: null,
    }));
    setIsBackgroundRefreshing(Boolean(currentMarketsDataRef.current));

    try {
      const params = new URLSearchParams({ asset: assetId });
      if (assetMeta?.symbol) {
        params.set('symbol', assetMeta.symbol);
      }
      if (assetMeta?.name) {
        params.set('name', assetMeta.name);
      }

      const data = await requestJson<AssetMarketsResponse>(`/markets?${params.toString()}`, controller.signal);

      if (requestId !== marketRequestIdRef.current) {
        return;
      }

      setMarketsState({ status: 'success', data, error: null });
      currentMarketsDataRef.current = data;
      setLastLiveUpdateAt(data.source.fetchedAt);
      setLiveStatus(data.source.degraded ? 'stale' : 'connecting');
      setIsBackgroundRefreshing(false);
      const resolvedAsset = assetMeta ?? { id: data.asset.id, symbol: data.asset.symbol, name: data.asset.name };
      const storedSelection = storedChartSelectionsRef.current[resolvedAsset.id];
      const cachedOhlcv = ohlcvCacheRef.current[getOhlcvCacheKey(resolvedAsset.id, chartTimeframe)] ?? null;
      setSelectedChartMarketIds(storedSelection ?? []);
      setOhlcvState({
        status: cachedOhlcv ? 'success' : 'loading',
        data: cachedOhlcv,
        error: null,
      });
      chartSelectionInitializedRef.current = Boolean(storedSelection);
      chartSelectionSuppressedRef.current = Boolean(storedSelection) && storedSelection.length === 0;
      setSelectedAsset(resolvedAsset);

      if (options?.trackRecent) {
        const recentAsset = toStoredAssetItem(resolvedAsset);
        setRecentSearches((current) => dedupeStoredAssets([recentAsset, ...current]).slice(0, MAX_RECENT_SEARCHES));
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      if (requestId !== marketRequestIdRef.current) {
        return;
      }

      setLiveStatus('disconnected');
      setIsBackgroundRefreshing(false);
      setMarketsState((current) => ({
        status: 'error',
        data: current.data,
        error: error instanceof Error ? error.message : '마켓 데이터를 불러오지 못했습니다.',
      }));
    }
  }

  async function selectAsset(asset: AssetSearchItem | StoredAssetItem, options?: { trackRecent?: boolean }) {
    setQuery(asset.symbol.toLowerCase());
    setSearchState((current) => ({
      status: current.status === 'error' ? 'idle' : current.status,
      data: current.data,
      error: null,
    }));

    await loadMarkets(asset.id, { id: asset.id, symbol: asset.symbol, name: asset.name }, { trackRecent: options?.trackRecent ?? true });
  }

  function toggleFavoriteAsset(asset: AssetSearchItem | StoredAssetItem) {
    const favorite = toStoredAssetItem(asset);
    setFavoriteAssets((current) => {
      const exists = current.some((item) => item.id === favorite.id);
      if (exists) {
        return current.filter((item) => item.id !== favorite.id);
      }

      return dedupeStoredAssets([favorite, ...current]);
    });
  }

  function moveFavoriteAssetToTarget(draggedId: string, targetId: string) {
    if (draggedId === targetId) {
      return;
    }

    setFavoriteAssets((current) => {
      const fromIndex = current.findIndex((item) => item.id === draggedId);
      const toIndex = current.findIndex((item) => item.id === targetId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function handleFavoriteDragStart(assetId: string) {
    setDraggedFavoriteId(assetId);
    setFavoriteDropTargetId(assetId);
  }

  function handleFavoriteDragEnter(targetId: string) {
    if (!draggedFavoriteId || draggedFavoriteId === targetId) {
      return;
    }

    setFavoriteDropTargetId(targetId);
  }

  function handleFavoriteDrop(targetId: string) {
    if (!draggedFavoriteId) {
      return;
    }

    moveFavoriteAssetToTarget(draggedFavoriteId, targetId);
    setDraggedFavoriteId(null);
    setFavoriteDropTargetId(null);
  }

  function handleFavoriteDragEnd() {
    setDraggedFavoriteId(null);
    setFavoriteDropTargetId(null);
  }

  async function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();

    if (trimmed.length < 1) {
      setSearchState({ status: 'error', data: null, error: '검색어를 입력해주세요.' });
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setSearchState((current) => ({ status: 'loading', data: current.data, error: null }));

    try {
      const data = await requestJson<AssetSearchResponse>(`/assets/search?q=${encodeURIComponent(trimmed)}`, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setSearchState({ status: 'success', data, error: null });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setSearchState({
        status: 'error',
        data: null,
        error: error instanceof Error ? error.message : '자산 검색에 실패했습니다.',
      });
    }
  }

  const visibleMarkets = useMemo(() => {
    const rows = marketsState.data?.markets ?? [];

    return rows.filter((row) => {
      const marketTypeMatch = marketTypeFilter === 'ALL' || row.marketType === marketTypeFilter;
      const instrumentTypeMatch = instrumentTypeFilter === 'ALL' || row.instrumentType === instrumentTypeFilter;
      const quoteMatch = quoteFilter === 'ALL' || row.quoteAsset === quoteFilter;
      return marketTypeMatch && instrumentTypeMatch && quoteMatch;
    });
  }, [instrumentTypeFilter, marketTypeFilter, quoteFilter, marketsState.data]);

  const sortedVisibleMarkets = useMemo(() => {
    return [...visibleMarkets].sort((left, right) => compareMarketsBySortMode(left, right, chartSortMode));
  }, [chartSortMode, visibleMarkets]);

  const knownQuotes = useMemo(() => {
    return ['ALL', ...new Set((marketsState.data?.markets ?? []).map((row) => row.quoteAsset))];
  }, [marketsState.data]);

  const filteredSearchResults = useMemo(() => {
    const results = searchState.data?.results ?? [];
    const hasSearchMarketFilter = marketTypeFilter !== 'ALL' || instrumentTypeFilter !== 'ALL' || quoteFilter !== 'ALL';

    return results.filter((asset) => {
      const summary = searchResultMarketMap[asset.id];

      if (!hasSearchMarketFilter) {
        return true;
      }

      if (!summary || summary.status !== 'success') {
        return false;
      }

      const marketTypeMatch = marketTypeFilter === 'ALL' || summary.marketTypes.includes(marketTypeFilter);
      const instrumentTypeMatch = instrumentTypeFilter === 'ALL' || summary.instrumentTypes.includes(instrumentTypeFilter);
      const quoteMatch = quoteFilter === 'ALL' || summary.quotes.includes(quoteFilter);

      return marketTypeMatch && instrumentTypeMatch && quoteMatch;
    });
  }, [instrumentTypeFilter, marketTypeFilter, quoteFilter, searchResultMarketMap, searchState.data?.results]);

  const pendingSearchResultCount = useMemo(() => {
    const results = searchState.data?.results ?? [];
    return results.filter((asset) => {
      const summary = searchResultMarketMap[asset.id];
      return !summary || summary.status === 'loading';
    }).length;
  }, [searchResultMarketMap, searchState.data?.results]);

  const exchangeMarketGroups = useMemo(() => {
    const grouped = new Map<string, ExchangeMarketGroup>();

    for (const row of sortedVisibleMarkets) {
      const normalizedExchangeCode = normalizePriorityExchangeCode(row.exchangeCode);
      const existing = grouped.get(normalizedExchangeCode) ?? {
        exchangeCode: normalizedExchangeCode,
        exchangeName: row.exchangeName,
        marketType: row.marketType,
        spot: null,
        futures: null,
      };

      if (row.instrumentType === 'spot') {
        if (!existing.spot || compareSpotMarketPreference(existing.spot, row) > 0) {
          existing.spot = row;
        }
      } else if (!existing.futures || compareVolume(existing.futures, row) > 0) {
        existing.futures = row;
      }

      grouped.set(normalizedExchangeCode, existing);
    }

    for (const priorityExchangeCode of PRIORITY_EXCHANGE_CODES) {
      if (grouped.has(priorityExchangeCode)) {
        continue;
      }

      grouped.set(priorityExchangeCode, {
        exchangeCode: priorityExchangeCode,
        exchangeName: PRIORITY_EXCHANGE_LABELS[priorityExchangeCode] ?? priorityExchangeCode.toUpperCase(),
        marketType: 'CEX',
        spot: null,
        futures: null,
      });
    }

    return [...grouped.values()].sort((left, right) => compareExchangeGroupsBySortMode(left, right, chartSortMode));
  }, [chartSortMode, sortedVisibleMarkets]);

  useEffect(() => {
    setIsExchangeListExpanded(false);
  }, [selectedAsset?.id, marketTypeFilter, instrumentTypeFilter, quoteFilter, chartSortMode]);

  const visibleExchangeMarketGroups = useMemo(() => {
    return isExchangeListExpanded ? exchangeMarketGroups : exchangeMarketGroups.slice(0, DEFAULT_EXCHANGE_LIST_COUNT);
  }, [exchangeMarketGroups, isExchangeListExpanded]);

  const hiddenExchangeGroupCount = Math.max(0, exchangeMarketGroups.length - visibleExchangeMarketGroups.length);

  const defaultChartMarketIds = useMemo(() => {
    return exchangeMarketGroups
      .flatMap((group) => [group.spot, group.futures].filter((market): market is MarketTicker => Boolean(market)))
      .slice(0, DEFAULT_CHART_RESET_COUNT)
      .map((row) => row.marketId);
  }, [exchangeMarketGroups]);

  useEffect(() => {
    setSelectedChartMarketIds((current) => {
      const visibleIds = new Set(visibleMarkets.map((row) => row.marketId));
      const preserved = current.filter((marketId) => visibleIds.has(marketId));

      if (!chartSelectionInitializedRef.current && visibleMarkets.length > 0) {
        chartSelectionInitializedRef.current = true;
        if (!chartSelectionSuppressedRef.current) {
          return defaultChartMarketIds;
        }
      }

      if (preserved.length === 0 && current.length === 0) {
        return current;
      }

      if (preserved.length === current.length && preserved.every((marketId, index) => marketId === current[index])) {
        return current;
      }

      return preserved;
    });
  }, [defaultChartMarketIds, visibleMarkets]);

  const selectedChartMarkets = useMemo(() => {
    const selectedSet = new Set(selectedChartMarketIds);
    return sortedVisibleMarkets.filter((row) => selectedSet.has(row.marketId));
  }, [selectedChartMarketIds, sortedVisibleMarkets]);

  const sourceCounts = useMemo(() => {
    return visibleMarkets.reduce(
      (acc, row) => {
        acc[row.source] = (acc[row.source] ?? 0) + 1;
        return acc;
      },
      { coingecko: 0, binance: 0, kucoin: 0, gate: 0, mexc: 0, bybit: 0, okx: 0, bingx: 0, bitget: 0, mock: 0 } as Record<RowSource, number>,
    );
  }, [visibleMarkets]);

  const directSourceCount = sourceCounts.binance + sourceCounts.kucoin + sourceCounts.gate + sourceCounts.mexc + sourceCounts.bybit + sourceCounts.okx + sourceCounts.bingx + sourceCounts.bitget;

  const marketPriceExtremes = useMemo(() => getMarketPriceExtremes(sortedVisibleMarkets), [sortedVisibleMarkets]);
  const lowestVisiblePrice = marketPriceExtremes.lowestPrice;
  const highestVisiblePrice = marketPriceExtremes.highestPrice;
  const visibleMarketRangePct = calculatePremium(lowestVisiblePrice, highestVisiblePrice);
  const staleBanner = marketsState.data?.source.degraded ? 'CoinGecko 응답이 불안정해 캐시 또는 축소된 데이터를 표시 중입니다.' : null;
  const staleLabel = marketsState.data ? `${marketsState.data.source.cache.toUpperCase()} · ${new Date(marketsState.data.source.fetchedAt).toLocaleString()}` : null;
  const liveLabel = `${liveStatusLabel(liveStatus)}${lastLiveUpdateAt ? ` · ${new Date(lastLiveUpdateAt).toLocaleTimeString()}` : ''}`;

  const comparisonSeries = useMemo(() => {
    const ohlcvMarketMap = new Map((ohlcvState.data?.markets ?? []).map((market) => [market.marketId, market]));

    return selectedChartMarkets
      .map((row) => {
        const marketSeries = ohlcvMarketMap.get(row.marketId);
        if (!marketSeries) {
          return null;
        }

        return {
          marketId: marketSeries.marketId,
          exchangeCode: normalizePriorityExchangeCode(row.exchangeCode),
          exchangeName: marketSeries.exchangeName,
          symbol: marketSeries.symbol,
          source: marketSeries.source,
          marketType: row.marketType,
          instrumentType: row.instrumentType,
          points: marketSeries.candles.map((candle) => ({
            timestamp: new Date(candle.openTime).getTime(),
            price: candle.close,
          })),
          color: getChartSeriesColor(row.exchangeCode),
        };
      })
      .filter((series): series is PriceHistorySeries & { color: string } => Boolean(series))
      .filter((series) => series.points.length > 0);
  }, [ohlcvState.data?.markets, selectedChartMarkets]);

  function updateStoredSelectionForAsset(assetId: string | null, marketIds: string[]) {
    if (!assetId) {
      return;
    }

    setStoredChartSelections((current) => {
      const previousForAsset = current[assetId] ?? null;
      const sameSelection =
        previousForAsset !== null &&
        previousForAsset.length === marketIds.length &&
        previousForAsset.every((marketId, index) => marketId === marketIds[index]);

      if (sameSelection) {
        return current;
      }

      return {
        ...current,
        [assetId]: marketIds,
      };
    });
  }

  function toggleChartMarket(marketId: string) {
    chartSelectionInitializedRef.current = true;
    chartSelectionSuppressedRef.current = false;

    setSelectedChartMarketIds((current) => {
      const next = current.includes(marketId) ? current.filter((id) => id !== marketId) : [...current, marketId];
      updateStoredSelectionForAsset(activeAssetId, next);
      return next;
    });
  }

  function resetChartMarketsToTopVolume() {
    chartSelectionInitializedRef.current = true;
    chartSelectionSuppressedRef.current = false;
    updateStoredSelectionForAsset(activeAssetId, defaultChartMarketIds);
    setSelectedChartMarketIds(defaultChartMarketIds);
  }

  function clearChartMarkets() {
    chartSelectionInitializedRef.current = true;
    chartSelectionSuppressedRef.current = true;
    updateStoredSelectionForAsset(activeAssetId, []);
    setSelectedChartMarketIds([]);
  }

  const chartMetrics = useMemo(() => {
    const allPoints = comparisonSeries.flatMap((series) => series.points);
    if (allPoints.length === 0) {
      return null;
    }

    const prices = allPoints.map((point) => point.price);
    const timestamps = allPoints.map((point) => point.timestamp);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    return {
      minPrice,
      maxPrice: maxPrice === minPrice ? maxPrice + Math.max(maxPrice * 0.002, 1) : maxPrice,
      startTime: Math.min(...timestamps),
      endTime: Math.max(...timestamps),
    };
  }, [comparisonSeries]);

  const premiumSeries = useMemo(() => {
    const timestampRanges = new Map<number, { low: number; high: number }>();

    for (const series of comparisonSeries) {
      for (const point of series.points) {
        const existing = timestampRanges.get(point.timestamp);
        if (!existing) {
          timestampRanges.set(point.timestamp, { low: point.price, high: point.price });
          continue;
        }

        existing.low = Math.min(existing.low, point.price);
        existing.high = Math.max(existing.high, point.price);
      }
    }

    if (timestampRanges.size === 0) {
      return [] as Array<PriceHistorySeries & { color: string }>;
    }

    return comparisonSeries
      .map((series) => ({
        ...series,
        points: series.points
          .map((point) => {
            const range = timestampRanges.get(point.timestamp);
            const premium = calculatePremium(range?.low ?? null, point.price);
            return premium === null
              ? null
              : {
                  timestamp: point.timestamp,
                  price: premium,
                };
          })
          .filter((point): point is PriceHistoryPoint => Boolean(point)),
      }))
      .filter((series) => series.points.length > 0);
  }, [comparisonSeries]);

  const premiumChartMetrics = useMemo(() => {
    const allPoints = premiumSeries.flatMap((series) => series.points);
    if (allPoints.length === 0) {
      return null;
    }

    const values = allPoints.map((point) => point.price);
    const timestamps = allPoints.map((point) => point.timestamp);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const padding = Math.max(Math.abs(minValue), Math.abs(maxValue), 0.05) * 0.1;

    return {
      minPrice: minValue - padding,
      maxPrice: maxValue + padding,
      startTime: Math.min(...timestamps),
      endTime: Math.max(...timestamps),
    };
  }, [premiumSeries]);

  const activeSeries = chartMode === 'price' ? comparisonSeries : premiumSeries;
  const activeChartMetrics = chartMode === 'price' ? chartMetrics : premiumChartMetrics;
  const activeYAxisFormatter = (value: number) => (chartMode === 'price' ? formatPrice(value) : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`);
  const chartHeading = chartMode === 'price' ? '거래소별 가격 비교 차트' : '전체 시장 최저가 대비 괴리율 차트';
  const fundingRateChartPoints = useMemo(() => {
    return (fundingRateState.data?.points ?? []).map((point) => ({
      timestamp: new Date(point.fundingTime).getTime(),
      fundingRate: point.fundingRate,
    }));
  }, [fundingRateState.data?.points]);
  const latestFundingRate = fundingRateState.data?.points.at(-1)?.fundingRate ?? fundingRateState.data?.currentFundingRate ?? null;
  const isSelectedAssetFavorite = selectedAsset ? favoriteAssets.some((asset) => asset.id === selectedAsset.id) : false;

  return (
    <main className="container">
      <section className="hero hero-compact">
        <div>
          <h1 style={{ fontSize: '40px', margin: 0 }}>Alts</h1>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <form className="search search-compact" onSubmit={handleSearchSubmit}>
          <input
            className="search-input-compact"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="ticker search"
            placeholder="코인 티커 또는 이름 검색 (예: btc, ethereum, akedo)"
          />
          <button className="button search-button-compact" type="submit" disabled={searchState.status === 'loading'}>
            {searchState.status === 'loading' ? '검색중' : '검색'}
          </button>
          <select className="search-select-compact search-select-short" value={marketTypeFilter} onChange={(event) => setMarketTypeFilter(event.target.value as 'ALL' | MarketType)} aria-label="market type">
            <option value="ALL">전체</option>
            <option value="CEX">CEX</option>
            <option value="DEX">DEX</option>
          </select>
          <select className="search-select-compact search-select-medium" value={instrumentTypeFilter} onChange={(event) => setInstrumentTypeFilter(event.target.value as 'ALL' | InstrumentType)} aria-label="instrument type">
            <option value="ALL">전체 시장</option>
            <option value="spot">현물</option>
            <option value="futures">선물</option>
          </select>
          <select className="search-select-compact search-select-quote" value={quoteFilter} onChange={(event) => setQuoteFilter(event.target.value)} aria-label="quote asset">
            {knownQuotes.map((quote) => (
              <option key={quote} value={quote}>
                {quote === 'ALL' ? '모든 Quote' : quote}
              </option>
            ))}
          </select>
        </form>

        {searchState.error ? <p className="error-text">{searchState.error}</p> : null}
        {searchState.status === 'success' && searchState.data?.results.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>검색 결과가 없습니다. 다른 심볼이나 이름으로 다시 시도해주세요.</p>
        ) : null}
        {searchState.status === 'success' && (searchState.data?.results.length ?? 0) > 0 && filteredSearchResults.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>
            {pendingSearchResultCount > 0 ? '검색 결과의 마켓 조건을 확인 중입니다.' : '현재 필터 조건에 맞는 검색 결과가 없습니다.'}
          </p>
        ) : null}

        {filteredSearchResults.length ? (
          <div className="results-list">
            {filteredSearchResults.map((asset) => {
              const summary = searchResultMarketMap[asset.id];

              return (
                <button
                  key={asset.id}
                  type="button"
                  className={`result-chip result-chip-compact ${selectedAsset?.id === asset.id ? 'result-chip-active' : ''}`}
                  onClick={() => void selectAsset(asset, { trackRecent: true })}
                  title={`${asset.symbol} · ${asset.name}`}
                >
                  <span className="result-chip-symbol">{asset.symbol}</span>
                  <small className="result-chip-name">{asset.name}</small>
                  <small className="result-chip-price">{formatPrice(asset.currentPriceUsd ?? null)}</small>
                  <div className="result-chip-badges">
                    {summary?.marketTypes.includes('CEX') ? <span className="market-chip market-chip-cex">CEX</span> : null}
                    {summary?.marketTypes.includes('DEX') ? <span className="market-chip market-chip-dex">DEX</span> : null}
                    {summary?.status === 'loading' && summary.marketTypes.length === 0 ? <span className="market-chip">확인중</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="quick-access-inline quick-access-inline-recent">
          <span className="quick-access-mini-label" title="최근에 본 티커를 빠르게 다시 불러옵니다.">⟳</span>
          <div className="quick-access-chips">
            {recentSearches.length > 0 ? (
              recentSearches.map((asset) => (
                <button
                  key={`recent-${asset.id}`}
                  type="button"
                  className={`quick-asset-chip ${selectedAsset?.id === asset.id ? 'quick-asset-chip-active' : ''}`}
                  onClick={() => void selectAsset(asset, { trackRecent: true })}
                  title={asset.name}
                >
                  <span>{asset.symbol}</span>
                </button>
              ))
            ) : (
              <span className="muted">없음</span>
            )}
          </div>
        </div>
      </section>

      <section className="panel quick-access-panel">
        <div className="quick-access-inline">
          <span className="quick-access-mini-label quick-access-mini-label-favorite" title="자주 보는 티커를 고정해두고 순서를 직접 바꿀 수 있습니다.">★</span>
          <div className="quick-access-chips quick-access-chips-favorites">
            {favoriteAssets.length > 0 ? (
              favoriteAssets.map((asset) => {
                const fundingSummary = favoriteFundingMap[asset.id];
                const fundingLabel =
                  fundingSummary?.status === 'loading' && fundingSummary.fetchedAt === null
                    ? '24h 저펀딩 로딩중'
                    : `24h 저펀딩 ${formatSignedPercent(fundingSummary?.minFundingRate24h ?? null)}`;
                const fundingToneClass =
                  fundingSummary?.minFundingRate24h == null
                    ? ''
                    : (fundingSummary.minFundingRate24h ?? 0) < 0
                      ? 'favorite-funding-label-negative'
                      : 'favorite-funding-label-positive';

                return (
                  <div
                    key={`favorite-${asset.id}`}
                    className={`favorite-chip-wrap ${draggedFavoriteId === asset.id ? 'favorite-chip-wrap-dragging' : ''} ${favoriteDropTargetId === asset.id ? 'favorite-chip-wrap-drop-target' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', asset.id);
                      handleFavoriteDragStart(asset.id);
                    }}
                    onDragEnter={() => handleFavoriteDragEnter(asset.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      handleFavoriteDrop(asset.id);
                    }}
                    onDragEnd={handleFavoriteDragEnd}
                    title={`${asset.name} · 드래그해서 순서 변경`}
                  >
                    <button
                      type="button"
                      className={`quick-asset-chip quick-asset-chip-favorite ${selectedAsset?.id === asset.id ? 'quick-asset-chip-active' : ''}`}
                      onClick={() => void selectAsset(asset, { trackRecent: true })}
                      title={asset.name}
                    >
                      <span className="quick-asset-chip-symbol">{asset.symbol}</span>
                      <small className={`favorite-funding-label ${fundingToneClass}`}>{fundingLabel}</small>
                    </button>
                  </div>
                );
              })
            ) : (
              <span className="muted">없음</span>
            )}
          </div>
        </div>
      </section>

      {staleBanner ? <div className="panel warning-panel">{staleBanner}</div> : null}
      {marketsState.error ? <div className="panel error-panel">{marketsState.error}</div> : null}

      <section className="panel chart-panel-top">
        <div className="chart-workspace">
          <aside className="chart-sidebar">
            <div className="chart-sidebar-header">
              <div className="chart-sidebar-asset-title-wrap">
                <button
                  type="button"
                  className={`favorite-icon-button ${isSelectedAssetFavorite ? 'favorite-icon-button-active' : ''}`}
                  onClick={() => selectedAsset && toggleFavoriteAsset(selectedAsset)}
                  aria-label={isSelectedAssetFavorite ? '즐겨찾기 해제' : '즐겨찾기 등록'}
                  title={isSelectedAssetFavorite ? '즐겨찾기 해제' : '즐겨찾기 등록'}
                  disabled={!selectedAsset}
                >
                  {isSelectedAssetFavorite ? '★' : '☆'}
                </button>
                <h2 className="chart-sidebar-asset-title">{selectedAsset?.symbol ?? '—'}</h2>
              </div>
              <div className="chart-sidebar-status-row">
                <span className={`badge badge-compact badge-status ${liveStatus === 'disconnected' ? 'badge-danger' : liveStatus === 'stale' ? 'badge-warning' : ''}`}>{liveStatus === 'live' ? 'LIVE' : liveStatus === 'connecting' ? '연결중' : liveStatus === 'stale' ? '지연' : '끊김'}</span>
                {isBackgroundRefreshing ? <span className="muted status-inline-text">갱신중</span> : null}
              </div>
            </div>
            <div className="chart-action-row">
              <button type="button" className="button button-secondary chart-compact-button" onClick={resetChartMarketsToTopVolume}>
                상위{DEFAULT_CHART_RESET_COUNT} 리셋
              </button>
              <button type="button" className="button button-secondary chart-compact-button" onClick={clearChartMarkets}>
                해제
              </button>
              <label className="chart-sort-control chart-sort-control-compact chart-sort-control-icon-only" title="리셋 기준">
                <select value={chartSortMode} onChange={(event) => setChartSortMode(event.target.value as ChartSortMode)} aria-label="리셋 기준">
                  <option value="volume">거래량</option>
                  <option value="rank">마켓 순위</option>
                  <option value="name">거래소명</option>
                </select>
              </label>
            </div>
            <div className="chart-selector-meta chart-selector-meta-compact">
              <span className="badge badge-compact">{selectedChartMarkets.length}선택</span>
              <span className="badge badge-compact">{instrumentTypeFilter === 'ALL' ? '전체' : instrumentTypeFilter === 'spot' ? '현물' : '선물'}</span>
              <span className="badge badge-neutral badge-compact">{chartSortMode === 'volume' ? '거래량' : chartSortMode === 'rank' ? '순위' : '이름'}</span>
            </div>
            <div className="chart-selector-list chart-selector-list-vertical">
              {visibleExchangeMarketGroups.map((group) => {
                const spotSelected = group.spot ? selectedChartMarketIds.includes(group.spot.marketId) : false;
                const futuresSelected = group.futures ? selectedChartMarketIds.includes(group.futures.marketId) : false;
                const disableSpot = !group.spot;
                const disableFutures = !group.futures;
                return (
                  <div key={`exchange-group-${group.exchangeCode}`} className="exchange-row">
                    <div className="exchange-row-info">
                      <div className="exchange-row-name" title={group.exchangeName}>{group.exchangeName}</div>
                      <div className="exchange-row-badges">
                        <span className={`market-chip ${group.marketType === 'DEX' ? 'market-chip-dex' : 'market-chip-cex'}`}>{group.marketType}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`exchange-market-button ${spotSelected ? 'exchange-market-button-active' : ''}`}
                      onClick={() => group.spot && toggleChartMarket(group.spot.marketId)}
                      disabled={disableSpot}
                    >
                      <span>S</span>
                      <span>{group.spot ? formatCompactUsd(group.spot.volume24hUsd) : '—'}</span>
                    </button>
                    <button
                      type="button"
                      className={`exchange-market-button ${futuresSelected ? 'exchange-market-button-active' : ''}`}
                      onClick={() => group.futures && toggleChartMarket(group.futures.marketId)}
                      disabled={disableFutures}
                    >
                      <span>F</span>
                      <span>{group.futures ? formatCompactUsd(group.futures.volume24hUsd) : '—'}</span>
                    </button>
                  </div>
                );
              })}
              {exchangeMarketGroups.length === 0 ? <div className="chart-placeholder chart-placeholder-compact">선택 가능한 거래소가 없습니다.</div> : null}
            </div>
            {exchangeMarketGroups.length > DEFAULT_EXCHANGE_LIST_COUNT ? (
              <div className="chart-list-toggle-row">
                <span className="muted">
                  {isExchangeListExpanded ? `전체 ${exchangeMarketGroups.length}줄 표시 중` : `${visibleExchangeMarketGroups.length}줄 표시 중 · ${hiddenExchangeGroupCount}줄 더 있음`}
                </span>
                <button type="button" className="button button-secondary" onClick={() => setIsExchangeListExpanded((current) => !current)}>
                  {isExchangeListExpanded ? '간략히' : '펼치기'}
                </button>
              </div>
            ) : null}
          </aside>

          <div className="chart-main-panel">
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="chart-top-controls">
                <div className="timeframe-toggle" role="tablist" aria-label="차트 프레임 옵션">
                  {(['tick', '1m', '5m', '15m', '1h', '4h', '1d', '1M'] as ChartTimeframe[]).map((timeframe) => (
                    <button
                      key={timeframe}
                      type="button"
                      className={`timeframe-button ${chartTimeframe === timeframe ? 'timeframe-button-active' : ''}`}
                      onClick={() => setChartTimeframe(timeframe)}
                    >
                      {timeframeLabel(timeframe)}
                    </button>
                  ))}
                </div>
                <div className="timeframe-toggle" role="tablist" aria-label="차트 모드 옵션">
                  <button type="button" className={`timeframe-button ${chartMode === 'price' ? 'timeframe-button-active' : ''}`} onClick={() => setChartMode('price')}>
                    가격
                  </button>
                  <button type="button" className={`timeframe-button ${chartMode === 'premium' ? 'timeframe-button-active' : ''}`} onClick={() => setChartMode('premium')}>
                    괴리율
                  </button>
                </div>

              </div>
            </div>

            {activeSeries.length > 0 && activeChartMetrics ? (
              <>
                <TradingViewChart ariaLabel={chartHeading} chartMode={chartMode} chartTimeframe={chartTimeframe} series={activeSeries} />

                <div className="funding-subchart-panel">
                  <div className="funding-subchart-header">
                    <div>
                      <strong>Binance 펀딩비</strong>
                      <div className="muted" style={{ marginTop: 6 }}>
                        {(fundingRateState.data?.symbol ?? 'USDT Perpetual')} · 최근 {fundingRateChartPoints.length}회
                      </div>
                    </div>
                    <div className="funding-subchart-badges">
                      <span className="badge badge-compact">최근 {formatSignedPercent(latestFundingRate)}</span>
                      <span className="badge badge-compact">다음 정산 {formatLocalDateTime(fundingRateState.data?.nextFundingTime ?? null)}</span>
                    </div>
                  </div>

                  {fundingRateChartPoints.length > 0 ? (
                    <FundingRateChart ariaLabel="Binance 선물 펀딩비 보조차트" points={fundingRateChartPoints} />
                  ) : (
                    <div className="chart-placeholder chart-placeholder-compact funding-subchart-placeholder">
                      {fundingRateState.status === 'loading'
                        ? 'Binance 선물 펀딩비를 불러오는 중입니다.'
                        : fundingRateState.error
                          ? `펀딩비 로딩 실패: ${fundingRateState.error}`
                          : '이 자산은 Binance USDT 무기한 선물 펀딩 히스토리를 아직 찾지 못했습니다.'}
                    </div>
                  )}
                </div>

                <div className="chart-legend">
                  {activeSeries.map((series) => (
                    <div key={`legend-${chartMode}-${series.marketId}`} className="chart-legend-item">
                      <span
                        className={`chart-legend-color ${series.exchangeCode === 'okx' ? 'chart-legend-color-light' : ''}`}
                        style={{ background: series.color }}
                      />
                      <div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <strong>{series.exchangeName}</strong>
                          <span className="market-chip">{series.instrumentType === 'spot' ? 'S' : 'F'}</span>
                          <span className={`market-chip ${series.marketType === 'DEX' ? 'market-chip-dex' : 'market-chip-cex'}`}>{series.marketType}</span>
                        </div>
                        <div className="muted" style={{ marginTop: 6 }}>
                          {series.symbol} · {series.instrumentType === 'spot' ? '실선' : '점선'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

              </>
            ) : (
              <div className="chart-placeholder">
                {ohlcvState.error ? `OHLCV 로딩 실패: ${ohlcvState.error}` : 'OHLCV 캔들 데이터가 아직 충분하지 않습니다. 몇 초 기다리면 채워집니다.'}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>거래소별 마켓</h2>
            <p className="muted" style={{ marginTop: 8 }}>
              상세 테이블은 필요할 때만 펼쳐서 확인합니다. 기본 화면은 차트 비교에 집중합니다.
            </p>
            {lowestVisiblePrice !== null && highestVisiblePrice !== null ? (
              <p className="muted" style={{ marginTop: 8 }}>
                최저 {marketPriceExtremes.lowestMarket?.exchangeName} {marketPriceExtremes.lowestMarket?.instrumentType === 'spot' ? 'S' : 'F'} {formatPrice(lowestVisiblePrice)} · 최고 {marketPriceExtremes.highestMarket?.exchangeName} {marketPriceExtremes.highestMarket?.instrumentType === 'spot' ? 'S' : 'F'} {formatPrice(highestVisiblePrice)} · 전체 범위 {visibleMarketRangePct === null ? '—' : `+${visibleMarketRangePct.toFixed(3)}%`}
              </p>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge">{visibleMarkets.length}개 표시</span>
            <span className="badge badge-warning">직접 소스 {directSourceCount}개</span>
            <span className="badge">집계 소스 {sourceCounts.coingecko}개</span>
            <button type="button" className="button button-secondary" onClick={() => setIsMarketsExpanded((current) => !current)}>
              {isMarketsExpanded ? '상세 마켓 숨기기' : '상세 마켓 보기'}
            </button>
          </div>
        </div>

        {isMarketsExpanded ? (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>거래소</th>
                <th>시장</th>
                <th>쌍</th>
                <th>시세</th>
                <th>최저가 대비</th>
                <th>최고가 대비</th>
                <th>스프레드</th>
                <th>24시간 거래량</th>
                <th>신뢰도</th>
                <th>최근 업데이트</th>
              </tr>
            </thead>
            <tbody>
              {marketsState.status === 'loading' && !marketsState.data ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={`skeleton-${index}`}>
                    <td colSpan={11} className="muted">마켓 데이터를 불러오는 중입니다...</td>
                  </tr>
                ))
              ) : visibleMarkets.length > 0 ? (
                visibleMarkets.map((row) => {
                  const lowGap = calculatePremium(lowestVisiblePrice, row.lastPrice);
                  const highGap = calculatePremium(highestVisiblePrice, row.lastPrice);
                  return (
                    <tr key={row.marketId}>
                      <td>{row.rank}</td>
                      <td>
                        <div>{row.exchangeName}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          <span className={`source-pill ${row.source === 'binance' ? 'source-pill-direct' : ''}`}>{rowSourceLabel(row.source)}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span className="market-chip">{row.marketType}</span>
                          <span className="market-chip">{row.instrumentType === 'spot' ? '현물' : '선물'}</span>
                        </div>
                      </td>
                      <td>
                        <div>{row.symbol}</div>
                        {row.tradeUrl ? (
                          <a className="muted link-inline" href={row.tradeUrl} rel="noreferrer" target="_blank">
                            거래소 링크
                          </a>
                        ) : null}
                      </td>
                      <td>{formatPrice(row.lastPrice)}</td>
                      <td className={lowGap === null ? 'muted' : lowGap >= 0 ? 'price-up' : 'price-down'}>
                        {lowGap === null ? '—' : `${lowGap >= 0 ? '+' : ''}${lowGap.toFixed(3)}%`}
                      </td>
                      <td className={highGap === null ? 'muted' : highGap >= 0 ? 'price-up' : 'price-down'}>
                        {highGap === null ? '—' : `${highGap >= 0 ? '+' : ''}${highGap.toFixed(3)}%`}
                      </td>
                      <td>{row.spreadPct === null ? '—' : `${row.spreadPct.toFixed(3)}%`}</td>
                      <td>{formatCurrency(row.volume24hUsd, 0)}</td>
                      <td>{row.trustScore ?? '—'}</td>
                      <td className="muted">{row.updatedAtLabel}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={11} className="muted">현재 조건에 맞는 마켓이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="grid">
        <div className="panel" style={{ gridColumn: 'span 12' }}>
          <h2 style={{ marginTop: 0 }}>다음 구현 포인트</h2>
          <ol className="muted" style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li>Binance 다음 거래소(예: KuCoin, Gate) 원본 가격 보강 추가</li>
            <li>ccxt / ccxt.pro 기반 거래소별 실시간 ticker_update 이벤트 추가</li>
            <li>괴리율 히스토리 차트와 거래소 상세 패널 도입</li>
            <li>TimescaleDB 적재와 1분 OHLCV 차트 API 연결</li>
          </ol>
        </div>
      </section>
    </main>
  );
}
