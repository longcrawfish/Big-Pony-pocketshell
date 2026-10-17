import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Execute the real script with disposable files and fake publication tools.
// tar and shasum remain real, exercising archive contents and checksums.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ps-release-"));
  for (const dir of ["scripts", "agent", "app", "bin"]) mkdirSync(join(root, dir));
  copyFileSync(resolve(import.meta.dir, "../../scripts/release.sh"), join(root, "scripts/release.sh"));
  writeFileSync(join(root, ".bun-version"), "1.3.14\n");
  for (const p of ["agent", "app"]) writeFileSync(join(root, p, "package.json"), '{"version":"1.0.0"}\n');
  for (const p of ["LICENSE", "THIRD-PARTY-FONTS.md", "THIRD-PARTY-THEMES.md"]) writeFileSync(join(root, p), p);
  const executable = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  executable("git", `echo "git $*" >> "$TEST_ROOT/events"
case "$1" in
  status) ;;
  remote) echo https://github.com/longcrawfish/Big-Pony-pocketshell.git ;;
  rev-parse) if [ "$2" = --short ]; then echo abc1234; else exit 1; fi ;;
esac`);
  executable("gh", 'echo "gh $*" >> "$TEST_ROOT/events"');
  executable("bun", `echo "bun $*" >> "$TEST_ROOT/events"
if [ "$1" = --version ]; then echo 1.3.14; exit; fi
if [ "$1" = -e ]; then
  if [[ "$2" == *'console.log(a.version)'* ]]; then echo 1.0.0; fi
  if [[ "$2" == *'await Bun.write'* ]]; then printf '{"version":"%s"}\\n' "$3" > "$TEST_ROOT/app/package.json"; cp -f "$TEST_ROOT/app/package.json" "$TEST_ROOT/agent/package.json"; fi
  exit
fi
if [ "$1" = run ] && [ "$2" = build:bin ]; then
  mkdir -p "$TEST_ROOT/agent/dist"
  for platform in linux-x64 linux-arm64 darwin-arm64 darwin-x64; do
    printf '#!/bin/sh\\necho %s-abc1234\\n' "$TEST_VERSION" > "$TEST_ROOT/agent/dist/pocketshell-agent-$platform"
    chmod +x "$TEST_ROOT/agent/dist/pocketshell-agent-$platform"
  done
fi`);
  return { root,
    run(version: string, flags: string[]) {
      return Bun.spawnSync(["bash", join(root, "scripts/release.sh"), version, ...flags], {
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TEST_ROOT: root, TEST_VERSION: version },
      });
    }, clean() { rmSync(root, { recursive: true, force: true }); } };
}

test("dry-run packages current version without source, git or publication mutations", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.root, "app/package.json"), "utf8");
    expect(f.run("1.0.0", ["--dry-run"]).exitCode).toBe(0);
    expect(readFileSync(join(f.root, "app/package.json"), "utf8")).toBe(before);
    expect(readFileSync(join(f.root, "events"), "utf8")).not.toMatch(/git (commit|tag|push)|gh release/);
    expect(readFileSync(join(f.root, "agent/dist/SHA256SUMS.txt"), "utf8").trim().split("\n")).toHaveLength(4);
  } finally { f.clean(); }
});
test("dry-run refuses misleading version and wrong repository", () => {
  const f = fixture();
  try {
    expect(f.run("2.0.0", ["--dry-run"]).exitCode).toBe(2);
    expect(f.run("1.0.0", ["--dry-run", "--repo", "upstream/other"]).exitCode).toBe(2);
  } finally { f.clean(); }
});
test("release commits before gates/build and publishes to explicit fork only", () => {
  const f = fixture();
  try {
    expect(f.run("1.1.0", []).exitCode).toBe(0);
    const events = readFileSync(join(f.root, "events"), "utf8");
    expect(events.indexOf("git commit")).toBeLessThan(events.indexOf("bun run typecheck"));
    expect(events.indexOf("bun run build:bin")).toBeLessThan(events.indexOf("git tag"));
    expect(events).toContain("--repo longcrawfish/Big-Pony-pocketshell");
    expect(events).not.toContain("Co-Authored-By");
  } finally { f.clean(); }
});
