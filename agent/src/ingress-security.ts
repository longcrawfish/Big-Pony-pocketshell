import { isIP } from "node:net";
import { isLocalAddr } from "./net-addr";

export interface IngressPolicy { origins: string[]; trustedProxies: string[]; allowMissingOrigin: boolean }
export function normalizeIp(ip: string): string { return ip.startsWith("::ffff:") ? ip.slice(7) : ip; }
export function requestClientIp(req: Request, peer: string, trusted: string[]): string {
  const ip = normalizeIp(peer);
  if (trusted.map(normalizeIp).includes(ip)) {
    // Proxy MUST replace this header, not append/pass through client input.
    const forwarded = req.headers.get("x-real-ip") ?? "";
    return isIP(forwarded) ? normalizeIp(forwarded) : "";
  }
  // Unknown loopback proxy: apply the GLOBAL unauthenticated quota, never a
  // shared per-IP lockout that one internet client could trigger for everyone.
  return isLocalAddr(ip) ? "" : ip;
}
export function originAllowed(req: Request, policy: IngressPolicy, advertise?: string): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return policy.allowMissingOrigin;
  if (origin === "null") return false;
  const expected = advertise ? new URL(advertise.replace(/^ws/, "http")).origin : new URL(req.url).origin;
  return origin === expected || policy.origins.includes(origin);
}
export const DEFAULT_INGRESS: IngressPolicy = { origins: [], trustedProxies: [], allowMissingOrigin: true };
