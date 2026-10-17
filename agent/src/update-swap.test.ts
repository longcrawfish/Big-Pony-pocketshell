import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapAndRestart } from "./update-swap";

for (const scenario of ["success", "restart-failure", "backup-failure"]) {
  test(`isolated upgrade ${scenario}: identity and usable binary retained`, () => {
    const root = mkdtempSync(join(tmpdir(), "ps-upgrade-"));
    try {
      const target = join(root, "agent"), next = join(root, ".new"), key = join(root, "agent_key");
      writeFileSync(target, "old-version"); writeFileSync(next, "new-version"); writeFileSync(key, "unchanged-identity");
      if (scenario === "backup-failure") mkdirSync(`${target}.prev`);
      const action = () => swapAndRestart(next, target, () => { if (scenario === "restart-failure") throw new Error("restart failed"); });
      if (scenario === "success") action(); else expect(action).toThrow();
      expect(readFileSync(target, "utf8")).toBe(scenario === "success" ? "new-version" : "old-version");
      expect(readFileSync(key, "utf8")).toBe("unchanged-identity");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
