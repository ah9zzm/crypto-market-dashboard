import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app.module';

async function bootstrap() {
  const environment = process.env.NODE_ENV ?? 'development';
  const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const isAllowedDevOrigin = (origin: string) => {
    try {
      const parsed = new URL(origin);
      const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      const hasValidPort = parsed.port.length > 0;
      return isLocalHost && hasValidPort;
    } catch {
      return false;
    }
  };

  const isAllowedOrigin = (origin?: string) => {
    if (!origin) {
      return true;
    }

    if (environment !== 'production' && isAllowedDevOrigin(origin)) {
      return true;
    }

    return allowedOrigins.includes(origin);
  };

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
  });

  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api`);
}

bootstrap();
