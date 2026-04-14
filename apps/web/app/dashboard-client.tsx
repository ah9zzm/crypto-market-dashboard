'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { TradingViewChart } from './components/tradingview-chart';
import type {
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
const DEFAULT_CHART_RESET_COUNT = 10;
const DEFAULT_EXCHANGE_LIST_COUNT = 10;
const CHART_COLORS = ['#60a5fa', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#facc15', '#4ade80', '#c084fc'];
const PRIORITY_EXCHANGE_CODES = ['binance', 'okx', 'bingx', 'bybit', 'bitget', 'gate'];
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
  if (exchangeCode.startsWith('bybit')) {
    return 'bybit';
  }

  if (exchangeCode === 'okex') {
    return 'okx';
  }

  return exchangeCode;
}

function getChartSeriesColor(exchangeCode: string, fallbackIndex: number) {
  const normalized = normalizePriorityExchangeCode(exchangeCode);

  switch (normalized) {
    case 'binance':
      return '#F0B90B';
    case 'okx':
      return '#FFFFFF';
    case 'bingx':
      return '#2563EB';
    case 'bybit':
      return '#F97316';
    case 'bitget':
      return '#38BDF8';
    case 'gate':
      return '#C71F37';
    default:
      return CHART_COLORS[fallbackIndex % CHART_COLORS.length];
  }
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

  return new Date(timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatChartAxisTime(timestamp: number, timeframe: ChartTimeframe) {
  return new Date(timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeframe === 'tick' ? { second: '2-digit' as const } : {}),
  });
}

function getOhlcvCacheKey(assetId: string, timeframe: ChartTimeframe) {
  return `${assetId}:${timeframe}`;
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
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [lastLiveUpdateAt, setLastLiveUpdateAt] = useState<string | null>(null);
  const marketRequestIdRef = useRef(0);
  const currentMarketsDataRef = useRef<AssetMarketsResponse | null>(null);
  const marketAbortRef = useRef<AbortController | null>(null);
  const ohlcvAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const subscribedAssetIdRef = useRef<string | null>(null);
  const storedChartSelectionsRef = useRef<Record<string, string[]>>({});
  const ohlcvCacheRef = useRef<Record<string, AssetOhlcvResponse>>({});
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
      searchAbortRef.current?.abort();
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    currentMarketsDataRef.current = marketsState.data;
  }, [marketsState.data]);

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
      socket.emit('subscribe_markets', { asset: assetId });
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
  }, [activeAssetId]);

  useEffect(() => {
    const assetId = activeAssetId;
    if (!assetId) {
      return;
    }

    void loadOhlcv(assetId, chartTimeframe);
  }, [activeAssetId, chartTimeframe, lastLiveUpdateAt]);

  async function loadOhlcv(assetId: string, timeframe: ChartTimeframe) {
    ohlcvAbortRef.current?.abort();
    const controller = new AbortController();
    ohlcvAbortRef.current = controller;
    const cacheKey = getOhlcvCacheKey(assetId, timeframe);
    const cached = ohlcvCacheRef.current[cacheKey] ?? null;

    setOhlcvState({
      status: cached ? 'success' : 'loading',
      data: cached,
      error: null,
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
      const data = await requestJson<AssetMarketsResponse>(`/markets?asset=${encodeURIComponent(assetId)}`, controller.signal);

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

    if (trimmed.length < 2) {
      setSearchState({ status: 'error', data: null, error: '검색어는 2글자 이상 입력해주세요.' });
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

  const referencePrice = sortedVisibleMarkets[0]?.lastPrice ?? null;
  const staleBanner = marketsState.data?.source.degraded ? 'CoinGecko 응답이 불안정해 캐시 또는 축소된 데이터를 표시 중입니다.' : null;
  const staleLabel = marketsState.data ? `${marketsState.data.source.cache.toUpperCase()} · ${new Date(marketsState.data.source.fetchedAt).toLocaleString('ko-KR')}` : null;
  const liveLabel = `${liveStatusLabel(liveStatus)}${lastLiveUpdateAt ? ` · ${new Date(lastLiveUpdateAt).toLocaleTimeString('ko-KR')}` : ''}`;

  const comparisonSeries = useMemo(() => {
    const ohlcvMarketMap = new Map((ohlcvState.data?.markets ?? []).map((market) => [market.marketId, market]));

    return selectedChartMarkets
      .map((row, index) => {
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
          color: getChartSeriesColor(row.exchangeCode, index),
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
    const referenceSeries = comparisonSeries[0];
    if (!referenceSeries) {
      return [] as Array<PriceHistorySeries & { color: string }>;
    }

    const referenceMap = new Map(referenceSeries.points.map((point) => [point.timestamp, point.price]));

    return comparisonSeries
      .map((series) => ({
        ...series,
        points: series.points
          .map((point) => {
            const referencePoint = referenceMap.get(point.timestamp);
            const premium = calculatePremium(referencePoint ?? null, point.price);
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

  const referenceExchangeName = sortedVisibleMarkets[0]?.exchangeName ?? '기준 거래소';
  const activeSeries = chartMode === 'price' ? comparisonSeries : premiumSeries;
  const activeChartMetrics = chartMode === 'price' ? chartMetrics : premiumChartMetrics;
  const activeYAxisFormatter = (value: number) => (chartMode === 'price' ? formatPrice(value) : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`);
  const chartHeading = chartMode === 'price' ? '거래소별 가격 비교 차트' : '기준 거래소 대비 괴리율 차트';
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

        {searchState.data?.results?.length ? (
          <div className="results-list">
            {searchState.data.results.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className={`result-chip result-chip-compact ${selectedAsset?.id === asset.id ? 'result-chip-active' : ''}`}
                onClick={() => void selectAsset(asset, { trackRecent: true })}
                title={`${asset.symbol} · ${asset.name}`}
              >
                <span className="result-chip-symbol">{asset.symbol}</span>
                <small className="result-chip-name">{asset.name}</small>
              </button>
            ))}
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
              favoriteAssets.map((asset) => (
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
                    <span>{asset.symbol}</span>
                  </button>
                </div>
              ))
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
                  {(['tick', '1m', '5m', '15m'] as ChartTimeframe[]).map((timeframe) => (
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
                <th>기준 대비</th>
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
                    <td colSpan={10} className="muted">마켓 데이터를 불러오는 중입니다...</td>
                  </tr>
                ))
              ) : visibleMarkets.length > 0 ? (
                visibleMarkets.map((row) => {
                  const premium = calculatePremium(referencePrice, row.lastPrice);
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
                      <td className={premium === null ? 'muted' : premium >= 0 ? 'price-up' : 'price-down'}>
                        {premium === null ? '—' : `${premium >= 0 ? '+' : ''}${premium.toFixed(3)}%`}
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
                  <td colSpan={10} className="muted">현재 조건에 맞는 마켓이 없습니다.</td>
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
