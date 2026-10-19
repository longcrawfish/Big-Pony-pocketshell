import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, readFileSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { persistentPairing } from "./pairing";
import { PreviewTokens } from "./preview-service";
import { buildPreviewResponse } from "./server-preview";
import { openPreviewFile } from "./preview-open";
import { originAllowed, requestClientIp, DEFAULT_INGRESS } from "./ingress-security";
import { appSecurityHeaders } from "./app-security";
import { decodeClient } from "./protocol";
import { createRpcBudget } from "./rpc-budget";
import { boundedDownload } from "./update-signature";
import { fileAuditWriter } from "./audit";
import { startServer } from "./server";
import { loadConfig } from "./config";
import type { SecureChannel } from "./secure-channel";

const roots: string[] = [];
function fixture() { const dir = mkdtempSync("/tmp/ps-security-test-"); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("five wrong guesses stay exhausted after reloading; fresh challenge works", () => {
  const dir = fixture(), rec = { code: "ABCD2345", mintedAt: 10, expiresAt: 300000, maxAttempts: 5 };
  for (let i = 0; i < 5; i++) expect(persistentPairing(dir, rec, () => 20).verify("wrong").ok).toBe(false);
  expect(persistentPairing(dir, rec, () => 30).verify(rec.code)).toEqual({ ok: false, reason: "no_attempts" });
  const fresh = { ...rec, challengeId: "fresh" };
  expect(persistentPairing(dir, fresh, () => 30).verify(rec.code).ok).toBe(true);
  expect(persistentPairing(dir, fresh, () => 30).verify(rec.code).ok).toBe(false);
});

test("independent pairing objects serialize consumption; broken state storage fails closed", () => {
  const dir = fixture(), rec = { code: "ABCD2345", expiresAt: 300000, maxAttempts: 5 };
  const a = persistentPairing(dir, rec, () => 0), b = persistentPairing(dir, rec, () => 0);
  expect(a.verify(rec.code).ok).toBe(true);
  expect(b.verify(rec.code)).toEqual({ ok: false, reason: "consumed" });
  const blocked = join(dir, "blocked"); writeFileSync(blocked, "x");
  expect(persistentPairing(blocked, rec, () => 0).verify(rec.code).ok).toBe(false);
});

test("leaked script-enabled token authorizes only its explicit public asset", async () => {
  const dir = fixture(); writeFileSync(join(dir, "page.html"), "<script>1</script>"); writeFileSync(join(dir, ".env"), "secret");
  const pt = new PreviewTokens();
  const token = pt.mint(dir, "dev", 0, { files: ["page.html"], scripts: true });
  expect(buildPreviewResponse(pt, new URL(`http://x/preview/${token}/.env`), 1).status).toBe(403);
  expect(() => pt.mint(dir, "dev", 0, { files: [".env"] })).toThrow();
  expect(() => pt.mint(dir, "dev", 0)).toThrow();
  const response = buildPreviewResponse(pt, new URL(`http://x/preview/${token}/page.html`), 1);
  expect(response.status).toBe(200); expect(await response.text()).toContain("script");
});

test("symlink files/ancestors are rejected, including replacement after mint", () => {
  const dir = fixture(); mkdirSync(join(dir, "public")); mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "a.png"), "secret");
  symlinkSync(join(dir, "outside", "a.png"), join(dir, "public", "link.png"));
  const pt = new PreviewTokens();
  expect(() => pt.mint(join(dir, "public"), "dev", 0, { files: ["link.png"] })).toThrow();
  mkdirSync(join(dir, "public", "sub")); writeFileSync(join(dir, "public", "sub", "a.png"), "public");
  const token = pt.mint(join(dir, "public"), "dev", 0, { files: ["sub/a.png"] });
  renameSync(join(dir, "public", "sub"), join(dir, "saved")); symlinkSync(join(dir, "outside"), join(dir, "public", "sub"));
  expect(buildPreviewResponse(pt, new URL(`http://x/preview/${token}/sub/a.png`), 1).status).toBe(404);
});

test("already opened response descriptor cannot be redirected by a path exchange", () => {
  const dir = fixture(), path = join(dir, "a.png"); writeFileSync(path, "public");
  const fd = openPreviewFile(path);
  try { renameSync(path, join(dir, "old.png")); writeFileSync(path, "secret"); expect(readFileSync(fd, "utf8")).toBe("public"); }
  finally { closeSync(fd); }
});

test("preview renew checks device and cannot extend absolute expiry; revoke is immediate", () => {
  const dir = fixture(); writeFileSync(join(dir, "a.png"), "x");
  const pt = new PreviewTokens(), token = pt.mint(dir, "dev", 0, { files: ["a.png"] });
  expect(pt.renew(token, "other", 1)).toBe(false);
  for (let t = 60000; t <= 600000; t += 60000) expect(pt.renew(token, "dev", t)).toBe(true);
  expect(pt.renew(token, "dev", 600001)).toBe(false);
  const next = pt.mint(dir, "dev", 1, { files: ["a.png"] }); pt.revoke(next, "dev"); expect(pt.resolve(next, "a.png", 2)).toBeNull();
});

