const assetId = process.env.MARKET_ASSET_ID ?? 'bitcoin';
const intervalMs = Number(process.env.WORKER_LOG_INTERVAL_MS ?? 15000);

async function fetchSnapshot() {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(assetId)}/tickers?include_exchange_logo=false&page=1`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`CoinGecko returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    name?: string;
    symbol?: string;
    tickers?: Array<{ market?: { name?: string }; base?: string; target?: string; converted_volume?: { usd?: number } }>;
  };

  const topMarkets = [...(payload.tickers ?? [])]
    .sort((left, right) => (right.converted_volume?.usd ?? 0) - (left.converted_volume?.usd ?? 0))
    .slice(0, 3)
    .map((ticker) => `${ticker.market?.name ?? 'Unknown'} ${ticker.base ?? '?'} / ${ticker.target ?? '?'} $${Math.round(ticker.converted_volume?.usd ?? 0).toLocaleString()}`);

  console.log(`[worker] ${payload.name ?? assetId} (${payload.symbol?.toUpperCase() ?? assetId.toUpperCase()}) top markets:`);
  for (const entry of topMarkets) {
    console.log(`  - ${entry}`);
  }
}

console.log('market worker booted');
console.log(`tracking asset: ${assetId}`);
console.log('next step: replace CoinGecko polling with ccxt/ccxt.pro exchange connectors');

const run = async () => {
  try {
    await fetchSnapshot();
  } catch (error) {
    console.error('[worker] snapshot fetch failed', error);
  }
};

void run();
setInterval(() => {
  void run();
}, intervalMs);
