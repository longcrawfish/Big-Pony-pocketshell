import { test, expect } from "bun:test";
import { isFresh, writeCache, readCache } from "./update-cache";
import { mkdtempSync, rmSync } from "node:fs";
import { RPC_TABLE } from "./rpc-router";
import { AGENT_VERSION } from "./version";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isFresh within TTL", () => {
  const c = { checkedAt: 1000 } as any;
  expect(isFresh(c, 1000 + 60_000, 6 * 3600_000)).toBe(true);
  expect(isFresh(c, 1000 + 7 * 3600_000, 6 * 3600_000)).toBe(false);
  expect(isFresh(null, 0, 1)).toBe(false);
});

test("write then read round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "psc-"));
  const val = { current: "0.3.0", latest: "0.4.0", hasUpdate: true, notes: "n", publishedAt: null, canApply: true, checkedAt: 42 };
  writeCache(dir, val as any);
  expect(readCache(dir)).toEqual(val as any);
});

for (const stale of ["version", "repository"]) {
  test(`update.check ignores cached ${stale} after binary/config replacement`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-cache-version-"));
    try {
      writeCache(dir, { current: stale === "version" ? "0.0.1" : AGENT_VERSION,
        repo: stale === "repository" ? "different/repo" : null,
        latest: "99.0.0", hasUpdate: true, notes: "stale", publishedAt: null, canApply: true, checkedAt: Date.now() });
      const result: any = await new Promise((resolve, reject) => {
        RPC_TABLE["update.check"]({ config: { keyDir: dir, update: { repo: null } },
          sendResult: resolve, sendError: (_: string, message: string) => reject(new Error(message)) } as any, {});
      });
      expect(result.current).toBe(AGENT_VERSION);
      expect(result.reason).toBe("disabled");
      expect(result.hasUpdate).toBe(false);
      expect(readCache(dir)?.repo).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
