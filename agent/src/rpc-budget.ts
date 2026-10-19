// Shared across a device's sockets. Terminal input and transfer chunks have
// their own frame/size bounds and must not consume the interactive RPC budget.
const EXPENSIVE = new Set(["fs.archive", "fs.diff", "git.review", "git.log", "term.history", "term.capture", "preview.mint", "notify.testWebhook", "update.check", "update.apply"]);
export function createRpcBudget(now = Date.now) {
  const devices = new Map<string, { tokens: number; at: number }>();
  return (device: string, method: string): boolean => {
    if (!EXPENSIVE.has(method)) return true;
    const t = now();
    let entry = devices.get(device);
    if (!entry) {
      for (const [key, e] of devices) if (t - e.at >= 60_000) devices.delete(key);
      if (devices.size >= 2048) return false;
      entry = { tokens: 60, at: t };
      devices.set(device, entry);
    }
    entry.tokens = Math.min(60, entry.tokens + Math.max(0, t - entry.at) / 1000);
    entry.at = t;
    if (entry.tokens < 1) return false;
    entry.tokens--;
    return true;
  };
}
