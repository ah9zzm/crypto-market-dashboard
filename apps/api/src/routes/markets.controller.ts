import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { OhlcvTimeframe } from '@cmd/shared-types';
import { MarketDiscoveryService } from '../services/market-discovery.service';
import { MarketOhlcvService } from '../services/market-ohlcv.service';

@Controller('markets')
export class MarketsController {
  constructor(
    private readonly marketDiscoveryService: MarketDiscoveryService,
    private readonly marketOhlcvService: MarketOhlcvService,
  ) {}

  @Get()
  async getMarkets(@Query('asset') asset?: string) {
    if (!asset) {
      throw new BadRequestException('asset query parameter is required');
    }

    const payload = await this.marketDiscoveryService.getMarkets(asset);
    this.marketOhlcvService.recordSnapshot(payload.asset.id, payload.markets, payload.source.fetchedAt);
    return payload;
  }

  @Get('ohlcv')
  getOhlcv(
    @Query('asset') asset?: string,
    @Query('timeframe') timeframe?: OhlcvTimeframe,
    @Query('limit') limit?: string,
  ) {
    if (!asset) {
      throw new BadRequestException('asset query parameter is required');
    }

    const normalizedTimeframe = timeframe ?? 'tick';
    if (!['tick', '1m', '5m', '15m'].includes(normalizedTimeframe)) {
      throw new BadRequestException('timeframe must be one of tick, 1m, 5m, 15m');
    }

    const normalizedLimit = limit ? Number(limit) : 120;
    return this.marketOhlcvService.getAssetOhlcv(asset, normalizedTimeframe, Number.isFinite(normalizedLimit) ? normalizedLimit : 120);
  }
}
