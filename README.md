# crypto-market-dashboard

실시간 코인 거래소 비교 대시보드 모노레포입니다.

## Workspace
- apps/web: Next.js 프론트엔드
- apps/api: NestJS API + WebSocket gateway
- apps/worker: 마켓 데이터 수집 워커
- packages/shared-types: 공통 타입

## Quick start
```bash
npm install
npm run dev:api
npm run dev:web
npm run dev:worker
```
