// Pure HTTP handler for /preview/<token>/<relpath>. Kept out of server.ts so
// the routing/hardening decisions are unit-testable without spinning a server.
import { fstatSync, readSync, closeSync } from "node:fs";
import { openPreviewFile } from "./preview-open";
import { PreviewTokens, contentTypeFor, parseRange } from "./preview-service";

// Sandbox applies even on top-level loads. Resource requests remain limited
// by the server-side manifest, regardless of what scripts or CSP can do.
export function previewHeaders(scripts = false): Record<string, string> {
  return {
    "referrer-policy": "no-referrer", "cache-control": "no-store",
    "content-security-policy": `sandbox${scripts ? " allow-scripts" : ""}; default-src 'none'; script-src ${scripts ? "'self' 'unsafe-inline'" : "'none'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    "x-content-type-options": "nosniff",
  };
}

// Streaming from the already-authorized descriptor avoids reopening a path.
// Cancellation, EOF, errors and a bounded stalled-response lifetime close it.
function fileStream(fd: number, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start, closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(fd); } clearTimeout(timer); };
  const timer = setTimeout(close, 120_000);
  timer.unref();
  return new ReadableStream({
    pull(controller) {
      try {
        if (closed) throw new Error("preview stream expired");
        if (position > end) { close(); controller.close(); return; }
        const buf = new Uint8Array(Math.min(64 * 1024, end - position + 1));
        const n = readSync(fd, buf, 0, buf.length, position);
        if (!n) { close(); controller.close(); return; }
        position += n; controller.enqueue(buf.subarray(0, n));
        if (position > end) { close(); controller.close(); }
      } catch (e) { close(); controller.error(e); }
    },
    cancel() { close(); },
  });
}

export function buildPreviewResponse(
  pt: PreviewTokens,
  url: URL,
  now: number,
  rangeHeader?: string | null,
): Response {
  // /preview/<token>/<relpath...>
  const rest = url.pathname.slice("/preview/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return new Response("bad request", { status: 400 });
  const token = rest.slice(0, slash);
  let relpath: string;
  try { relpath = decodeURIComponent(rest.slice(slash + 1)); }
  catch { return new Response("bad request", { status: 400 }); } // malformed %-escape
  const abs = pt.resolve(token, relpath, now);
  if (!abs) return new Response("forbidden", { status: 403 });

  const HARDENING = previewHeaders(pt.scripts(token));
  let size: number, fd: number;
  try { fd = openPreviewFile(abs); size = fstatSync(fd).size; }
  catch { return new Response("not found", { status: 404, headers: HARDENING }); }
  const ct = contentTypeFor(abs);
  const range = parseRange(rangeHeader ?? null, size);

  if (range === "unsatisfiable") {
    closeSync(fd);
    return new Response("range not satisfiable", {
      status: 416,
      headers: { ...HARDENING, "content-range": `bytes */${size}` },
    });
  }

  if (range) {
    const { start, end } = range;
    return new Response(fileStream(fd, start, end), {   // slice end is exclusive
      status: 206,
      headers: {
        ...HARDENING,
        "content-type": ct,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }

  // accept-ranges advertises seek support so the browser knows it MAY send a
  // Range request for this resource (video controls depend on seeing it).
  return new Response(fileStream(fd, 0, size - 1), {
    status: 200,
    headers: {
      ...HARDENING,
      "content-type": ct,
      "accept-ranges": "bytes",
      "content-length": String(size),
    },
  });
}
