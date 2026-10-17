#!/usr/bin/env bash
# Full release: bump -> commit -> gates -> build -> verify -> tag -> publish.
# Dry run builds the CURRENT package version; it never edits source or git refs.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
release_repo=longcrawfish/Big-Pony-pocketshell
version=""
dry_run=0
notes_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --repo) release_repo=${2:?missing repository}; shift ;;
    --notes-file) notes_file=${2:?missing notes file}; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) [ -z "$version" ] || { echo 'Unexpected argument' >&2; exit 2; }; version=$1 ;;
  esac
  shift
done
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Usage: release.sh X.Y.Z [--dry-run] [--repo OWNER/REPO] [--notes-file PATH]' >&2; exit 2; }
# Trust is compiled in. A different release target requires a reviewed source change.
[ "$release_repo" = longcrawfish/Big-Pony-pocketshell ] || { echo 'Release repo differs from the built-in trusted fork' >&2; exit 2; }
for tool in bun git tar shasum; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
[ "$(bun --version)" = "$(cat "$repo_root/.bun-version")" ] || { echo 'Use the pinned Bun version' >&2; exit 1; }
[ -z "$notes_file" ] || [ -f "$notes_file" ] || { echo 'Notes file missing' >&2; exit 1; }
cd "$repo_root"
current=$(bun -e 'const a=require("./app/package.json"), b=require("./agent/package.json"); if(a.version!==b.version) process.exit(1); console.log(a.version)')
if [ "$dry_run" -eq 1 ]; then
  [ "$version" = "$current" ] || { echo "Dry run builds current version $current; requested $version would mislabel artifacts" >&2; exit 2; }
  export POCKETSHELL_ALLOW_DIRTY=1
else
  [ -z "$(git status --porcelain)" ] || { echo 'Working tree must be clean' >&2; exit 1; }
  command -v gh >/dev/null
  gh auth status >/dev/null
  remote=$(git remote get-url origin)
  case "$remote" in
    "https://github.com/$release_repo"|"https://github.com/$release_repo.git"|"git@github.com:$release_repo.git") ;;
    *) echo 'origin does not match the release repository' >&2; exit 1 ;;
  esac
  if git rev-parse "refs/tags/v$version" >/dev/null 2>&1; then echo 'Tag already exists' >&2; exit 1; fi
  bun -e 'const [next,old]=process.argv.slice(1).map(v=>v.split(".").map(Number)); const i=next.findIndex((n,i)=>n!==old[i]); if(i<0||next[i]<old[i]) process.exit(1)' "$version" "$current"
  bun -e 'for(const p of ["app/package.json","agent/package.json"]){const j=await Bun.file(p).json(); j.version=process.argv[1]; await Bun.write(p,JSON.stringify(j,null,2)+"\n")}' "$version"
  git add app/package.json agent/package.json
  git commit -m "release: v$version"
fi
# Frozen installs, both suites and typechecks use the same toolchain as CI.
(cd agent && bun install --frozen-lockfile && bun run typecheck && bun test)
(cd app && bun install --frozen-lockfile && bun run typecheck && bun run test)
(cd agent && POCKETSHELL_BUILD_SIGN=0 POCKETSHELL_BUILD_TARGETS=bun-linux-x64-baseline,bun-linux-arm64,bun-darwin-arm64,bun-darwin-x64 bun run build:bin)
dist="$repo_root/agent/dist"
platforms=(linux-x64 linux-arm64 darwin-arm64 darwin-x64)
archives=()
for platform in "${platforms[@]}"; do
  binary="pocketshell-agent-$platform"
  [ -f "$dist/$binary" ] || { echo "Missing $binary" >&2; exit 1; }
  chmod +x "$dist/$binary"
  archive="$dist/$binary.tar.gz"
  tar -czf "$archive" -C "$dist" "$binary" -C "$repo_root" LICENSE THIRD-PARTY-FONTS.md THIRD-PARTY-THEMES.md
  listing=$(tar -tzf "$archive")
  for member in "$binary" LICENSE THIRD-PARTY-FONTS.md THIRD-PARTY-THEMES.md; do
    [[ $'\n'"$listing"$'\n' == *$'\n'"$member"$'\n'* ]] || { echo "Archive missing $member" >&2; exit 1; }
  done
  archives+=("$binary.tar.gz")
done
(cd "$dist" && shasum -a 256 "${archives[@]}" > SHA256SUMS.txt && shasum -a 256 -c SHA256SUMS.txt)
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) native=linux-x64 ;; Linux-aarch64) native=linux-arm64 ;;
  Darwin-arm64) native=darwin-arm64 ;; Darwin-x86_64) native=darwin-x64 ;;
  *) echo 'Cannot verify native binary version on this host' >&2; exit 1 ;;
esac
built=$("$dist/pocketshell-agent-$native" --version)
if [ "$dry_run" -eq 1 ]; then
  [[ "$built" == "$version-"* ]] || { echo "Unexpected binary version: $built" >&2; exit 1; }
  echo "Dry-run artifacts: $dist ($built). No commit, tag, push or publication."
  exit 0
fi
sha=$(git rev-parse --short HEAD)
[ "$built" = "$version-$sha" ] || { echo "Version/SHA mismatch: $built" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Build changed tracked source; refuse to tag' >&2; exit 1; }
git tag -a "v$version" -m "PocketShell v$version"
git push origin HEAD
git push origin "v$version"
notes_args=(--generate-notes)
[ -z "$notes_file" ] || notes_args=(--notes-file "$notes_file")
assets=()
for archive in "${archives[@]}"; do assets+=("$dist/$archive"); done
gh release create "v$version" --repo "$release_repo" --verify-tag --title "PocketShell v$version" "${notes_args[@]}" "${assets[@]}" "$dist/SHA256SUMS.txt"
