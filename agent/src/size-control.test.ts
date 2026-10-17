import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTmux, TerminalService } from "./terminal";
import { SizeControl, SIZE_GRACE_MS, SIZE_LEASE_MS } from "./size-control";

const a = { device: "paired-a", connection: "tab-a" };
const b = { device: "paired-b", connection: "tab-b" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ps-size-"));
  const socket = join(root, "socket");
  const runner = (args: string[]) => runTmux(args, socket);
  const run = (...args: string[]) => {
    const r = runner(args);
    if (r.exitCode) throw new Error(new TextDecoder().decode(r.stderr));
    return new TextDecoder().decode(r.stdout).trim();
  };
  run("new-session", "-d", "-s", "sample", "-x", "100", "-y", "35");
  let time = 1000;
  const file = join(root, "keys", "size.json");
  const control = new SizeControl(runner, file, () => time);
  const acquire = (actor = a, force = false) => control.acquire("sample", actor, control.status("sample", actor).revision, force, 40, 12);
  return { root, socket, runner, run, file, control, acquire,
    advance(ms: number) { time += ms; control.tick(); },
    clean() { control.dispose(); runner(["kill-server"]); rmSync(root, { recursive: true, force: true }); } };
}

for (const policy of ["inherit", "latest", "largest", "smallest", "manual"]) {
  test(`real tmux: ${policy} policy and manual grid round trip`, () => {
    const f = fixture();
    try {
      if (policy !== "inherit") f.run("set-option", "-w", "-t", "sample", "window-size", policy);
      const before = f.run("display-message", "-p", "-t", "sample", "#{window_width}x#{window_height}");
      const s = f.acquire();
      expect(s.controller).toBe("self"); expect(s.cols).toBe(40);
      expect(f.control.resize("sample", b, s.token, 60, 20)).toBe(false);
      expect(f.control.resize("sample", a, s.token, 60, 20)).toBe(true);
      f.control.release("sample", a, s.token);
      expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe(policy === "inherit" ? "" : policy);
      if (policy === "manual") expect(f.run("display-message", "-p", "-t", "sample", "#{window_width}x#{window_height}")).toBe(before);
      expect(f.control.resize("sample", a, s.token, 44, 12)).toBe(false);
      expect(f.acquire().controller).toBe("none");
    } finally { f.clean(); }
  });
}
test("inherited global manual restores size and removes local override", () => {
  const f = fixture();
  try {
    f.run("set-option", "-gw", "window-size", "manual");
    const before = f.control.status("sample", a);
    const s = f.acquire(); f.control.release("sample", a, s.token);
    expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("");
    expect(f.control.status("sample", a).cols).toBe(before.cols);
  } finally { f.clean(); }
});
test("takeover invalidates old capabilities, stale acquisition and other-tab release", () => {
  const f = fixture();
  try {
    const one = f.acquire();
    expect(f.acquire(b).controller).toBe("other");
    const two = f.acquire(b, true);
    expect(two.controller).toBe("self");
    expect(f.control.resize("sample", a, one.token, 80, 20)).toBe(false);
    f.control.release("sample", a, one.token);
    expect(f.control.status("sample", b).controller).toBe("self");
    expect(f.control.acquire("sample", a, one.revision, true, 80, 20).controller).toBe("other");
    f.control.release("sample", b, two.token);
    expect(f.control.redraw("sample", a, one.token)).toBe(false);
  } finally { f.clean(); }
});
test("disconnect resume rotates capability; expired lease and late renew never reacquire", () => {
  const f = fixture();
  try {
    const one = f.acquire(); f.control.grace(a); f.advance(SIZE_GRACE_MS - 1);
    const next = { ...a, connection: "reconnected" };
    const two = f.control.renew("sample", next, one.token);
    expect(two.controller).toBe("self"); expect(two.token).not.toBe(one.token);
    expect(f.control.renew("sample", a, one.token).controller).toBe("other");
    f.advance(SIZE_LEASE_MS);
    expect(f.control.renew("sample", next, two.token).controller).toBe("none");
    expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("");
  } finally { f.clean(); }
});
test("external policy or size wins over recovery", () => {
  for (const change of ["policy", "size"]) {
    const f = fixture();
    try {
      const s = f.acquire();
      if (change === "policy") f.run("set-option", "-w", "-t", "sample", "window-size", "largest");
      else f.run("resize-window", "-t", "sample", "-x", "87", "-y", "21");
      f.control.release("sample", a, s.token);
      expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe(change === "policy" ? "largest" : "manual");
      if (change === "size") expect(f.control.status("sample", a).cols).toBe(87);
    } finally { f.clean(); }
  }
});
test("journal recovery survives rename, repeated recovery and same-name replacement", () => {
  const f = fixture();
  try {
    f.acquire(); f.run("rename-session", "-t", "sample", "renamed");
    const recovery = new SizeControl(f.runner, f.file);
    recovery.recover();
    expect(f.run("show-options", "-wv", "-t", "renamed", "window-size")).toBe("");
    f.run("rename-session", "-t", "renamed", "sample");
    f.acquire(a, true);
    f.run("new-session", "-d", "-s", "keepalive");
    f.run("kill-session", "-t", "sample");
    f.run("new-session", "-d", "-s", "sample");
    f.run("set-option", "-w", "-t", "sample", "window-size", "smallest");
    new SizeControl(f.runner, f.file);
    expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("smallest");
  } finally { f.clean(); }
});
test("server restart with reused @0 does not restore another server's window", () => {
  const f = fixture();
  try {
    f.acquire(); f.run("kill-server");
    // tmux shutdown completes before the next server is launched.
    Bun.sleepSync(50);
    f.run("new-session", "-d", "-s", "sample");
    f.run("set-option", "-w", "-t", "sample", "window-size", "largest");
    new SizeControl(f.runner, f.file);
    expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("largest");
  } finally { f.clean(); }
});
test("invalid journal fails closed; failed persistence precedes all tmux mutations", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "bad.json"), "{bad");
    const bad = new SizeControl(f.runner, join(f.root, "bad.json"));
    expect(bad.status("sample", a).blocked).toBe(true);
    expect(() => bad.acquire("sample", a, bad.status("sample", a).revision, true, 40, 12)).toThrow();
    writeFileSync(join(f.root, "not-a-dir"), "file");
    const failed = new SizeControl(f.runner, join(f.root, "not-a-dir", "record"));
    expect(() => failed.acquire("sample", a, failed.status("sample", a).revision, true, 40, 12)).toThrow();
    expect(f.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("");
  } finally { f.clean(); }
});
test("manual migration requires exact identity and revision and no controller", () => {
  const f = fixture();
  try {
    f.run("set-option", "-w", "-t", "sample", "window-size", "manual");
    const before = f.control.status("sample", a);
    const held = f.acquire();
    expect(() => f.control.migrate("sample", b, before.window, before.revision)).toThrow();
    f.control.release("sample", a, held.token);
    const released = f.control.status("sample", a);
    expect(f.control.migrate("sample", a, released.window, released.revision).policy).toBe("inherit");
  } finally { f.clean(); }
});
test("two disposable servers: agent startup, channel rebuild and stop preserve the other server", async () => {
  const first = fixture(), second = fixture();
  let service: TerminalService | undefined;
  try {
    first.run("pipe-pane", "-O", "-t", "sample", "cat >/dev/null");
    const before = first.run("display-message", "-p", "-t", "sample", "#{pane_pipe}|#{window_width}|#{window_height}|#{status}");
    service = new TerminalService({ socket: second.socket, runDir: join(second.root, "run"), sizeFile: second.file });
    await Bun.sleep(100);
    service.ensure("sample");
    expect(second.run("show-options", "-wv", "-t", "sample", "window-size")).toBe("");
    (service as any).sessions.get("sample").pty.kill();
    (service as any).onPtyExit("sample", 0);
    service.dispose();
    expect(first.run("display-message", "-p", "-t", "sample", "#{pane_pipe}|#{window_width}|#{window_height}|#{status}")).toBe(before);
  } finally { service?.dispose(); first.clean(); second.clean(); }
});

