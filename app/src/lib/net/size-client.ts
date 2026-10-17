import type { SizeState } from "./protocol";

type Grid = { cols: number; rows: number };
/** Control requests are never put in the connection's offline send queue. */
export class SizeClient {
  states = new Map<string, SizeState>();
  private sizes = new Map<string, Grid>();
  private attempted = new Set<string>();
  private busy = new Set<string>();
  private listeners = new Set<(s: SizeState) => void>();
  constructor(private rpc: (method: string, params: unknown) => Promise<unknown>,
    private ready: () => boolean, private scope: string) {}
  private key(s: string): string { return `ps.sizeReleased:${this.scope}:${this.states.get(s)?.window ?? s}`; }
  private released(s: string): boolean { try { return localStorage.getItem(this.key(s)) === "1"; } catch { return false; } }
  private markReleased(s: string, released: boolean): void {
    try { if (released) localStorage.setItem(this.key(s), "1"); else localStorage.removeItem(this.key(s)); } catch { /* private mode */ }
  }
  accept(s: SizeState): void {
    const old = this.states.get(s.sessionId);
    this.states.set(s.sessionId, s);
    if (JSON.stringify(old) !== JSON.stringify(s)) for (const cb of this.listeners) cb(s);
  }
  on(cb: (s: SizeState) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private async call(op: string, session: string, params: object = {}): Promise<SizeState> {
    if (!this.ready()) throw new Error("offline");
    const state = await this.rpc(`term.size.${op}`, { session, ...params }) as SizeState;
    this.accept(state); return state;
  }
  measured(session: string, cols: number, rows: number): void {
    this.sizes.set(session, { cols, rows });
    if (!this.states.has(session)) void this.refresh(session).catch(() => {});
  }
  async refresh(session: string): Promise<void> {
    if (!this.ready() || this.busy.has(session)) return;
    this.busy.add(session);
    try {
      const previous = this.states.get(session);
      const s = previous?.token
        ? await this.call("renew", session, { token: previous.token })
        : await this.call("status", session);
      const size = this.sizes.get(session);
      if (!this.attempted.has(session) && size) {
        this.attempted.add(session);
        if (!this.released(session) && s.controller === "none" && !s.blocked) {
          await this.call("acquire", session, { revision: s.revision, force: false, ...size });
        }
      }
    } finally { this.busy.delete(session); }
  }
  async acquire(session: string): Promise<void> {
    if (this.busy.has(session)) return;
    const s = this.states.get(session), size = this.sizes.get(session);
    if (!s || !size) return;
    this.busy.add(session); this.attempted.add(session);
    try {
      const next = await this.call("acquire", session, { revision: s.revision, force: true, ...size });
      if (next.controller === "self") this.markReleased(session, false);
    } finally { this.busy.delete(session); }
  }
  async release(session: string): Promise<void> {
    if (this.busy.has(session)) return;
    this.markReleased(session, true); this.attempted.add(session);
    const token = this.states.get(session)?.token;
    if (token) await this.call("release", session, { token });
  }
  rename(session: string, name: string): void {
    const state = this.states.get(session), size = this.sizes.get(session);
    this.states.delete(session); this.sizes.delete(session);
    if (state) this.accept({ ...state, sessionId: name });
    if (size) this.sizes.set(name, size);
    if (this.attempted.delete(session)) this.attempted.add(name);
  }
  async migrate(session: string): Promise<void> {
    const s = this.states.get(session);
    if (s) await this.call("migrate", session, { window: s.window, revision: s.revision });
  }
}