test("only configured proxy can supply a single real IP; unknown loopback is not globally locked", () => {
  const req = new Request("https://app.test", { headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "8.8.8.8" } });
  expect(requestClientIp(req, "5.6.7.8", ["127.0.0.1"])).toBe("5.6.7.8");
  expect(requestClientIp(req, "::ffff:127.0.0.1", ["127.0.0.1"])).toBe("1.2.3.4");
  expect(requestClientIp(req, "127.0.0.1", [])).toBe("");
});

test("origin is exact, null and suffix-confusion origins are refused", () => {
  for (const origin of ["null", "https://app.test.evil.test", "http://app.test"]) expect(originAllowed(new Request("https://app.test", { headers: { origin } }), DEFAULT_INGRESS)).toBe(false);
  expect(originAllowed(new Request("https://app.test", { headers: { origin: "https://app.test" } }), DEFAULT_INGRESS)).toBe(true);
});

test("application CSP hashes bootstrap JS without granting arbitrary inline script", () => {
  const h = appSecurityHeaders("<script>const x=1;</script>", "wss://agent.test/ws");
  expect(h["Content-Security-Policy"]).toContain("'sha256-");
  expect(h["Content-Security-Policy"].split("script-src")[1].split(";")[0]).not.toContain("unsafe-inline");
  expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(h["Content-Security-Policy"]).toContain("wss://agent.test");
});

test("malformed pairing JSON never reaches an unauthenticated handler", () => {
  for (const m of [null, [], true, { type: "pair", code: {}, deviceName: "a" }, { type: "rpc", method: 1 }]) {
    expect(() => decodeClient(JSON.stringify(m))).toThrow();
  }
});

test("expensive RPC budget follows device identity, refills, and leaves transfer/input alone", () => {
  let now = 0; const allow = createRpcBudget(() => now);
  for (let i = 0; i < 60; i++) expect(allow("a", "fs.archive")).toBe(true);
  expect(allow("a", "git.review")).toBe(false);
  expect(allow("b", "fs.archive")).toBe(true);
  expect(allow("a", "fs.uploadChunk")).toBe(true);
  now = 1000; expect(allow("a", "git.review")).toBe(true);
  expect(allow("a", "git.review")).toBe(false);
});

test("OTA bounds both declared length and actual streamed bytes", async () => {
  for (const headers of [new Headers(), new Headers({ "content-length": "20" })]) {
    await expect(boundedDownload("https://release.invalid", 4, (async () => new Response("12345", { headers })) as unknown as typeof fetch)).rejects.toThrow("size limit");
  }
  let aborted = false;
  const slow = ((_url: unknown, opts: any) => new Promise<Response>((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => { aborted = true; reject(new Error("deadline")); });
  })) as typeof fetch;
  await expect(boundedDownload("https://release.invalid", 4, slow, 10)).rejects.toThrow("deadline");
  expect(aborted).toBe(true);
});

test("audit rotates at a bounded size and keeps oversized records valid JSON", () => {
  const file = join(fixture(), "audit.log"); writeFileSync(file, "x".repeat(5 * 1024 * 1024));
  const write = fileAuditWriter(file); write('{"event":"operation"}');
  expect(readFileSync(file + ".1").length).toBe(5 * 1024 * 1024);
  write(JSON.stringify({ event: "operation", detail: "x".repeat(10000) }));
  const records = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(records.map(r => r.event)).toEqual(["operation", "audit_truncated"]);
});

test("pre-auth quotas bound channel allocation and oversized handshakes never reach Noise", () => {
  const config = loadConfig({ POCKETSHELL_KEY_DIR: fixture() });
  const server = startServer({ config, port: 0 });
  let allocations = 0, closes = 0, received = 0;
  const factory = (): SecureChannel => {
    allocations++;
    return { state: "handshaking", start: () => null, receive: () => { received++; return { status: "fail", reason: "test" }; }, send: p => p };
  };
  const ws = () => ({ close: () => { closes++; }, send: () => {} });
  try {
    const first = ws(); server.__test.openWith(first, "1.2.3.4", factory);
    for (let i = 1; i < 9; i++) server.__test.openWith(ws(), "1.2.3.4", factory);
    expect(allocations).toBe(8); expect(closes).toBe(1);
    for (let i = 0; i < 57; i++) server.__test.openWith(ws(), `10.0.0.${i + 1}`, factory);
    expect(allocations).toBe(64); expect(closes).toBe(2);
    server.__test.message(first as any, new Uint8Array(513));
    expect(received).toBe(0); expect(closes).toBe(3);
  } finally { server.stop(); }
});
