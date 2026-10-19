// Run only on the release machine. The private key stays outside the repo.
import { readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEYS } from "../src/update-trust";
import { verifyManifest, type ReleaseManifest } from "../src/update-signature";
import { OFFICIAL_UPDATE_REPO } from "../src/config";

const file = process.env.POCKETSHELL_SIGNING_KEY_FILE;
if (!file || (statSync(file).mode & 0o077)) throw new Error("A private signing key file with mode 0600 is required");
const key = createPrivateKey(readFileSync(file));
if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
const publicDer = createPublicKey(key.export({ type: "pkcs8", format: "pem" })).export({ type: "spki", format: "der" });
const keyId = Object.keys(RELEASE_PUBLIC_KEYS).find(id =>
  createPublicKey(RELEASE_PUBLIC_KEYS[id]).export({ type: "spki", format: "der" }).equals(publicDer));
if (!keyId) throw new Error("Signing key is not in the reviewed, compiled public-key trust store");
if (process.argv[2] !== "--check") {
  const [dir, tag] = process.argv.slice(2);
  if (!dir || !/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Usage: sign-release.ts DIST vX.Y.Z");
  const manifest: ReleaseManifest = { v: 1, keyId, repo: OFFICIAL_UPDATE_REPO, tag, assets: {} };
  for (const name of readdirSync(dir).filter(n => /^pocketshell-agent-(linux|darwin)-(x64|arm64)\.tar\.gz$/.test(n)).sort()) {
    const bytes = readFileSync(join(dir, name));
    manifest.assets[name] = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  if (Object.keys(manifest.assets).length !== 4) throw new Error("Expected four release platforms");
  const bytes = Buffer.from(JSON.stringify(manifest) + "\n");
  const signature = sign(null, bytes, key).toString("base64");
  verifyManifest(bytes, signature, OFFICIAL_UPDATE_REPO, tag);
  writeFileSync(join(dir, "release-manifest.json"), bytes);
  writeFileSync(join(dir, "release-manifest.sig"), signature + "\n");
}
