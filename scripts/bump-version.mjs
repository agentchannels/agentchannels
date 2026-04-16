#!/usr/bin/env node
/**
 * Bump version across package.json, .claude-plugin/plugin.json, and
 * .claude-plugin/marketplace.json so the npm package and the Claude Code
 * plugin cache invalidation stay in sync.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version>    # explicit: 0.2.0
 *   node scripts/bump-version.mjs patch        # 0.1.5 -> 0.1.6
 *   node scripts/bump-version.mjs minor        # 0.1.5 -> 0.2.0
 *   node scripts/bump-version.mjs major        # 0.1.5 -> 1.0.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    path: join(repoRoot, "package.json"),
    update: (json, next) => {
      json.version = next;
    },
  },
  {
    path: join(repoRoot, ".claude-plugin/plugin.json"),
    update: (json, next) => {
      json.version = next;
    },
  },
  {
    path: join(repoRoot, ".claude-plugin/marketplace.json"),
    update: (json, next) => {
      for (const plugin of json.plugins ?? []) {
        plugin.version = next;
      }
    },
  },
];

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function bump(current, kind) {
  const { major, minor, patch } = parseSemver(current);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bump-version.mjs <version | patch | minor | major>");
  process.exit(1);
}

const pkgPath = join(repoRoot, "package.json");
const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;

const next =
  arg === "patch" || arg === "minor" || arg === "major"
    ? bump(current, arg)
    : (parseSemver(arg), arg);

console.log(`Bumping ${current} -> ${next}`);

for (const target of TARGETS) {
  const raw = readFileSync(target.path, "utf8");
  const json = JSON.parse(raw);
  target.update(json, next);
  // Preserve trailing newline if the original had one
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(target.path, JSON.stringify(json, null, 2) + trailingNewline);
  console.log(`  updated ${target.path.replace(repoRoot + "/", "")}`);
}

console.log(`\nDone. Next steps:`);
console.log(`  1. Commit: git add -A && git commit -m "Bump version to ${next}"`);
console.log(`  2. Tag:    git tag v${next}`);
console.log(`  3. Refresh plugin locally:`);
console.log(`       claude plugin marketplace update agentchannels`);
console.log(`       claude plugin update agentchannels@agentchannels`);
