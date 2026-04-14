import { Injectable } from '@nestjs/common';
import {
  type AssetDescriptor,
  type AssetSearchItem,
  type InstrumentType,
  type MarketTicker,
  type MarketType,
} from '@cmd/shared-types';
import type { CoinGeckoSearchCoin, CoinGeckoTicker, CoinGeckoTickersResponse } from './coingecko.service';

const DEX_IDENTIFIERS = [
  'uniswap',
  'pancakeswap',
  'curve',
  'balancer',
  'raydium',
  'orca',
  'camelot',
  'aerodrome',
  'spookyswap',
  'sushiswap',
  'quickswap',
  'traderjoe',
  'velodrome',
];

@Injectable()
export class MarketMapperService {
  mapSearchCoins(query: string, coins: CoinGeckoSearchCoin[]): AssetSearchItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    const deduped = new Map<string, AssetSearchItem>();

    for (const coin of coins) {
      if (!coin.id || !coin.symbol || !coin.name) {
        continue;
      }

      deduped.set(coin.id, {
        id: coin.id,
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        imageUrl: coin.large ?? coin.thumb,
        marketCapRank: coin.market_cap_rank ?? null,
      });
    }

    return [...deduped.values()]
      .sort((left, right) => this.compareAssets(normalizedQuery, left, right))
      .slice(0, 10);
  }

  mapMarkets(assetId: string, payload: CoinGeckoTickersResponse): { asset: AssetDescriptor; markets: MarketTicker[] } {
    const assetSymbol = payload.symbol?.toUpperCase() || payload.tickers.find((ticker) => ticker.base)?.base?.toUpperCase() || assetId.toUpperCase();
    const asset: AssetDescriptor = {
      id: assetId,
      symbol: assetSymbol,
      name: payload.name ?? assetSymbol,
    };

    const mapped = payload.tickers
      .map((ticker) => this.mapTicker(assetId, assetSymbol, ticker))
      .filter((ticker): ticker is MarketTicker => ticker !== null)
      .sort((left, right) => this.compareMarkets(left, right))
      .slice(0, 50)
      .map((ticker, index) => ({
        ...ticker,
        rank: index + 1,
      }));

    return { asset, markets: mapped };
  }

  private compareAssets(query: string, left: AssetSearchItem, right: AssetSearchItem): number {
    const leftScore = this.searchPriority(query, left);
    const rightScore = this.searchPriority(query, right);

    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    const leftRank = left.marketCapRank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.marketCapRank ?? Number.MAX_SAFE_INTEGER;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.name.localeCompare(right.name);
  }

  private searchPriority(query: string, item: AssetSearchItem): number {
    const symbol = item.symbol.toLowerCase();
    const name = item.name.toLowerCase();

    if (symbol === query) {
      return 0;
    }

    if (name === query) {
      return 1;
    }

    if (symbol.startsWith(query)) {
      return 2;
    }

    if (name.startsWith(query)) {
      return 3;
    }

    return 4;
  }

  private mapTicker(assetId: string, assetSymbol: string, ticker: CoinGeckoTicker): MarketTicker | null {
    const baseAsset = ticker.base?.toUpperCase().trim();
    const quoteAsset = ticker.target?.toUpperCase().trim();

    if (!baseAsset || !quoteAsset) {
      return null;
    }

    if (ticker.coin_id && ticker.coin_id !== assetId) {
      return null;
    }

    if (!ticker.coin_id && baseAsset !== assetSymbol) {
      return null;
    }

    const lastPrice = this.toFiniteNumber(ticker.last);
    const volume24hUsd = this.toFiniteNumber(ticker.converted_volume?.usd);

    if (lastPrice === null && volume24hUsd === null) {
      return null;
    }

    const exchangeCode = this.normalizeExchangeCode(ticker.market?.identifier, ticker.market?.name);
    const exchangeName = ticker.market?.name?.trim() || exchangeCode;
    const marketType = this.detectMarketType(exchangeCode, exchangeName);
    const instrumentType = this.detectInstrumentType(ticker, marketType);
    const lastTradedAt = this.toIsoString(ticker.last_traded_at);

    return {
      rank: 0,
      marketId: `${ticker.coin_id ?? assetId}:${exchangeCode}:${baseAsset}:${quoteAsset}:${marketType}:${instrumentType}`,
      exchangeCode,
      exchangeName,
      marketType,
      instrumentType,
      symbol: `${baseAsset}/${quoteAsset}`,
      baseAsset,
      quoteAsset,
      lastPrice,
      volume24hUsd,
      spreadPct: this.toFiniteNumber(ticker.bid_ask_spread_percentage),
      trustScore: ticker.trust_score ?? null,
      lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(lastTradedAt),
      tradeUrl: this.sanitizeTradeUrl(ticker.trade_url),
      source: 'coingecko',
    };
  }

  private compareMarkets(left: MarketTicker, right: MarketTicker): number {
    const leftVolume = left.volume24hUsd ?? -1;
    const rightVolume = right.volume24hUsd ?? -1;

    if (leftVolume !== rightVolume) {
      return rightVolume - leftVolume;
    }

    const trustScoreOrder = { green: 0, yellow: 1, red: 2, null: 3 } as const;
    const leftTrust = trustScoreOrder[left.trustScore ?? 'null'];
    const rightTrust = trustScoreOrder[right.trustScore ?? 'null'];

    if (leftTrust !== rightTrust) {
      return leftTrust - rightTrust;
    }

    return left.exchangeName.localeCompare(right.exchangeName);
  }

  private normalizeExchangeCode(identifier?: string, name?: string): string {
    const candidate = identifier?.trim() || name?.trim() || 'unknown';
    return candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'unknown';
  }

  private detectMarketType(exchangeCode: string, exchangeName: string): MarketType {
    const haystack = `${exchangeCode} ${exchangeName}`.toLowerCase();
    return DEX_IDENTIFIERS.some((entry) => haystack.includes(entry)) ? 'DEX' : 'CEX';
  }

  private detectInstrumentType(ticker: CoinGeckoTicker, marketType: MarketType): InstrumentType {
    if (marketType === 'DEX') {
      return 'spot';
    }

    const haystack = [
      ticker.base,
      ticker.target,
      ticker.market?.name,
      ticker.market?.identifier,
      ticker.trade_url,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    if (/\b(perp|perpetual|futures?)\b/.test(haystack)) {
      return 'futures';
    }

    if (/(\/futures\/|_perp\b|-perp\b|perp\b|swap\b)/.test(haystack)) {
      return 'futures';
    }

    return 'spot';
  }

  private toFiniteNumber(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private toIsoString(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private sanitizeTradeUrl(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  private formatUpdatedAtLabel(lastTradedAt: string | null): string {
    if (!lastTradedAt) {
      return '업데이트 정보 없음';
    }

    const diffMs = Date.now() - new Date(lastTradedAt).getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

    if (diffMinutes < 1) {
      return '방금';
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}분 전`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours}시간 전`;
    }

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}일 전`;
  }
}