test("SIGKILL leaves a journal which a fresh process recovers before control", async () => {
  const f = fixture();
  try {
    const script = `import { SizeControl } from ${JSON.stringify(join(import.meta.dir, "size-control.ts"))};
      import { runTmux } from ${JSON.stringify(join(import.meta.dir, "terminal.ts"))};
      const c = new SizeControl(a => runTmux(a, ${JSON.stringify(f.socket)}), ${JSON.stringify(f.file)});
      const actor = {device:'crashed',connection:'one'};
      c.acquire('sample',actor,c.status('sample',actor).revision,true,42,11);
      console.log('acquired'); setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("acquired");
      child.kill("SIGKILL"); await child.exited;
      const recovered = new SizeControl(f.runner, f.file);
      expect(recovered.status("sample", a).policy).toBe("inherit");
      expect(JSON.parse(readFileSync(f.file, "utf8")).records).toEqual([]);
    } finally { child.kill(); }
  } finally { f.clean(); }
});

test("released inherited window follows a native tmux client's subsequent resize", async () => {
  const f = fixture();
  const client = Bun.spawn(["tmux", "-S", f.socket, "attach-session", "-t", "sample"], {
    env: { ...process.env, TERM: "xterm-256color", TMUX: "" },
    terminal: { cols: 100, rows: 40, data() {} },
  });
  const waitWidth = async (width: number) => {
    for (let i = 0; i < 100; i++) {
      if (f.control.status("sample", a).cols === width) return;
      await Bun.sleep(10);
    }
    expect(f.control.status("sample", a).cols).toBe(width);
  };
  try {
    await waitWidth(100);
    const held = f.acquire();
    client.terminal!.resize(120, 45);
    await Bun.sleep(50);
    expect(f.control.status("sample", a).cols).toBe(40);
    f.control.release("sample", a, held.token);
    client.terminal!.resize(110, 42);
    await waitWidth(110);
    expect(f.control.status("sample", a).policy).toBe("inherit");
  } finally {
    client.kill(); await client.exited; client.terminal?.close(); f.clean();
  }
});

test("external changes invalidate an inspected migration revision", () => {
  const f = fixture();
  try {
    f.run("set-option", "-w", "-t", "sample", "window-size", "manual");
    const inspected = f.control.status("sample", a);
    f.run("resize-window", "-t", "sample", "-x", "90", "-y", "30");
    expect(() => f.control.migrate("sample", a, inspected.window, inspected.revision)).toThrow();
    expect(f.control.status("sample", a).policy).toBe("manual");
  } finally { f.clean(); }
});
