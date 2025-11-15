import { config } from '../config.js';

interface PriceSnapshot {
  price: number;
  usingFallback: boolean;
  updatedAt: number;
}

const CACHE_TTL_MS = 60_000;
let snapshot: PriceSnapshot = {
  price: config.fallbackBtcPriceUsd,
  usingFallback: true,
  updatedAt: 0
};

async function fetchFromCoingecko(): Promise<number> {
  if (typeof fetch !== 'function') {
    throw new Error('global_fetch_unavailable');
  }
  const response = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { headers: { accept: 'application/json' }, keepalive: false }
  );
  if (!response.ok) {
    throw new Error(`coingecko_http_${response.status}`);
  }
  const payload = (await response.json()) as {
    bitcoin?: { usd?: number };
  };
  const price = payload.bitcoin?.usd;
  if (!price || !Number.isFinite(price)) {
    throw new Error('coingecko_invalid_payload');
  }
  return price;
}

export async function getBtcPriceUsd(): Promise<{ price: number; usingFallback: boolean }> {
  const now = Date.now();
  if (now - snapshot.updatedAt < CACHE_TTL_MS && snapshot.price) {
    return { price: snapshot.price, usingFallback: snapshot.usingFallback };
  }

  try {
    const price = await fetchFromCoingecko();
    snapshot = { price, usingFallback: false, updatedAt: now };
  } catch (error) {
    console.warn('[priceService] failed to fetch live BTC price, using fallback', {
      message: (error as Error)?.message
    });
    snapshot = {
      price: config.fallbackBtcPriceUsd,
      usingFallback: true,
      updatedAt: now
    };
  }
  return { price: snapshot.price, usingFallback: snapshot.usingFallback };
}
