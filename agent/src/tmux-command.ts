import { isAbsolute } from "node:path";

/** One argv builder for every tmux entry point, including warmup and CLI. */
export function tmuxCommand(args: string[], socket = process.env.POCKETSHELL_TMUX_SOCKET): string[] {
  if (socket !== undefined && (!socket || !isAbsolute(socket))) {
    throw new Error("POCKETSHELL_TMUX_SOCKET must be an absolute socket path");
  }
  return socket ? ["tmux", "-S", socket, "-f", "/dev/null", ...args] : ["tmux", ...args];
}
