// Isolated compiled-binary fixture; JSON stdin carries authenticated test RPCs.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import DH from "noise-handshake/dh";
import { loadConfig } from "../src/config";

const keyDir = mkdtempSync("/tmp/ps-security-browser-");
const socket = join(keyDir, "tmux.sock"), project = join(keyDir, "project");
mkdirSync(project);
writeFileSync(join(project, "page.html"), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Preview fixture</h1><script>document.body.dataset.ran="yes";try{parent.localStorage.getItem("pocketshell.identity");document.body.dataset.parent="read"}catch{document.body.dataset.parent="blocked"}</script>');
writeFileSync(join(project, "style.css"), "h1{color:rgb(12,34,56)}");
writeFileSync(join(project, "readme.md"), "# Markdown fixture\n\n<script>alert(1)</script>\n");
writeFileSync(join(project, "edit.txt"), "Editable fixture\n");
writeFileSync(join(project, ".env"), "TEST_SECRET_DO_NOT_SERVE");
symlinkSync(join(project, ".env"), join(project, "link.png"));
const keys = DH.generateKeyPair();
const publicKey = Buffer.from(keys.publicKey).toString("base64");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!; probe.stop(true);
const cfg = loadConfig({ POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_RUN_DIR: join(keyDir, "run"), POCKETSHELL_TMUX_SOCKET: socket, POCKETSHELL_AUTHORIZED_KEYS: publicKey });
const binary = resolve(process.env.PS_TEST_BINARY ?? join(import.meta.dir, "../dist/pocketshell-agent-linux-x64"));
const env: Record<string, string | undefined> = { ...process.env, POCKETSHELL_KEY_DIR: keyDir, POCKETSHELL_RUN_DIR: join(keyDir, "run"), POCKETSHELL_TMUX_SOCKET: socket,
  POCKETSHELL_AUTHORIZED_KEYS: publicKey, POCKETSHELL_PORT: String(port), POCKETSHELL_HOST: "127.0.0.1", POCKETSHELL_UPDATE: "0" };
delete env.TMUX; delete env.TMUX_PANE;
const child = Bun.spawn([binary], { env, stdout: Bun.file(join(keyDir, "agent.log")), stderr: Bun.file(join(keyDir, "agent-errors.log")) });
const stop = () => {
  child.kill();
  Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
};
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("SIGINT", () => { stop(); process.exit(0); });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(url); break; } catch { if (i >= 100) throw new Error("binary startup timeout"); await Bun.sleep(50); }
  }
  const ws = new WebSocket(url.replace("http", "ws") + "/ws"); ws.binaryType = "arraybuffer";
  const hs = new Noise("IK", true, keys); hs.initialise(Buffer.from("pocketshell-v1"), Buffer.from(cfg.identity.publicKey));
  let tx: Cipher, rx: Cipher;
  await new Promise<void>((ready, reject) => {
    ws.onopen = () => ws.send(hs.send()); ws.onerror = reject;
    ws.onmessage = event => {
      const bytes = Buffer.from(event.data as ArrayBuffer);
      if (!tx) { hs.recv(bytes); tx = new Cipher(hs.tx); rx = new Cipher(hs.rx); ready(); return; }
      const m = JSON.parse(Buffer.from(rx.decrypt(bytes)).toString());
      if (m.type === "response") console.log(JSON.stringify({ response: m }));
    };
  });
  console.log(JSON.stringify({ keyDir, project, port, agentPubKey: Buffer.from(cfg.identity.publicKey).toString("base64"), browserIdentity: { publicKey, secretKey: Buffer.from(keys.secretKey).toString("base64") } }));
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    ws.send(tx!.encrypt(Buffer.from(JSON.stringify({ type: "rpc", ...request }))));
  }
  ws.close();
} finally { stop(); await child.exited; rmSync(keyDir, { recursive: true, force: true }); }
