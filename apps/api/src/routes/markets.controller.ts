import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { OhlcvTimeframe } from '@cmd/shared-types';
import { FundingRateService } from '../services/funding-rate.service';
import { MarketDiscoveryService } from '../services/market-discovery.service';
import { MarketOhlcvService } from '../services/market-ohlcv.service';

@Controller('markets')
export class MarketsController {
  constructor(
    private readonly marketDiscoveryService: MarketDiscoveryService,
    private readonly marketOhlcvService: MarketOhlcvService,
    private readonly fundingRateService: FundingRateService,
  ) {}

  @Get()
  async getMarkets(
    @Query('asset') asset?: string,
    @Query('symbol') symbol?: string,
    @Query('name') name?: string,
  ) {
    if (!asset) {
      throw new BadRequestException('asset query parameter is required');
    }

    const payload = await this.marketDiscoveryService.getMarkets(asset, { symbol, name });
    this.marketOhlcvService.recordSnapshot(payload.asset.id, payload.markets, payload.source.fetchedAt);
    return payload;
  }

  @Get('ohlcv')
  async getOhlcv(
    @Query('asset') asset?: string,
    @Query('timeframe') timeframe?: OhlcvTimeframe,
    @Query('limit') limit?: string,
  ) {
    if (!asset) {
      throw new BadRequestException('asset query parameter is required');
    }

    const normalizedTimeframe = timeframe ?? 'tick';
    if (!['tick', '1m', '5m', '15m', '1h', '4h', '1d', '1M'].includes(normalizedTimeframe)) {
      throw new BadRequestException('timeframe must be one of tick, 1m, 5m, 15m, 1h, 4h, 1d, 1M');
    }

    const normalizedLimit = limit ? Number(limit) : 120;
    return this.marketOhlcvService.getAssetOhlcv(asset, normalizedTimeframe, Number.isFinite(normalizedLimit) ? normalizedLimit : 120);
  }

  @Get('funding')
  async getFundingRates(
    @Query('asset') asset?: string,
    @Query('symbol') symbol?: string,
    @Query('name') name?: string,
    @Query('limit') limit?: string,
  ) {
    if (!asset) {
      throw new BadRequestException('asset query parameter is required');
    }

    const normalizedLimit = limit ? Number(limit) : 90;
    return this.fundingRateService.getAssetFundingRates(asset, { symbol, name }, Number.isFinite(normalizedLimit) ? normalizedLimit : 90);
  }
}
