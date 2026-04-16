import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import type { AssetMarketsResponse, MarketSnapshotEvent, MarketTicker, MarketUpdateChange, MarketUpdateEvent } from '@cmd/shared-types';
import { Namespace, Socket } from 'socket.io';
import { BinanceLiveTickerService, type BinanceTickerUpdateEvent } from '../services/binance-live-ticker.service';
import { type AssetIdentityHint, MarketDiscoveryService } from '../services/market-discovery.service';
import { MarketOhlcvService } from '../services/market-ohlcv.service';

interface AssetStreamState {
  timer: NodeJS.Timeout;
  version: number;
  previousMarkets: Map<string, MarketTicker>;
  lastSource: AssetMarketsResponse['source'];
  assetHint?: AssetIdentityHint;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/markets',
})
export class MarketGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Namespace;

  private readonly pollIntervalMs = 15_000;
  private readonly assetStreams = new Map<string, AssetStreamState>();
  private readonly clientAssetMap = new Map<string, string>();
  private readonly unsubscribeFromBinanceUpdates: () => void;

  constructor(
    private readonly marketDiscoveryService: MarketDiscoveryService,
    private readonly binanceLiveTickerService: BinanceLiveTickerService,
    private readonly marketOhlcvService: MarketOhlcvService,
  ) {
    this.unsubscribeFromBinanceUpdates = this.binanceLiveTickerService.onTickerUpdate((event) => this.handleBinanceTickerUpdate(event));
  }

  handleConnection() {
    console.log('WebSocket client connected');
  }

  onModuleDestroy() {
    this.unsubscribeFromBinanceUpdates();
  }

  handleDisconnect(client: Socket) {
    const assetId = this.clientAssetMap.get(client.id);
    this.clientAssetMap.delete(client.id);

    if (assetId) {
      this.cleanupAssetStream(assetId);
    }
  }

  @SubscribeMessage('subscribe_markets')
  async handleSubscribe(
    @MessageBody() payload: { asset?: string; symbol?: string; name?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const assetId = (payload?.asset?.trim() || 'bitcoin').toLowerCase();
    const assetHint: AssetIdentityHint = {
      symbol: payload?.symbol?.trim() || undefined,
      name: payload?.name?.trim() || undefined,
    };
    const room = this.roomName(assetId);

    for (const joinedRoom of client.rooms) {
      if (joinedRoom.startsWith('asset:') && joinedRoom !== room) {
        client.leave(joinedRoom);
        this.cleanupAssetStream(joinedRoom.replace('asset:', ''));
      }
    }

    client.join(room);
    this.clientAssetMap.set(client.id, assetId);
    const snapshot = await this.marketDiscoveryService.getMarkets(assetId, assetHint, { refreshDirectTickers: true });
    this.ensureAssetStream(assetId, snapshot, assetHint);
    this.binanceLiveTickerService.registerAssetMarkets(assetId, snapshot.markets);
    this.emitSnapshot(assetId, snapshot);

    return { ok: true, assetId };
  }

  @SubscribeMessage('unsubscribe_markets')
  handleUnsubscribe(
    @MessageBody() payload: { asset?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const assetId = (payload?.asset?.trim() || '').toLowerCase();

    if (!assetId) {
      return { event: 'unsubscribed', data: { ok: true } };
    }

    client.leave(this.roomName(assetId));
    this.clientAssetMap.delete(client.id);
    this.cleanupAssetStream(assetId);

    return { event: 'unsubscribed', data: { ok: true, assetId } };
  }

  private ensureAssetStream(assetId: string, initialSnapshot: AssetMarketsResponse, assetHint?: AssetIdentityHint) {
    const existing = this.assetStreams.get(assetId);
    if (existing) {
      existing.assetHint = {
        symbol: assetHint?.symbol ?? existing.assetHint?.symbol ?? initialSnapshot.asset.symbol,
        name: assetHint?.name ?? existing.assetHint?.name ?? initialSnapshot.asset.name,
      };
      return;
    }

    const initialState: AssetStreamState = {
      timer: setInterval(() => {
        void this.broadcastUpdate(assetId);
      }, this.pollIntervalMs),
      version: 1,
      previousMarkets: this.toMarketMap(initialSnapshot.markets),
      lastSource: initialSnapshot.source,
      assetHint: {
        symbol: assetHint?.symbol ?? initialSnapshot.asset.symbol,
        name: assetHint?.name ?? initialSnapshot.asset.name,
      },
    };

    this.assetStreams.set(assetId, initialState);
  }

  private async broadcastUpdate(assetId: string) {
    const state = this.assetStreams.get(assetId);

    if (!state) {
      return;
    }

    if (this.roomSize(assetId) === 0) {
      this.cleanupAssetStream(assetId);
      return;
    }

    const snapshot = await this.marketDiscoveryService.getMarkets(assetId, state.assetHint, { refreshDirectTickers: true });
    this.binanceLiveTickerService.registerAssetMarkets(assetId, snapshot.markets);
    const nextMarketMap = this.toMarketMap(snapshot.markets);
    const changes = this.diffMarkets(state.previousMarkets, nextMarketMap);

    if (changes.length === 0) {
      return;
    }

    state.version += 1;
    state.previousMarkets = nextMarketMap;
    state.lastSource = snapshot.source;
    this.marketOhlcvService.recordSnapshot(assetId, snapshot.markets, snapshot.source.fetchedAt);

    const payload: MarketUpdateEvent = {
      assetId,
      version: state.version,
      emittedAt: new Date().toISOString(),
      kind: 'update',
      source: snapshot.source,
      changes,
    };

    this.server.to(this.roomName(assetId)).emit('ticker_update', payload);
  }

  private emitSnapshot(assetId: string, snapshot: AssetMarketsResponse) {
    const state = this.assetStreams.get(assetId);

    if (!state) {
      return;
    }

    state.previousMarkets = this.toMarketMap(snapshot.markets);
    state.lastSource = snapshot.source;

    const payload: MarketSnapshotEvent = {
      assetId,
      version: state.version,
      emittedAt: new Date().toISOString(),
      kind: 'snapshot',
      data: snapshot,
    };

    this.server.to(this.roomName(assetId)).emit('ticker_snapshot', payload);
  }

  private cleanupAssetStream(assetId: string) {
    if (this.roomSize(assetId) > 0) {
      return;
    }

    const state = this.assetStreams.get(assetId);
    if (!state) {
      return;
    }

    clearInterval(state.timer);
    this.assetStreams.delete(assetId);
    this.binanceLiveTickerService.unregisterAssetMarkets(assetId);
  }

  private roomName(assetId: string) {
    return `asset:${assetId}`;
  }

  private roomSize(assetId: string) {
    return this.server.adapter.rooms.get(this.roomName(assetId))?.size ?? 0;
  }

  private handleBinanceTickerUpdate(event: BinanceTickerUpdateEvent) {
    const state = this.assetStreams.get(event.assetId);
    if (!state || this.roomSize(event.assetId) === 0) {
      return;
    }

    const previous = state.previousMarkets.get(event.marketId);
    if (!previous) {
      return;
    }

    const next: MarketTicker = {
      ...previous,
      lastPrice: event.ticker.lastPrice ?? previous.lastPrice,
      volume24hUsd: event.ticker.volume24hUsd ?? previous.volume24hUsd,
      lastTradedAt: event.ticker.lastTradedAt ?? previous.lastTradedAt,
      updatedAtLabel: this.formatUpdatedAtLabel(event.ticker.lastTradedAt ?? previous.lastTradedAt),
      source: event.ticker.source,
    };

    if (
      previous.lastPrice === next.lastPrice &&
      previous.volume24hUsd === next.volume24hUsd &&
      previous.lastTradedAt === next.lastTradedAt &&
      previous.updatedAtLabel === next.updatedAtLabel &&
      previous.source === next.source
    ) {
      return;
    }

    state.previousMarkets.set(event.marketId, next);
    state.version += 1;
    this.marketOhlcvService.recordSnapshot(event.assetId, [...state.previousMarkets.values()], new Date().toISOString());

    const payload: MarketUpdateEvent = {
      assetId: event.assetId,
      version: state.version,
      emittedAt: new Date().toISOString(),
      kind: 'update',
      source: state.lastSource,
      changes: [
        {
          marketId: event.marketId,
          rank: next.rank,
          lastPrice: next.lastPrice,
          volume24hUsd: next.volume24hUsd,
          spreadPct: next.spreadPct,
          trustScore: next.trustScore,
          lastTradedAt: next.lastTradedAt,
          updatedAtLabel: next.updatedAtLabel,
          source: next.source,
        },
      ],
    };

    this.server.to(this.roomName(event.assetId)).emit('ticker_update', payload);
  }

  private toMarketMap(markets: MarketTicker[]) {
    return new Map(markets.map((market) => [market.marketId, market]));
  }

  private diffMarkets(previousMarkets: Map<string, MarketTicker>, nextMarkets: Map<string, MarketTicker>) {
    const changes: MarketUpdateChange[] = [];

    for (const [marketId, next] of nextMarkets.entries()) {
      const previous = previousMarkets.get(marketId);

      if (!previous) {
        changes.push({
          marketId,
          rank: next.rank,
          lastPrice: next.lastPrice,
          volume24hUsd: next.volume24hUsd,
          spreadPct: next.spreadPct,
          trustScore: next.trustScore,
          lastTradedAt: next.lastTradedAt,
          updatedAtLabel: next.updatedAtLabel,
          source: next.source,
        });
        continue;
      }

      if (
        previous.rank !== next.rank ||
        previous.lastPrice !== next.lastPrice ||
        previous.volume24hUsd !== next.volume24hUsd ||
        previous.spreadPct !== next.spreadPct ||
        previous.trustScore !== next.trustScore ||
        previous.lastTradedAt !== next.lastTradedAt ||
        previous.updatedAtLabel !== next.updatedAtLabel ||
        previous.source !== next.source
      ) {
        changes.push({
          marketId,
          rank: next.rank,
          lastPrice: next.lastPrice,
          volume24hUsd: next.volume24hUsd,
          spreadPct: next.spreadPct,
          trustScore: next.trustScore,
          lastTradedAt: next.lastTradedAt,
          updatedAtLabel: next.updatedAtLabel,
          source: next.source,
        });
      }
    }

    return changes;
  }

  private formatUpdatedAtLabel(lastTradedAt: string | null) {
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

    return `${Math.floor(diffHours / 24)}일 전`;
  }
}
