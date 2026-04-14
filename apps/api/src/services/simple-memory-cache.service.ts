import { Injectable } from '@nestjs/common';

interface CacheEntry<T> {
  value: T;
  fetchedAt: string;
  expiresAt: number;
  staleUntil: number;
}

@Injectable()
export class SimpleMemoryCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries = 250;

  getFresh<T>(key: string): CacheEntry<T> | null {
    this.prune();

    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      return null;
    }

    return entry;
  }

  getStale<T>(key: string): CacheEntry<T> | null {
    this.prune();

    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.staleUntil) {
      this.store.delete(key);
      return null;
    }

    return entry;
  }

  set<T>(key: string, value: T, ttlMs: number, staleTtlMs = ttlMs * 10): CacheEntry<T> {
    this.prune();

    const now = Date.now();
    const entry: CacheEntry<T> = {
      value,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
      staleUntil: now + Math.max(staleTtlMs, ttlMs),
    };

    this.store.set(key, entry);
    this.evictOverflow();
    return entry;
  }

  private prune() {
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.staleUntil) {
        this.store.delete(key);
      }
    }
  }

  private evictOverflow() {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.store.delete(oldestKey);
    }
  }
}
