#!/usr/bin/env bash
set -euo pipefail
# Each named development instance owns a socket, identity and FIFO directory.
repo_root=$(cd "$(dirname "$0")/.." && pwd)
instance=${1:-dev}
[[ "$instance" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid instance name' >&2; exit 1; }
dev_root="$repo_root/.dev/$instance"
mkdir -p "$dev_root"
chmod 700 "$dev_root"
export POCKETSHELL_KEY_DIR="$dev_root/keys"
export POCKETSHELL_RUN_DIR="$dev_root/run"
export POCKETSHELL_TMUX_SOCKET="$dev_root/tmux.sock"
export POCKETSHELL_PORT=${POCKETSHELL_PORT:-18722}
export POCKETSHELL_HOST=127.0.0.1
export POCKETSHELL_UPDATE=0
unset TMUX TMUX_PANE POCKETSHELL_PANE_TAP
cd "$repo_root/agent"
exec bun run src/server.ts
