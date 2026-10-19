import { createHash } from "node:crypto";

/** Hash the exact embedded inline bootstrap bytes; never allow arbitrary inline JS. */
export function appSecurityHeaders(html: string, advertise?: string): Record<string, string> {
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1])).map(m => `'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`);
  let backend = "", media = "";
  if (advertise) {
    const u = new URL(advertise);
    if (!["ws:", "wss:"].includes(u.protocol)) throw new Error("Invalid advertised backend");
    backend = u.origin;
    media = u.origin.replace(/^ws/, "http");
  }
  return {
    "Content-Security-Policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${media}; media-src 'self' blob: ${media}; font-src 'self' data:; connect-src 'self' ${backend} ${media}; worker-src 'self' blob:; frame-src 'self' ${media}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}
