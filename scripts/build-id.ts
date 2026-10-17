import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Dirty development bundles must never reuse a committed service-worker key. */
export function buildId(root: string): string {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    const sha = git("rev-parse", "--short", "HEAD");
    const status = git("status", "--porcelain");
    if (!status) return sha;
    const hash = createHash("sha256").update(git("diff", "HEAD", "--binary"));
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
    for (const file of untracked.split("\0").filter(Boolean).sort()) {
      hash.update(file).update(readFileSync(resolve(root, file)));
    }
    return `${sha}-dirty-${hash.digest("hex").slice(0, 12)}`;
  } catch { return ""; }
}
