import { beforeEach, test, expect, vi } from "vitest";
import { SizeClient } from "./size-client";
import type { SizeState } from "./protocol";

const initial: SizeState = { sessionId: "work", window: "server:@0", revision: "1", cols: 80, rows: 24,
  policy: "inherit", effective: "latest", controller: "none", blocked: false };
beforeEach(() => localStorage.clear());
function fixture() {
  let state = { ...initial };
  let online = true;
  const rpc = vi.fn(async (method: string, p: any) => {
    if (method.endsWith("acquire")) state = { ...state, controller: "self", token: "cap", revision: "2" };
    if (method.endsWith("release")) state = { ...state, controller: "none", token: undefined, revision: "3" };
    return state;
  });
  const client = new SizeClient(rpc, () => online, "agent-test");
  return { client, rpc, set(s: SizeState) { state = s; }, offline() { online = false; } };
}
test("automatically acquire once; release persists across a new client and refits", async () => {
  const f = fixture();
  f.client.measured("work", 40, 12);
  await vi.waitFor(() => expect(f.client.states.get("work")?.controller).toBe("self"));
  await f.client.release("work");
  f.client.measured("work", 50, 20);
  await f.client.refresh("work");
  expect(f.rpc.mock.calls.filter(([m]) => m.endsWith("acquire"))).toHaveLength(1);
  const fresh = fixture();
  fresh.client.measured("work", 40, 12);
  await vi.waitFor(() => expect(fresh.client.states.has("work")).toBe(true));
  expect(fresh.rpc.mock.calls.some(([m]) => m.endsWith("acquire"))).toBe(false);
  await fresh.client.acquire("work");
  expect(fresh.client.states.get("work")?.controller).toBe("self");
});
test("a competing controller is observed, never automatically displaced", async () => {
  const f = fixture(); f.set({ ...initial, controller: "other" });
  f.client.measured("work", 40, 12);
  await vi.waitFor(() => expect(f.client.states.has("work")).toBe(true));
  f.set(initial); await f.client.refresh("work");
  expect(f.rpc.mock.calls.some(([m]) => m.endsWith("acquire"))).toBe(false);
});
test("offline control actions never reach the ordinary RPC queue", async () => {
  const f = fixture(); f.offline();
  f.client.measured("work", 40, 12); await f.client.refresh("work");
  expect(f.rpc).not.toHaveBeenCalled();
});
test("reconnect resumes using the capability; state changes notify only once", async () => {
  const f = fixture(), callback = vi.fn();
  f.client.on(callback);
  f.client.accept({ ...initial, controller: "self", token: "old" });
  f.set({ ...initial, controller: "self", token: "new" });
  await f.client.refresh("work");
  expect(f.rpc).toHaveBeenCalledWith("term.size.renew", { session: "work", token: "old" });
  const count = callback.mock.calls.length;
  f.client.accept(f.client.states.get("work")!);
  expect(callback).toHaveBeenCalledTimes(count);
});
