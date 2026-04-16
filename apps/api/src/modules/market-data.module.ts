import { Module } from '@nestjs/common';
import { AssetsController } from '../routes/assets.controller';
import { MarketsController } from '../routes/markets.controller';
import { AssetDiscoveryService } from '../services/asset-discovery.service';
import { BinanceLiveTickerService } from '../services/binance-live-ticker.service';
import { CexDirectTickerService } from '../services/cex-direct-ticker.service';
import { CoinGeckoService } from '../services/coingecko.service';
import { FundingRateService } from '../services/funding-rate.service';
import { MarketDiscoveryService } from '../services/market-discovery.service';
import { FuturesDirectTickerService } from '../services/futures-direct-ticker.service';
import { MarketMapperService } from '../services/market-mapper.service';
import { MarketOhlcvService } from '../services/market-ohlcv.service';
import { SimpleMemoryCacheService } from '../services/simple-memory-cache.service';
import { MarketGateway } from '../ws/market.gateway';

@Module({
  controllers: [AssetsController, MarketsController],
  providers: [
    AssetDiscoveryService,
    BinanceLiveTickerService,
    CexDirectTickerService,
    CoinGeckoService,
    FundingRateService,
    FuturesDirectTickerService,
    MarketDiscoveryService,
    MarketMapperService,
    MarketOhlcvService,
    MarketGateway,
    SimpleMemoryCacheService,
  ],
})
export class MarketDataModule {}
