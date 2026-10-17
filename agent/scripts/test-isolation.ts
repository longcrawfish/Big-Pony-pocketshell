// Preloaded by bun test, before any test can construct TerminalService.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ps-tests-"));
process.env.POCKETSHELL_TMUX_SOCKET = join(root, "tmux.sock");
process.env.POCKETSHELL_RUN_DIR = join(root, "run");
process.env.POCKETSHELL_KEY_DIR = join(root, "keys");
process.env.POCKETSHELL_UPDATE = "0";
delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.POCKETSHELL_PANE_TAP;
process.on("exit", () => {
  Bun.spawnSync(["tmux", "-S", join(root, "tmux.sock"), "kill-server"], { stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
});
