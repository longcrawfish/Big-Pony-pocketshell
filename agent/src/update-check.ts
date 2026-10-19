import { AGENT_VERSION } from "./version";
import { hasUpdate, assetNameForPlatform } from "./update-core";
import { boundedDownload } from "./update-signature";

export interface CheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  notes: string;
  publishedAt: string | null;
  canApply: boolean;
  reason?: string;
}

const CHECK_TIMEOUT_MS = 8000;

export async function checkLatest(opts: {
  repo: string | null;
  current?: string;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
}): Promise<CheckResult> {
  const current = opts.current ?? AGENT_VERSION;
  const base: CheckResult = { current, latest: null, hasUpdate: false, notes: "", publishedAt: null, canApply: false };

  if (!opts.repo) return { ...base, reason: "disabled" };

  const f = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  let data: { tag_name?: string; body?: string; published_at?: string };
  try {
    // process env proxies (HTTPS_PROXY/HTTP_PROXY/NO_PROXY) are honored by Bun's
    // fetch automatically, so China networks can route through a local proxy.
    const bytes = await boundedDownload(`https://api.github.com/repos/${opts.repo}/releases/latest`, 1024 * 1024, f, CHECK_TIMEOUT_MS);
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!data || typeof data.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(data.tag_name)
      || (data.body != null && typeof data.body !== "string")
      || (data.published_at != null && typeof data.published_at !== "string")) return { ...base, reason: "no_release_info" };
  } catch {
    return { ...base, reason: "no_release_info" };
  }

  const tag = (data.tag_name ?? "").replace(/^v/, "");
  if (!tag) return { ...base, reason: "no_release_info" };
  const upd = hasUpdate(current, tag);
  const supported = assetNameForPlatform(platform, arch) !== null;
  const canApply = upd && supported;
  return {
    current,
    latest: tag,
    hasUpdate: upd,
    notes: data.body ?? "",
    publishedAt: data.published_at ?? null,
    canApply,
    reason: !supported ? "unsupported_platform" : undefined,
  };
}
