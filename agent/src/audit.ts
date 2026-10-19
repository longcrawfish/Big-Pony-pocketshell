// A9 Audit — structured JSONL of security events. Injected writer for tests;
// file writer appends to <keyDir>/audit.log (0600). No command/terminal I/O.
import { appendFileSync, statSync, renameSync } from "node:fs";

export type AuditEvent =
  | "handshake_ok"
  | "handshake_fail"
  | "pair_ok"
  | "pair_fail"
  | "connect"
  | "disconnect"
  | "revoke"
  | "ratelimit_lock"
  | "operation";
export interface AuditEntry { ts: string; event: AuditEvent; pub?: string | null; ip?: string; reason?: string; detail?: unknown; }
export interface Audit { log(e: Omit<AuditEntry, "ts">): void; }

export function fileAuditWriter(file: string): (line: string) => void {
  return (line) => {
    try {
      let size = 0;
      try { size = statSync(file).size; } catch {}
      if (size >= 5 * 1024 * 1024) renameSync(file, file + ".1");
      // Preserve valid JSON even when metadata exceeds the record budget.
      const bounded = line.length <= 8192 ? line : JSON.stringify({ event: "audit_truncated", ts: new Date().toISOString() });
      appendFileSync(file, bounded + "\n", { mode: 0o600 });
    } catch { console.warn("[pocketshell] audit unavailable"); } // logging must not crash authentication
  };
}

export function createAudit(opts: { write?: (line: string) => void; now?: () => number }): Audit {
  const now = opts.now ?? (() => Date.now());
  const write = opts.write ?? ((l: string) => process.stdout.write(l + "\n"));
  return {
    log(e) {
      const entry: AuditEntry = { ts: new Date(now()).toISOString(), ...e };
      // drop undefined optionals for clean JSON
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) if (v !== undefined) clean[k] = v;
      write(JSON.stringify(clean));
    },
  };
}
