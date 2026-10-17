import { copyFileSync, renameSync } from "node:fs";

/** Candidate has already passed checksum, signature and version checks.
 * Never replace a working binary without a usable rollback copy. */
export function swapAndRestart(candidate: string, target: string, restart: () => void): void {
  const backup = `${target}.prev`;
  copyFileSync(target, backup); // Failure must abort before the atomic swap.
  renameSync(candidate, target);
  try { restart(); }
  catch (e) {
    renameSync(backup, target);
    throw e;
  }
}
