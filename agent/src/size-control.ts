import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TmuxRunner } from "./terminal";
import { isSaneSize } from "./sane-size";
import type { SizeState } from "./protocol";

const MARKER = "@pocketshell-size-owner";
const POLICIES = ["manual", "latest", "largest", "smallest"];
export const SIZE_LEASE_MS = 45_000;
export const SIZE_GRACE_MS = 30_000;
type Grid = { cols: number; rows: number };
type Window = Grid & { identity: string; id: string; policy: string; effective: string; marker: string; pane: Grid };
type RecordEntry = {
  identity: string; id: string; policy: string; manual: boolean; original: Grid;
  marker: string; expected: Grid[];
};
export type SizeActor = { device: string; connection: string };
type Lease = { actor: SizeActor; token: string; expires: number };

/** Synchronous transactions serialize all callers. Disk journal precedes every
 * tmux mutation; a capability is bound to both Noise identity and connection. */
export class SizeControl {
  private records = new Map<string, RecordEntry>();
  private leases = new Map<string, Lease>();
  private observed = new Map<string, string>();
  private revisions = new Map<string, string>();
  private attempted = new Set<string>();
  private blocked = false;
  constructor(private tmux: TmuxRunner, private file: string, private now = Date.now) {
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("invalid journal");
        for (const r of data.records) {
          if (!r || typeof r.identity !== "string" || !/^@\d+$/.test(r.id) ||
              !["", ...POLICIES].includes(r.policy) || typeof r.manual !== "boolean" || typeof r.marker !== "string" ||
              !/^[a-f0-9-]{36}$/.test(r.marker) || !this.grid(r.original) ||
              !Array.isArray(r.expected) || !r.expected.length || !r.expected.every((v: Grid) => this.grid(v))) {
            throw new Error("invalid journal record");
          }
          this.records.set(r.identity, r);
        }
      } catch {
        // Never overwrite evidence or infer an original policy from corrupt data.
        this.blocked = true;
        console.error("[pocketshell] Invalid size-control journal; size changes disabled:", file);
      }
    }
    if (!this.blocked) this.recover();
  }
  private grid(v: Grid): boolean {
    return !!v && Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols > 0 && v.rows > 0 && v.cols <= 10000 && v.rows <= 10000;
  }
  private run(args: string[]): string {
    const r = this.tmux(args);
    if (r.exitCode !== 0) throw new Error("tmux size operation failed");
    return new TextDecoder().decode(r.stdout).trim();
  }
  private window(target: string): Window {
    const raw = this.run(["display-message", "-p", "-t", target,
      "#{pid}|#{start_time}|#{socket_path}|#{window_id}|#{window_width}|#{window_height}|#{pane_width}|#{pane_height}"]);
    const [pid, start, socket, id, cols, rows, pc, pr] = raw.split("|");
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(start) || !/^@\d+$/.test(id)) throw new Error("invalid tmux identity");
    // Socket inode + server birth time protect against restart/PID/window-ID reuse.
    const st = statSync(socket);
    const identity = `${socket}:${st.ino}:${st.ctimeMs}:${pid}:${start}:${id}`;
    return { identity, id, cols: +cols, rows: +rows, pane: { cols: +pc, rows: +pr },
      policy: this.run(["show-options", "-wv", "-t", id, "window-size"]),
      effective: this.run(["show-options", "-Awv", "-t", id, "window-size"]),
      marker: this.run(["show-options", "-wqv", "-t", id, MARKER]) };
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, records: [...this.records.values()] }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, this.file);
    const dir = openSync(dirname(this.file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  private revision(identity: string): string {
    if (!this.revisions.has(identity)) this.bump(identity);
    return this.revisions.get(identity)!;
  }
  private bump(identity: string): void { this.revisions.set(identity, crypto.randomUUID()); }
  private same(a: Grid, b: Grid): boolean { return a.cols === b.cols && a.rows === b.rows; }
  private ours(w: Window, r: RecordEntry): boolean {
    return w.identity === r.identity && w.marker === r.marker && w.policy === "manual" && r.expected.some(g => this.same(g, w));
  }
  private forget(identity: string): void {
    this.records.delete(identity); this.leases.delete(identity); this.bump(identity); this.save();
  }
  private restore(r: RecordEntry): void {
    let w: Window;
    try { w = this.window(r.id); }
    catch {
      // A successful inventory can prove deletion; a failed probe cannot.
      const ids = this.run(["list-windows", "-a", "-F", "#{window_id}"]).split("\n");
      if (!ids.includes(r.id)) this.forget(r.identity);
      return;
    }
    if (this.ours(w, r)) {
      if (r.manual) {
        r.expected.push(r.original); this.save();
        this.run(["resize-window", "-t", r.id, "-x", String(r.original.cols), "-y", String(r.original.rows)]);
      }
      if (r.policy) this.run(["set-option", "-w", "-t", r.id, "window-size", r.policy]);
      else this.run(["set-option", "-wu", "-t", r.id, "window-size"]);
    }
    // Policy/size/marker changes made outside this agent win. Never resize them.
    if (w.identity === r.identity && w.marker === r.marker) this.run(["set-option", "-wu", "-t", r.id, MARKER]);
    this.forget(r.identity);
  }
  recover(): void {
    for (const r of [...this.records.values()]) {
      try { this.restore(r); } catch { /* retain record for retry, never overwrite it */ }
    }
  }
  tick(): void {
    for (const [identity, lease] of this.leases) {
      if (lease.expires <= this.now()) {
        // Invalidate capability before attempting any recovery I/O.
        this.leases.delete(identity); this.bump(identity);
        const r = this.records.get(identity);
        if (r) try { this.restore(r); } catch { /* retry below */ }
      }
    }
    for (const r of [...this.records.values()]) {
      if (!this.leases.has(r.identity)) try { this.restore(r); } catch { /* next tick */ }
    }
  }
  status(session: string, actor: SizeActor): SizeState {
    let w = this.window(`=${session}:`);
    const fingerprint = JSON.stringify([w.policy, w.effective, w.cols, w.rows, w.marker]);
    if (this.observed.has(w.identity) && this.observed.get(w.identity) !== fingerprint) this.bump(w.identity);
    this.observed.set(w.identity, fingerprint);
    let r = this.records.get(w.identity);
    if (r && this.leases.has(w.identity) && !this.ours(w, r)) {
      this.restore(r);
      w = this.window(`=${session}:`);
      r = this.records.get(w.identity);
    }
    const l = this.leases.get(w.identity);
    const mine = !!l && l.actor.device === actor.device && l.actor.connection === actor.connection;
    return { sessionId: session, window: w.identity, revision: this.revision(w.identity),
      cols: w.pane.cols, rows: w.pane.rows, policy: w.policy || "inherit", effective: w.effective,
      controller: l ? (mine ? "self" : "other") : "none", token: mine ? l!.token : undefined,
      blocked: this.blocked || (!!r && !l) };
  }
  acquire(session: string, actor: SizeActor, revision: string, force: boolean, cols: number, rows: number): SizeState {
    this.tick();
    if (this.blocked || !isSaneSize(cols, rows)) throw new Error("size control unavailable");
    const w = this.window(`=${session}:`);
    const key = `${actor.device}:${w.identity}`;
    const state = this.status(session, actor);
    if (state.revision !== revision) return state; // stale acquire cannot reclaim
    if (!force && (this.attempted.has(key) || this.leases.has(w.identity))) return state;
    if (this.records.has(w.identity) && !this.leases.has(w.identity)) throw new Error("size recovery pending");
    this.attempted.add(key);
    let record = this.records.get(w.identity);
    if (!record) {
      if (!["", ...POLICIES].includes(w.policy)) throw new Error("unknown window policy");
      record = { identity: w.identity, id: w.id, policy: w.policy, manual: w.effective === "manual", original: { cols: w.cols, rows: w.rows },
        marker: crypto.randomUUID(), expected: [{ cols: w.cols, rows: w.rows }, { cols, rows }] };
      this.records.set(w.identity, record);
      try { this.save(); } catch (e) { this.records.delete(w.identity); throw e; }
      this.run(["set-option", "-w", "-t", w.id, MARKER, record.marker]);
    }
    const lease = { actor, token: crypto.randomUUID(), expires: this.now() + SIZE_LEASE_MS };
    this.leases.set(w.identity, lease); this.bump(w.identity);
    try { this.apply(record, cols, rows); }
    catch (e) { this.leases.delete(w.identity); throw e; }
    return this.status(session, actor);
  }
  private apply(r: RecordEntry, cols: number, rows: number): void {
    const w = this.window(r.id);
    // Journal both crash boundaries before invoking resize-window.
    r.expected = [{ cols: w.cols, rows: w.rows }, { cols, rows }];
    this.save();
    this.run(["resize-window", "-t", r.id, "-x", String(cols), "-y", String(rows)]);
    r.expected = [{ cols, rows }]; this.save();
  }
  private authorized(session: string, actor: SizeActor, token: unknown): { w: Window; r: RecordEntry; l: Lease } | null {
    this.tick();
    const w = this.window(`=${session}:`), l = this.leases.get(w.identity), r = this.records.get(w.identity);
    if (!l || !r || l.token !== token || l.actor.device !== actor.device || l.actor.connection !== actor.connection) return null;
    if (!this.ours(w, r)) { this.restore(r); return null; }
    return { w, r, l };
  }
  resize(session: string, actor: SizeActor, token: unknown, cols: number, rows: number): boolean {
    if (!isSaneSize(cols, rows)) return false;
    const a = this.authorized(session, actor, token);
    if (!a) return false;
    if (!this.same(a.w, { cols, rows })) this.apply(a.r, cols, rows);
    a.l.expires = this.now() + SIZE_LEASE_MS;
    return true;
  }
  redraw(session: string, actor: SizeActor, token: unknown): boolean {
    const a = this.authorized(session, actor, token);
    if (!a || a.w.cols <= 20) return false;
    this.apply(a.r, a.w.cols - 1, a.w.rows);
    this.apply(a.r, a.w.cols, a.w.rows);
    return true;
  }
  release(session: string, actor: SizeActor, token: unknown): SizeState {
    const a = this.authorized(session, actor, token);
    if (a) { this.leases.delete(a.w.identity); this.restore(a.r); }
    return this.status(session, actor);
  }
  renew(session: string, actor: SizeActor, token: unknown): SizeState {
    this.tick();
    const w = this.window(`=${session}:`), l = this.leases.get(w.identity);
    // Resume requires the unguessable capability AND the authenticated device.
    if (l && l.token === token && l.actor.device === actor.device) {
      if (l.actor.connection !== actor.connection) l.token = crypto.randomUUID();
      l.actor = actor; l.expires = this.now() + SIZE_LEASE_MS;
    }
    return this.status(session, actor);
  }
  grace(actor: SizeActor, session?: string): void {
    let identity: string | undefined;
    if (session) { try { identity = this.window(`=${session}:`).identity; } catch { return; } }
    for (const [key, l] of this.leases) {
      if ((!identity || key === identity) && l.actor.connection === actor.connection && l.actor.device === actor.device) {
        l.expires = Math.min(l.expires, this.now() + SIZE_GRACE_MS);
      }
    }
  }
  migrate(session: string, actor: SizeActor, identity: string, revision: string): SizeState {
    const s = this.status(session, actor);
    if (s.blocked || s.window !== identity || s.revision !== revision || s.controller !== "none" || s.policy !== "manual") {
      throw new Error("window changed or controlled; inspect it again");
    }
    const w = this.window(`=${session}:`);
    this.run(["set-option", "-wu", "-t", w.id, "window-size"]);
    this.bump(w.identity);
    return this.status(session, actor);
  }
  dispose(): void { this.leases.clear(); this.recover(); }
}
