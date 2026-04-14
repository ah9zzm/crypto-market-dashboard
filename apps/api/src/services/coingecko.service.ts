import { Injectable } from '@nestjs/common';

export interface CoinGeckoSearchCoin {
  id: string;
  name: string;
  symbol: string;
  market_cap_rank?: number | null;
  thumb?: string;
  large?: string;
}

export interface CoinGeckoSearchResponse {
  coins: CoinGeckoSearchCoin[];
}

export interface CoinGeckoTicker {
  base?: string;
  target?: string;
  market?: {
    name?: string;
    identifier?: string;
    has_trading_incentive?: boolean;
  };
  last?: number | null;
  converted_volume?: {
    usd?: number | null;
  };
  trust_score?: 'green' | 'yellow' | 'red' | null;
  bid_ask_spread_percentage?: number | null;
  last_traded_at?: string | null;
  trade_url?: string | null;
  coin_id?: string | null;
}

export interface CoinGeckoTickersResponse {
  name?: string;
  symbol?: string;
  tickers: CoinGeckoTicker[];
}

export class CoinGeckoRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

@Injectable()
export class CoinGeckoService {
  private readonly baseUrl = 'https://api.coingecko.com/api/v3';
  private readonly timeoutMs = 10_000;

  async searchAssets(query: string): Promise<CoinGeckoSearchResponse> {
    const encoded = encodeURIComponent(query);
    return this.getJson<CoinGeckoSearchResponse>(`/search?query=${encoded}`);
  }

  async getCoinTickers(assetId: string): Promise<CoinGeckoTickersResponse> {
    const encoded = encodeURIComponent(assetId);
    return this.getJson<CoinGeckoTickersResponse>(`/coins/${encoded}/tickers?include_exchange_logo=false&page=1`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new CoinGeckoRequestError(`CoinGecko request failed with ${response.status}`, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof CoinGeckoRequestError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new CoinGeckoRequestError('CoinGecko request timed out', 504);
      }

      throw new CoinGeckoRequestError('CoinGecko request failed', 500);
    } finally {
      clearTimeout(timeout);
    }
  }
}
