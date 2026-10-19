import { test, expect } from "bun:test";
import { downloadAndVerify } from "./update-apply";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

// Build a minimal gzip tarball in memory with one file, return {bytes, sha}.
// Use Bun's tar? Simpler: shell out to tar in the test to craft a real archive.
import { $ } from "bun";

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the latter defaults
// to `ArrayBufferLike`, which may be a SharedArrayBuffer and so is not a valid
// Response body. Bun.file().arrayBuffer() always yields a real ArrayBuffer.
async function makeArchive(dir: string, binName: string): Promise<{ buf: Uint8Array<ArrayBuffer>; sha: string }> {
  await Bun.write(join(dir, binName), "#!/bin/sh\necho stub\n");
  await $`chmod +x ${join(dir, binName)}`;
  await $`tar -czf ${join(dir, binName + ".tar.gz")} -C ${dir} ${binName}`;
  const buf = new Uint8Array(await Bun.file(join(dir, binName + ".tar.gz")).arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  return { buf, sha };
}

const keypair = generateKeyPairSync("ed25519");
const trustedKeys = { test: keypair.publicKey.export({ type: "spki", format: "pem" }).toString() };
function signedFetch(buf: Uint8Array<ArrayBuffer>, sha: string, corruptManifest = false) {
  const manifest = Buffer.from(JSON.stringify({ v: 1, keyId: "test", repo: "x/y", tag: "v0.4.0",
    assets: { "pocketshell-agent-linux-x64.tar.gz": { size: buf.length, sha256: sha } } }));
  const signature = sign(null, manifest, keypair.privateKey).toString("base64");
  return (async (url: string) => {
    if (String(url).endsWith("release-manifest.json")) return new Response(corruptManifest ? Buffer.from(manifest.toString().replace(sha, "f".repeat(64))) : manifest);
    if (String(url).endsWith("release-manifest.sig")) return new Response(signature);
    return new Response(buf);
  }) as unknown as typeof fetch;
}

test("signed release verifies before extracting the binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-signed-"));
  const { buf, sha } = await makeArchive(dir, "pocketshell-agent-linux-x64");
  const { binaryPath } = await downloadAndVerify({ repo: "x/y", tag: "v0.4.0", currentVersion: "0.3.0",
    keyDir: dir, platform: "linux", arch: "x64", trustedKeys, fetchImpl: signedFetch(buf, sha), onPhase: () => {} });
  expect(await Bun.file(binaryPath).text()).toContain("stub");
});

for (const mode of ["bad-checksum", "modified-manifest", "untrusted-key", "downgrade"]) {
  test(`signed release refuses ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-signed-fail-"));
    const { buf, sha } = await makeArchive(dir, "pocketshell-agent-linux-x64");
    await expect(downloadAndVerify({ repo: "x/y", tag: "v0.4.0", currentVersion: mode === "downgrade" ? "0.5.0" : "0.3.0",
      keyDir: dir, platform: "linux", arch: "x64", trustedKeys: mode === "untrusted-key" ? {} : trustedKeys,
      fetchImpl: signedFetch(buf, mode === "bad-checksum" ? "0".repeat(64) : sha, mode === "modified-manifest"), onPhase: () => {},
    })).rejects.toThrow();
  });
}

for (const failure of ["network", "missing-checksum", "missing-asset"]) {
  test(`failed download ${failure} preserves the installed binary and identity`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-download-failure-"));
    const target = join(dir, "agent"), key = join(dir, "agent_key");
    await Bun.write(target, "old"); await Bun.write(key, "identity");
    const fetchImpl = (async () => {
      if (failure === "network") throw new Error("offline");
      if (failure === "missing-asset") return new Response("missing", { status: 404 });
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(downloadAndVerify({ repo: "longcrawfish/Big-Pony-pocketshell", tag: "v1.22.0",
      keyDir: dir, platform: "linux", arch: "x64", fetchImpl, onPhase: () => {} })).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe("old");
    expect(await Bun.file(key).text()).toBe("identity");
  });
}
