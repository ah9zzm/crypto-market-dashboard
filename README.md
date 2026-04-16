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
npm run dev
```

Windows 에서는 [run-dev.bat](/D:/Projects/crypto-market-dashboard/run-dev.bat) 를 더블클릭해서 실행해도 됩니다.
종료는 [stop-dev.bat](/D:/Projects/crypto-market-dashboard/stop-dev.bat) 를 더블클릭하면 됩니다.
