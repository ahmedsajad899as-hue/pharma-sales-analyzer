// Global in-memory API cache with stale-while-revalidate support
// Data survives page navigation (pages use display:none, not unmount)
// but this also helps if pages ever re-mount.

interface CacheEntry {
  data: any;
  ts: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL = 3 * 60 * 1000; // 3 minutes — treat data as fresh

export function getCached(url: string): any | null {
  const entry = CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL) { CACHE.delete(url); return null; }
  return entry.data;
}

export function setCached(url: string, data: any): void {
  CACHE.set(url, { data, ts: Date.now() });
}

export function invalidateCache(pattern?: string): void {
  if (!pattern) { CACHE.clear(); return; }
  for (const k of CACHE.keys()) {
    if (k.includes(pattern)) CACHE.delete(k);
  }
}

/**
 * Fetch with stale-while-revalidate:
 * - If cache hit → return cached data immediately, refresh in background
 * - If cache miss → fetch, store, return
 * - onUpdate: called with fresh data after background refresh completes
 */
export async function cachedFetch(
  url: string,
  options: RequestInit,
  onUpdate?: (freshData: any) => void,
): Promise<any> {
  const cached = getCached(url);

  if (cached !== null) {
    // Return stale data instantly, refresh in background
    if (onUpdate) {
      fetch(url, options)
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
        .then(fresh => { setCached(url, fresh); onUpdate(fresh); })
        .catch(() => {/* background refresh failed — keep stale data */});
    }
    return cached;
  }

  // No cache — fetch and block until done
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  setCached(url, data);
  return data;
}
