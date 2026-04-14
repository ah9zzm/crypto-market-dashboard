import { Module } from '@nestjs/common';
import { HealthController } from '../routes/health.controller';
import { MarketDataModule } from './market-data.module';

@Module({
  imports: [MarketDataModule],
  controllers: [HealthController],
})
export class AppModule {}
