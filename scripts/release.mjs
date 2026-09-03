#!/usr/bin/env node
// Cut a release: bump every workspace package.json, move the Unreleased changelog section under the new
// version, commit, tag vX.Y.Z, push, and create the GitHub release. docs/RELEASE.md describes the process.
//
//   pnpm release 0.2.0            # full release
//   pnpm release 0.2.0 --dry-run  # print what would happen
//   pnpm release 0.2.0 --no-push  # commit and tag only
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..');
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const push = !args.includes('--no-push');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: pnpm release <major.minor.patch> [--dry-run] [--no-push]');
  process.exit(2);
}
const tag = `v${version}`;
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString().trim();
const run = (cmd) => {
  console.log(`$ ${cmd}`);
  if (!dryRun) sh(cmd, { stdio: 'inherit' });
};

// Preconditions: clean tree, tag unused, changelog has an Unreleased section with content.
if (sh('git status --porcelain')) {
  console.error('working tree is not clean; commit or stash first');
  process.exit(1);
}
if (sh(`git tag --list ${tag}`)) {
  console.error(`${tag} already exists`);
  process.exit(1);
}
const changelogPath = join(root, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
const m = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
const notes = (m?.[1] ?? '').trim();
if (!notes) {
  console.error('CHANGELOG.md has no entries under "## Unreleased"');
  process.exit(1);
}

// Bump every workspace package.json that carries a version.
const files = sh("git ls-files '*package.json' 'apps/*/package.json' 'packages/*/package.json'").split('\n').filter(Boolean);
for (const f of files) {
  const p = join(root, f);
  const json = JSON.parse(readFileSync(p, 'utf8'));
  if (!json.version) continue;
  json.version = version;
  console.log(`${f}: ${version}`);
  if (!dryRun) writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
}

// Changelog: Unreleased becomes the version heading with today's date; a fresh Unreleased goes above it.
const date = new Date().toISOString().slice(0, 10);
const updated = changelog.replace(/^## Unreleased\n/m, `## Unreleased\n\n## ${version} (${date})\n`);
if (!dryRun) writeFileSync(changelogPath, updated);

run(`git add -A`);
run(`git commit -m "Release ${tag}"`);
run(`git tag -a ${tag} -m "Release ${tag}"`);
if (push) {
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  run(`git push origin ${branch}`);
  run(`git push origin ${tag}`);
  const notesFile = join(root, '.release-notes.tmp');
  if (!dryRun) writeFileSync(notesFile, notes + '\n');
  run(`gh release create ${tag} --title "${tag}" --notes-file ${notesFile}`);
  run(`rm -f ${notesFile}`);
}
console.log(dryRun ? `dry run for ${tag} complete` : `${tag} released`);
