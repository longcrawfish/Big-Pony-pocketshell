// A preview capability contains only these explicitly requested resources.
// The server independently validates every path and file type.
import MarkdownIt from "markdown-it";

export function previewAssets(source: string, kind: string, entry: string): string[] {
  const paths = new Set<string>();
  if (kind !== "markdown") paths.add(entry);
  if (source.length > 128 * 1024 || source.split("\n").length > 3000) return [...paths];
  const html = kind === "markdown" ? new MarkdownIt({ html: false, linkify: false }).render(source) : source;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const dir = entry.slice(0, entry.lastIndexOf("/") + 1);
  for (const el of doc.querySelectorAll(kind === "markdown" ? "img[src]" : "img[src],video[src],source[src],script[src],link[rel=stylesheet][href]")) {
    const value = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
    if (!value || /^(?:[a-z]+:|\/)/i.test(value)) continue;
    let url: URL;
    try { url = new URL(value, "https://preview.invalid/" + dir); } catch { continue; }
    if (url.origin !== "https://preview.invalid") continue;
    let rel: string;
    try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { continue; }
    // Secret files and arbitrary data are never automatically exposed.
    if (rel.split("/").some(p => p.startsWith(".")) || !/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|css|js|mjs|woff2?|ttf|mp4|m4v|webm|mov|ogv)$/i.test(rel)) continue;
    paths.add(rel);
    if (paths.size >= 128) break;
  }
  return [...paths];
}
