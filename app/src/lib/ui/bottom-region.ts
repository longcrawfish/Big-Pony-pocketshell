// Device-local preference; temporary editor expansion/collapse is never persisted.
const KEY = "ps.bottomCollapsed";

export function loadBottomCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === "true"; }
  catch { return false; }
}

export function saveBottomCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(KEY, String(collapsed)); }
  catch { /* Storage may be unavailable; the current page still works. */ }
}
