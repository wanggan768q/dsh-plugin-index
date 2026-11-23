// Clone every upstream repository listed in `sources.json` next to this repository.
//
// `sync-index.mjs` reads each upstream from `<source root>/<directory>`, so the
// checkout step has to put a real clone there. Locally that directory is usually
// already present; this script is what CI uses.
//
// Usage:
//   node tools/fetch-sources.mjs [--plugin <name>] [--keep-existing]
//
// `--keep-existing` skips a target directory that already holds a clone, so a local
// run does not delete and re-download the working copy next door.
//
// Environment:
//   DSH_INDEX_SOURCE_ROOT  where clones go; defaults to the parent of this repository.

import { execFileSync } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_ROOT = process.env.DSH_INDEX_SOURCE_ROOT || dirname(ROOT);
const pluginIndex = process.argv.indexOf('--plugin');
const ONLY = pluginIndex === -1 ? undefined : process.argv[pluginIndex + 1];
const KEEP_EXISTING = process.argv.includes('--keep-existing');

function git(args) {
  return execFileSync('git', args, { stdio: 'inherit' });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const sources = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  const entries = Object.entries(sources);
  if (entries.length === 0) {
    process.stdout.write('sources.json lists no upstream repositories\n');
    return;
  }
  for (const [name, source] of entries) {
    if (ONLY !== undefined && ONLY !== name) {
      process.stdout.write(`skip ${name}: --plugin ${ONLY} was requested\n`);
      continue;
    }
    if (typeof source.url !== 'string' || source.url === '') {
      throw new Error(`${name}: sources.json entry needs a "url"`);
    }
    if (typeof source.directory !== 'string' || source.directory === '') {
      throw new Error(`${name}: sources.json entry needs a "directory"`);
    }
    const target = isAbsolute(source.directory) ? source.directory : join(SOURCE_ROOT, source.directory);
    if (KEEP_EXISTING && (await exists(target))) {
      process.stdout.write(`keep ${name}: ${target} already exists\n`);
      continue;
    }
    if (await exists(target)) {
      // A stale clone whose tags moved would pin the wrong commit.
      await rm(target, { recursive: true, force: true });
    }
    process.stdout.write(`fetching ${name} -> ${target}\n`);
    git(['clone', '--quiet', '--tags', source.url, target]);
  }
}

main().catch((error) => {
  process.stderr.write(`fetch failed: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
