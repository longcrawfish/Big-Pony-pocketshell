import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, mkdtempSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { assetNameForPlatform, compareSemver } from "./update-core";
import { AGENT_VERSION } from "./version";
import { verifyManifest, boundedDownload } from "./update-signature";

export type Phase = "downloading" | "verifying" | "signing" | "applying" | "restarting" | "error";

export interface ApplyDeps {
  /** Test injection only; production uses the compiled trust store. */
  trustedKeys?: Readonly<Record<string, string>>;
  currentVersion?: string;
  repo: string;
  tag: string;
  keyDir: string;
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
  onPhase: (p: Phase, extra?: { pct?: number; message?: string }) => void;
}

export async function downloadAndVerify(deps: ApplyDeps): Promise<{ binaryPath: string }> {
  const f = deps.fetchImpl ?? fetch;
  const asset = assetNameForPlatform(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!asset) throw new Error("unsupported_platform");
  if (!/^v\d+\.\d+\.\d+$/.test(deps.tag) || compareSemver(deps.tag, deps.currentVersion ?? AGENT_VERSION) <= 0) throw new Error("refusing non-increasing release version");
  const tar = `${asset}.tar.gz`;
  const rel = `https://github.com/${deps.repo}/releases/download/${deps.tag}`;
  const updateDir = join(deps.keyDir, "updates");
  mkdirSync(updateDir, { recursive: true, mode: 0o700 });

  deps.onPhase("downloading");
  const [manifestBytes, signature] = await Promise.all([
    boundedDownload(`${rel}/release-manifest.json`, 64 * 1024, f),
    boundedDownload(`${rel}/release-manifest.sig`, 256, f),
  ]);
  const manifest = verifyManifest(manifestBytes, Buffer.from(signature).toString(), deps.repo, deps.tag, deps.trustedKeys);
  const entry = Object.hasOwn(manifest.assets, tar) ? manifest.assets[tar] : undefined;
  if (!entry) throw new Error("missing signed asset");
  const tgz = await boundedDownload(`${rel}/${tar}`, entry.size, f);

  deps.onPhase("verifying");
  const want = entry.sha256;
  const got = createHash("sha256").update(tgz).digest("hex");
  if (want !== got || tgz.length !== entry.size) throw new Error(`checksum or size mismatch for ${tar}`);

  const outDir = mkdtempSync(join(updateDir, "verified-"));
  const tgzPath = join(outDir, tar);
  await Bun.write(tgzPath, tgz);
  // Extract only the binary (archive also carries LICENSE).
  await $`tar -xzf ${tgzPath} -C ${outDir} ${asset}`.quiet();
  const binaryPath = join(outDir, asset);
  if (!lstatSync(binaryPath).isFile()) throw new Error("release binary is not a regular file");
  chmodSync(binaryPath, 0o755);
  return { binaryPath };
}
