# PocketShell Deployment Guide

**English** · [中文](./DEPLOYMENT-CN.md)

---

This guide covers five ways to expose the PocketShell Agent to your phone, from simplest to most involved:

| Option | When to use | Requires |
|---|---|---|
| [A. Bare IP + port](#option-a--bare-ip--port-no-domain) | Isolated development network only | explicit insecure opt-in |
| [B. Direct server + domain](#option-b--direct-server-deployment-with-a-domain-caddy--nginx) | Agent runs on a server with a public IP and a domain | Caddy or Nginx |
| [C. Cloudflare Tunnel](#option-c--cloudflare-tunnel-no-public-ip) | Home/office machine without a public IP | Cloudflare account + domain |
| [D. frp relay server](#option-d--frp-relay-server-no-public-ip-self-controlled) | No public IP, but you own a VPS and want full control | VPS + domain |
| [E. Tailscale Funnel](#option-e--tailscale-funnel-no-domain-needed) | You want real HTTPS but own no domain | Tailscale account |

### Before you start: three key concepts

**1. Bind address & port.** The Agent listens on `127.0.0.1:8722` by default — local access only. Two env vars control this:

- `POCKETSHELL_HOST` — bind address. Set `0.0.0.0` for direct access from other devices; keep `127.0.0.1` when a local reverse proxy / tunnel sits in front.
- `POCKETSHELL_PORT` — port, default `8722`.

**2. Advertised address (`POCKETSHELL_ADVERTISE`).** The **pairing string** printed on first run embeds "where the phone should connect", taken from `POCKETSHELL_ADVERTISE` as a WebSocket URL: `ws://<IP>:8722` for direct access, `wss://your.domain` behind an HTTPS proxy. If unset it defaults to `ws://<HOST>:<PORT>`, which is unreachable from a phone when bound to `127.0.0.1` or `0.0.0.0` — **set it explicitly in every deployment**.

**3. Encryption and TLS protect different boundaries.** Noise IK authenticates devices and encrypts terminal/RPC traffic. It does not protect delivery of the browser application: an active attacker on HTTP can replace JavaScript and steal device keys or commands. Preview HTTP responses also bypass Noise. Use HTTPS/WSS with a trusted certificate for remote access; plaintext access is an explicit development exception.

> Pairing tip: the pairing code has a 300 s TTL and is only generated at process start. To pair a new phone on a long-running Agent, no restart is needed — run `pocketshell-agent pair` on the Agent machine to mint a fresh pairing string.

---

### Option A — bare IP + port (no domain)

Development only: an isolated network you control. Do not expose plaintext HTTP on a public IP.

```bash
POCKETSHELL_HOST=0.0.0.0 POCKETSHELL_ALLOW_INSECURE_HTTP=1 \
POCKETSHELL_ADVERTISE=ws://192.168.1.10:8722 \
./pocketshell-agent
```

Open `http://192.168.1.10:8722` on your phone and paste the pairing string.

Notes:

- This opt-in accepts active network attacks against page delivery and plaintext preview content. HTTP also restricts clipboard and PWA APIs.
- **On a public IP, narrow the attack surface**: firewall the port to your own egress IP, or use options B/C/D. Unpaired devices can't pass the handshake, but there's no reason to leave the port open to internet-wide scanning.
- Want HTTPS without a reverse proxy? Use the Agent's built-in TLS with a self-signed cert:

```bash
# generate once (default paths: <keyDir>/tls_cert.pem + tls_key.pem)
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ~/.pocketshell/tls_key.pem -out ~/.pocketshell/tls_cert.pem \
  -days 3650 -subj "/CN=pocketshell"

POCKETSHELL_HOST=0.0.0.0 POCKETSHELL_TLS=1 \
POCKETSHELL_ADVERTISE=wss://192.168.1.10:8722 \
./pocketshell-agent
```

Browsers warn on self-signed certs (trust it once manually); use option B for a real certificate.

---

### Option B — direct server deployment with a domain (Caddy / Nginx)

The Agent runs on a server with a public IP; your domain points at it. Keep the Agent on localhost and let the reverse proxy terminate TLS:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

**Caddy (recommended — automatic HTTPS, WebSocket passthrough out of the box)** — add one block to `/etc/caddy/Caddyfile`:

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:8722
}
```

**Nginx** — WebSocket needs explicit upgrade headers, and long-lived idle connections need generous timeouts:

```nginx
server {
    listen 443 ssl;
    server_name ps.example.com;

    ssl_certificate     /etc/letsencrypt/live/ps.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ps.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8722;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Get certificates with [certbot](https://certbot.eff.org/). Then open `https://ps.example.com` on your phone.

---

### Option C — Cloudflare Tunnel (no public IP)

When the machine has no public IP, `cloudflared` dials out from inside your network to Cloudflare — no inbound ports at all. Prerequisites: a Cloudflare account with your domain on it.

```bash
# 1) install cloudflared (Linux: official repo; macOS: brew install cloudflared)
# 2) log in and authorize the domain
cloudflared tunnel login

# 3) create the tunnel
cloudflared tunnel create pocketshell

# 4) write ~/.cloudflared/config.yml
#    take tunnel / credentials-file values from the create output
```

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/you/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: ps.example.com
    service: http://127.0.0.1:8722
  - service: http_status:404
```

```bash
# 5) create the DNS record and run
cloudflared tunnel route dns pocketshell ps.example.com
cloudflared tunnel run pocketshell        # then: cloudflared service install
```

Agent side stays on localhost:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

TLS terminates at Cloudflare's edge with WebSocket passthrough; terminal/RPC frames remain Noise ciphertext. The TLS terminator can read previews and serves the application JavaScript, so it is part of the trusted delivery path. Alternatively, skip the config file and use the web wizard in Cloudflare Zero Trust (Networks → Tunnels).

---

### Option D — frp relay server (no public IP, self-controlled)

Same goal as option C, but relayed through your own VPS so you control the whole path (this is the author's own production setup). Topology:

```
phone → https://ps.example.com
      → VPS Caddy:443 (TLS termination) → 127.0.0.1:18092 (frps landing port)
      → frp tunnel (frpc on the LAN machine dials out to VPS:7000)
      → LAN machine 127.0.0.1:8722  pocketshell-agent
```

**On the VPS** — `frps.toml`:

```toml
bindPort = 7000
auth.token = "replace-with-a-long-random-secret"
# bind landing ports to localhost only — 18092 is reachable through Caddy, not the internet
proxyBindAddr = "127.0.0.1"
```

**On the VPS** — add a Caddyfile block:

```caddyfile
ps.example.com {
    reverse_proxy 127.0.0.1:18092
}
```

**On the LAN machine** — `frpc.toml`:

```toml
serverAddr = "your.vps.ip"
serverPort = 7000
auth.token = "same-as-frps"

[[proxies]]
name = "pocketshell"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8722
remotePort = 18092
```

**On the LAN machine** — the Agent:

```bash
POCKETSHELL_HOST=127.0.0.1 \
POCKETSHELL_ADVERTISE=wss://ps.example.com \
./pocketshell-agent
```

With `proxyBindAddr = "127.0.0.1"` set, the frps landing port `18092` binds to the VPS's localhost and is reachable only through Caddy; only 443 faces the internet (also firewall port `7000` so only your frpc can reach it). Optionally put Cloudflare's proxy (orange cloud) in front for CDN + origin-IP hiding — WebSocket passes through automatically.

---

### Option E — Tailscale Funnel (no domain needed)

If you do not own a domain, this is the shortest path to a real HTTPS address:

```bash
sudo pocketshell-agent install --advertise ws://127.0.0.1:8722
sudo pocketshell-agent tunnel setup
```

You approve two things in a browser (signing this machine in, and enabling
Funnel for your tailnet); everything else is automatic. You end up on
`https://<host>.<tailnet>.ts.net`, which is a real certificate — so the app
installs to your home screen and Web Push works.

Things worth knowing before you pick this:

- **Bandwidth is capped.** Measured on 2026-08-16: about 2.5 MB/s through
  Funnel versus ~4.7 MB/s direct on the same machine and client — roughly
  half. Terminal use does not notice; a 10 MB attachment takes about 4
  seconds, 100 MB about 40. Tailscale calls this "non-configurable bandwidth
  limits" and publishes no number.
- **Funnel is still beta**, and the public port is always 443 (Funnel allows
  only 443, 8443 and 10000).
- **Your traffic passes through Tailscale's relays**, with terminal/RPC content encrypted by Noise. Page delivery and previews additionally depend on the HTTPS path.
- **The first certificate takes a minute or more.** Repeated failures are
  rate-limited by Let's Encrypt and can force a long wait.
- `POCKETSHELL_TLS=1` is not supported with Funnel; Funnel terminates TLS
  itself and the agent should speak plain HTTP on loopback.

If you are testing the public address with curl, pass `--http1.1`. Over HTTP/2
`Connection: Upgrade` is a forbidden hop-by-hop header and gets dropped, so a
WebSocket check appears to fail when it is actually fine.

On macOS, `tunnel setup` does not install Tailscale for you — install it first
(`brew install tailscale`, or the App Store app) and run `tunnel setup` without
`sudo`.

---

### Running as a service (systemd / launchd)

**Recommended: let the `install` subcommand do it**

```bash
# Linux
sudo pocketshell-agent install --advertise wss://ps.example.com --name my-server
# macOS (no sudo — a LaunchAgent belongs to your user domain)
pocketshell-agent install --advertise wss://ps.example.com --name my-mac
```

It writes the config shown below, registers it to start on boot, starts the service, and prints the pairing string **on a first install**. Re-run it any time to reinstall or change parameters (the existing config is backed up first); your key directory is left alone — which is also why a reinstall prints no pairing string, since the phones already paired with this machine keep working. Run `pocketshell-agent pair` to add a new one. To remove it: `pocketshell-agent uninstall` (your key directory and the binary are kept).

The hand-written configs below are there if you want the details or need to customise something.

**Linux (systemd)** — `/etc/systemd/system/pocketshell.service`:

```ini
[Unit]
Description=PocketShell Agent
After=network.target

[Service]
User=you
ExecStart=/usr/local/bin/pocketshell-agent
Environment=POCKETSHELL_HOST=127.0.0.1
Environment=POCKETSHELL_ADVERTISE=wss://ps.example.com
# Running more than one install? Name this one — it shows on the home-screen icon
# and in the app's top bar (see "Running more than one server" below).
# Environment=POCKETSHELL_INSTANCE_NAME=Dev
WorkingDirectory=/home/you
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pocketshell
journalctl -u pocketshell -f        # logs (incl. the first-run pairing string)
```

**macOS (launchd)** — `~/Library/LaunchAgents/com.pocketshell.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pocketshell.agent</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.local/bin/pocketshell-agent</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- PATH must include tmux's directory (Homebrew: /opt/homebrew/bin) -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>POCKETSHELL_HOST</key><string>127.0.0.1</string>
    <key>POCKETSHELL_ADVERTISE</key><string>wss://ps.example.com</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/you</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pocketshell.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/pocketshell.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pocketshell.agent.plist
launchctl kickstart -k gui/$(id -u)/com.pocketshell.agent   # restart
tail -f /tmp/pocketshell.out.log                            # logs (incl. pairing string)
```

> ⚠️ launchd starts with a minimal `PATH`. You **must** include tmux's directory (Homebrew: `/opt/homebrew/bin`) in `EnvironmentVariables.PATH`, otherwise the Agent exits at startup because it cannot find tmux.

### Running more than one server

Installing an Agent on several machines works out of the box — they know nothing about each other and share nothing: separate keys and device registries, separate sessions, separate push subscriptions. All you do is give each one its own address, plus a name:

```bash
# work machine
POCKETSHELL_ADVERTISE=wss://dev.example.com POCKETSHELL_INSTANCE_NAME=Dev pocketshell-agent
# home server
POCKETSHELL_ADVERTISE=wss://home.example.com POCKETSHELL_INSTANCE_NAME=Home pocketshell-agent
```

With `POCKETSHELL_INSTANCE_NAME` set, the name shows up in three places:

- **The label under the home-screen icon** — shows `Dev` (just the instance name; this is where the OS truncates hardest)
- **The app name when installing the PWA** — shows `Dev · PocketShell`
- **The app's top bar** — `Dev ·` in front of the brand name

So you end up with two independent PWAs and two home-screen icons you can tell apart at a glance. Because browsers isolate data per domain, each side keeps its own tabs, project-root bookmark, and push subscription — **notifications from both servers reach you, neither displacing the other** (you cannot get this from a single domain; browsers allow only one push subscription per origin).

> Each instance needs its own domain or address. The app is served over HTTPS, browsers refuse to let an HTTPS page open a plaintext `ws://` connection, and `wss://` needs a certificate — which cannot be issued for a bare IP. So any instance reachable over the internet needs a domain name (a subdomain is enough — see options B/C/D above). Direct IP access on a LAN is not affected.

### Auto-update (OTA)

OTA is disabled by default. With `POCKETSHELL_UPDATE=1`, the Agent checks GitHub Releases (6-hour cache). Applying an update additionally requires a reviewed Ed25519 public key compiled into `agent/src/update-trust.ts`; the current trust store is empty, so installation is refused. When provisioned, the updater verifies the signed manifest, repository, newer version, platform, exact archive size and SHA256 before extraction and replacement. Downloads have a 30-second deadline and a 256 MiB archive ceiling. There is no checksum-only fallback.

- **The self-restart requires the process to be supervisor-managed.** Once the swap lands, the Agent tries to restart itself; if it's under systemd (`Restart=always`, above) or launchd (`KeepAlive`, above), the supervisor relaunches the new binary automatically. Otherwise it falls back to spawning a detached replacement process and exiting — a less reliable path than supervisor management. **Production deployments should set `Restart=always` / `KeepAlive` as shown above** so in-app updates can reliably come back up as the new version.
- **It also requires the service user to be able to write the binary's directory.** An update writes a temporary file next to the binary and renames it into place, so what it needs is write access to the *directory*, not just the file. The `install` subcommand arranges this for you: the binary goes to `/opt/pocketshell/`, owned by the service user, with `/usr/local/bin/pocketshell-agent` as a symlink pointing at it. If you instead place the binary by hand in root-owned `/usr/local/bin` and run the service as a regular user, in-app updates fail with `EACCES: permission denied` — either switch to the `install` subcommand or upgrade the binary manually.
- **Env vars:** `POCKETSHELL_UPDATE=1` opts in; unset/`0` or `POCKETSHELL_UPDATE_REPO=off` disables OTA. The default repository is `longcrawfish/Big-Pony-pocketshell`; other repositories are check-only. HTTP(S) proxy environment variables are honored.
- **macOS: the first Full Disk Access grant survives OTA updates.** Each new binary is re-signed with a stable local self-signed identity (`PocketShell Self-Signed`), so its codesign designated requirement doesn't change between builds — TCC permissions (like Full Disk Access) granted to the previous binary carry over without a re-prompt. Provisioning that signing identity is a **one-time, interactive** step (a background process can't create/trust a certificate on its own) — run `pocketshell-agent --warmup` to set it up. Skipping this doesn't block OTA updates; the new binary just won't be signed, and TCC permissions may need to be re-granted.

### Security settings and upgrade migration

A paired device has the operating-system privileges of the Agent user, including shell execution and access to that user's files. The project-root bookmark is a navigation preference, **not a filesystem sandbox**. Use a dedicated non-root account and a dedicated HTTPS origin; keep unrelated web applications off that origin.

- Linux `sudo ... install` uses `SUDO_USER`. When installing directly as root, pass `--user <ordinary-user>`; implicit root installation is rejected. Root requires both `--user root --allow-root`; manual root execution requires `POCKETSHELL_ALLOW_ROOT=1`.
- Non-loopback HTTP binds are rejected unless `POCKETSHELL_ALLOW_INSECURE_HTTP=1` is explicitly set (installer: `--allow-insecure-http`). Existing plaintext LAN installations must migrate to TLS or explicitly accept this development exception. Localhost HTTP upstreams behind HTTPS proxies remain supported.
- WebSocket upgrades accept only `/ws` and the legacy `/`. Browser Origin must exactly match the advertised origin; additional trusted origins are comma-separated in `POCKETSHELL_ALLOWED_ORIGINS`. Native clients without Origin still require Noise authentication; set `POCKETSHELL_REQUIRE_ORIGIN=1` to deny them too.
- Only exact peer addresses in `POCKETSHELL_TRUSTED_PROXIES` may supply `X-Real-IP`. The proxy must **overwrite** that header with the actual client IP (Nginx example above). Never blindly trust forwarded headers. Unknown loopback peers share only the global unauthenticated limit, avoiding a shared-IP lockout. Apply connection/rate limits at your edge as well.
- Block `/internal/*` and `/theme/import` at the external proxy; local hooks still call loopback directly. For Nginx add `location ^~ /internal/ { return 404; }` and `location = /theme/import { return 404; }`; for Caddy add `respond /internal/* 404` and `respond /theme/import 404` before `reverse_proxy`.
- Unauthenticated connections are capped at 64 globally and 8 per identified source, with a 5-second Noise handshake deadline and a separate 10-second pairing deadline. WS messages are capped at 65,535 bytes. Expensive authenticated RPCs share a per-device bucket of 60 requests, replenished at one per second; file-transfer chunks and terminal input are excluded.
- The installed systemd service uses `UMask=0077`. Optional `NoNewPrivileges=yes` disables privilege escalation from terminal commands (including sudo); enable only if that matches your workflow. Avoid blindly enabling `PrivateTmp` or `ProtectHome`, which can break existing tmux sockets and working directories.

**File previews:** tokens authorize an explicit list of at most 128 public assets, never an entire directory. Dotfiles, arbitrary data files, symlinks and symlink ancestors are rejected. HTML starts with scripts disabled. Enabling scripts needs confirmation and still cannot grant files outside the manifest; inspect the resource list before previewing untrusted HTML. Add CSS dependencies such as fonts/images manually if they are not direct HTML references. A selected public asset can itself contain sensitive data: the extension allowlist is not a content scanner.

Preview tokens have a 2-minute idle and 10-minute absolute lifetime. Active previews renew over the authenticated channel and remint at absolute expiry; closing/hiding a preview or revoking its device invalidates its tokens. Video remint preserves playback position. Responses use `no-store`, `no-referrer`, sandbox CSP and `nosniff`. The main app uses a separate CSP with hashed bootstrap scripts; existing browser device identities remain compatible. Browser keys still live in localStorage: CSP reduces injection exposure but cannot make an already-compromised same-origin application safe.

Audit records cover authentication, device revocation, file mutations, notification configuration and update outcomes. They contain operation metadata, never terminal contents, file bodies or credentials. `audit.log` rotates at 5 MiB with one retained backup; forward logs externally if you need durable retention.

**Release signing:** maintainers provision an Ed25519 private key outside the repository (mode `0600`) and review its SPKI PEM public key into `agent/src/update-trust.ts` under a stable key ID. Set `POCKETSHELL_SIGNING_KEY_FILE` only on the signing machine. The release script checks the key before publication and emits `release-manifest.json` plus `release-manifest.sig`; missing or untrusted keys stop publication. Introduce new public keys in a trusted release before switching signing keys. Never accept verification keys from a downloaded release or a runtime environment override. The bootstrap `install.sh` still verifies same-release SHA256 only, so obtain that script/binary through a trusted channel or build a reviewed revision locally.

### Notifications & the local loopback endpoint

The Agent has a built-in, localhost-only notification loopback endpoint, `/internal/notify` (`POST`, gated by both a `127.0.0.1`-only check and a Bearer token — either failing returns 403 / 401, and a missing required field returns 400). When Claude Code / Codex / opencode's hook/notify subprocess fires at the end of a work round or while waiting on input, it calls this endpoint, which fans out to in-app broadcast, Web Push, and webhooks (see [README's "Notifications" section](./README.md#-notifications) for the feature overview).

Each terminal session gets three env vars injected into its subprocess environment for the hook to use:

| Variable | Purpose |
|---|---|
| `POCKETSHELL_NOTIFY_SESSION` | the current session ID |
| `POCKETSHELL_NOTIFY_URL` | the loopback endpoint, fixed at `http://127.0.0.1:<port>/internal/notify` |
| `POCKETSHELL_NOTIFY_TOKEN` | the auth token, matching `<keyDir>/notify_token` |

**Known limitation: notifications don't fire with built-in TLS enabled.** `POCKETSHELL_NOTIFY_URL` is fixed to plain `http://` loopback; if built-in Agent TLS is on (`POCKETSHELL_TLS=1`, see the end of option A), the same listening port only accepts TLS handshakes, so the hook subprocess's plain-HTTP connection fails outright — notifications simply won't trigger in that combination. Production deployments default to TLS off with the edge (Cloudflare/Caddy, options B/C/D) terminating TLS, so they're unaffected; this only bites the niche case of option A plus built-in self-signed TLS layered on top.

`KEY_DIR` (default `~/.pocketshell`) gains a few notification-related files on disk, all written atomically (tmp+rename) with `0600` permissions:

| File | Contents |
|---|---|
| `notify.json` | overall notification config (per-tool toggles / Web Push toggle / summary toggle / dedupe window / webhook list, including each webhook's URL/secret) |
| `vapid.json` | the VAPID key pair used for Web Push |
| `push-subs.json` | per-device Web Push subscriptions |
| `notify_token` | the random token used to authenticate calls to `/internal/notify` |

### CLI device management

This is the **only** device-management interface (a web admin page existed until v1.8.0 — see the end of this section for why it was removed). Run these on the Agent host, with the same `POCKETSHELL_KEY_DIR` env var as the resident process:

```bash
# list paired devices (fingerprint, name, added time, last-seen, last IP)
pocketshell-agent devices list

# mint a new pairing code and print the pairing string; a running Agent
# adopts it automatically, so a new phone can pair with no restart
# (the pairing code has a 300 s TTL)
pocketshell-agent pair [--name <device-name>]

# revoke a device (pass the full public key, or a prefix of its fingerprint from the list)
pocketshell-agent devices remove <pubkey-or-fingerprint>
```

> `pair` atomically writes the pending code to `<keyDir>/pairing.pending.json` (0600); the resident Agent reads and adopts it the next time an unregistered device attempts the handshake, and records attempts/consumption transactionally in `pairing-state.db`. Five failures exhaust the challenge across reconnections and process restarts. A new `pair` command creates a fresh challenge; stale pending files cannot reset the budget.

> `devices remove` reaches a running Agent too: it polls `<keyDir>/devices.json` every 3 s, so within seconds of the removal the device loses its authorization, its live connection is closed, and its push subscriptions are dropped. No restart needed.

> (Fixed 2026-07-30) Until now, a code minted by `pair` within **the first 5 minutes after the service started** was shadowed by the code minted at process start, so pairing with the fresh code returned a misleading `bad_code`. The newer code on disk now takes over from a still-live startup code, so `pair` takes effect immediately whenever you run it.

#### Why the web admin page was removed (v1.8.0)

Before v1.8.0, `/admin` served a web device-management page. It was **reachable anonymously from the public internet on every reverse-proxied deployment**, so it was removed entirely.

Its only credential was a check that the request came from `127.0.0.1` — but a same-host reverse proxy (Caddy, Nginx, Cloudflare Tunnel, frp — all four setups this guide recommends) connects from exactly that address, so the check passed for *every* request, including anonymous ones from the internet. `POST /admin-api/pair` would then return a working pairing string to anyone who asked, and pairing with it granted full operator access. The admin POST endpoints also had no CSRF protection and could be triggered cross-origin by a malicious page.

The page was localhost-only by design, which means its audience always had a shell — so it could never do anything the commands above cannot, and deleting it removes the attack surface rather than guarding it.

> **If you ran a reverse-proxied deployment on v1.7.x or earlier**, check for unauthorized access: look for `admin_pair_new` events you did not trigger in `<keyDir>/audit.log`, and unfamiliar devices in `pocketshell-agent devices list`. The `POCKETSHELL_ADMIN` environment variable is no longer read; leaving it in a service config does not affect startup.

### Troubleshooting

| Symptom | Where to look |
|---|---|
| Phone can't load the page | Is the Agent running? Is `HOST` still `127.0.0.1`? Is the proxy/tunnel process alive? |
| Page loads but keeps reconnecting | Does the proxy pass WebSocket through (check Nginx `Upgrade` headers)? HTTPS pages must use `wss` |
| Pairing always fails | Pairing code expired (300 s TTL) — run `pocketshell-agent pair` on the Agent machine to mint a new one |
| Agent keeps exiting under launchd/systemd | Check error logs; usually `PATH` missing tmux (macOS) or a non-executable binary |
| Garbled CJK/icons in the terminal | Check the host locale; the Agent already forces UTF-8 via `tmux -u`, so this is rarely needed |
