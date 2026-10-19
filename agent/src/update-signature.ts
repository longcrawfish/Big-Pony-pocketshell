import { createPublicKey, verify } from "node:crypto";
import { RELEASE_PUBLIC_KEYS } from "./update-trust";

export interface ReleaseManifest {
  v: 1; keyId: string; repo: string; tag: string;
  assets: Record<string, { sha256: string; size: number }>;
}
export function verifyManifest(bytes: Uint8Array, signature: string, repo: string, tag: string,
  keys: Readonly<Record<string, string>> = RELEASE_PUBLIC_KEYS): ReleaseManifest {
  if (bytes.length > 64 * 1024 || signature.length > 256) throw new Error("invalid signed manifest size");
  const m = JSON.parse(Buffer.from(bytes).toString("utf8")) as ReleaseManifest;
  const pem = Object.hasOwn(keys, m.keyId) ? keys[m.keyId] : undefined;
  if (!pem) throw new Error("no trusted release signing key");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, Buffer.from(signature.trim(), "base64"))) throw new Error("invalid release signature");
  if (m.v !== 1 || m.repo !== repo || m.tag !== tag || !m.assets || typeof m.assets !== "object") throw new Error("release manifest identity mismatch");
  for (const [name, a] of Object.entries(m.assets)) {
    if (!/^pocketshell-agent-(linux|darwin)-(x64|arm64)\.tar\.gz$/.test(name)
      || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 256 * 1024 * 1024) throw new Error("invalid release asset");
  }
  return m;
}

export async function boundedDownload(url: string, limit: number, fetcher: typeof fetch, timeoutMs = 30000): Promise<Uint8Array> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const r = await fetcher(url, { headers: { "User-Agent": "pocketshell-agent" }, signal: abort.signal });
    if (!r.ok || !r.body) throw new Error("download failed");
    if (Number(r.headers.get("content-length")) > limit) throw new Error("download exceeds size limit");
    reader = r.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("download exceeds size limit");
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); abort.abort(); }
}
