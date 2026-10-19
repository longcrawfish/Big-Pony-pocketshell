// Walk from a pinned directory descriptor. O_NOFOLLOW on ONLY the final
// filename is insufficient: an intermediate directory can be exchanged for
// a symlink between authorization and open. openat keeps each ancestor pinned.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { isAbsolute } from "node:path";

let libc: ReturnType<typeof load> | undefined;
function load() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

export function openPreviewFile(absolute: string): number {
  if (!isAbsolute(absolute) || absolute.includes("\0")) throw new Error("invalid preview path");
  const parts = absolute.split("/").filter(Boolean);
  if (!parts.length || parts.some(p => p === "." || p === "..")) throw new Error("invalid preview path");
  const api = (libc ??= load()).symbols;
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (let i = 0; i < parts.length; i++) {
      const name = Buffer.from(parts[i] + "\0");
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (i < parts.length - 1 ? constants.O_DIRECTORY : 0);
      const next = api.openat(fd, ptr(name), flags, 0);
      if (next < 0) throw new Error("preview path is unavailable or contains a symlink");
      closeSync(fd);
      fd = next;
      if (api.fcntl(fd, 2, 1) < 0) throw new Error("cannot protect preview descriptor"); // FD_CLOEXEC
    }
    if (!fstatSync(fd).isFile()) throw new Error("preview requires a regular file");
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}
