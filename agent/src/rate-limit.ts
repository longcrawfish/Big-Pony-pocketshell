// A8 RateLimiter — per-IP fixed-window failure counter with lockout: a window
// starts at the first failure and resets once windowMs elapses (not a true
// sliding window). In-memory only, bounded to 10,000 source addresses.
// Injected clock for tests.
export interface RateLimiter { record(ip: string): void; isLocked(ip: string): boolean; }

interface Entry { count: number; windowStart: number; lockedUntil: number; }

export function createRateLimiter(opts: {
  windowMs?: number; maxFailures?: number; lockMs?: number;
  now: () => number; onLock?: (ip: string) => void;
}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxFailures = opts.maxFailures ?? 10;
  const lockMs = opts.lockMs ?? 300_000;
  const map = new Map<string, Entry>();
  return {
    record(ip) {
      if (!ip) return;
      const t = opts.now();
      for (const [key, entry] of map) if (t > Math.max(entry.lockedUntil, entry.windowStart + windowMs)) map.delete(key);
      // Bound storage even under many distinct source addresses.
      if (!map.has(ip) && map.size >= 10000) map.delete(map.keys().next().value!);
      let e = map.get(ip);
      if (e && e.lockedUntil > t) return;
      if (!e || t - e.windowStart > windowMs) { e = { count: 0, windowStart: t, lockedUntil: 0 }; map.set(ip, e); }
      e.count++;
      if (e.count >= maxFailures && e.lockedUntil <= t) {
        e.lockedUntil = t + lockMs;
        opts.onLock?.(ip);
      }
    },
    isLocked(ip) {
      const e = map.get(ip);
      if (!e) return false;
      return e.lockedUntil > opts.now();
    },
  };
}
