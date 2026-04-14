import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AssetDiscoveryService } from '../services/asset-discovery.service';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assetDiscoveryService: AssetDiscoveryService) {}

  @Get('search')
  async searchAssets(@Query('q') q?: string) {
    if (!q) {
      throw new BadRequestException('q query parameter is required');
    }

    return this.assetDiscoveryService.searchAssets(q);
  }
}
