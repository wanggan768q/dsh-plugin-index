// Discover DSH plugin repositories owned by one GitHub user and add them to sources.json.
//
// `sync-index.mjs` only reads what `sources.json` lists, so a new plugin upstream would
// stay invisible until someone edited that file by hand. This script closes that gap:
// it lists the owner's repositories, keeps the ones that look like a DSH bundle, and
// adds every missing one.
//
// A repository is added only when all of these hold:
// - it is owned by `DSH_INDEX_OWNER`, its name starts with `DSH_INDEX_REPO_PREFIX`,
//   it is neither a fork nor archived, and it is not this index repository;
// - its `package.json` on the default branch declares `dsh.bundle.patch`, which is what
//   makes a package loadable as a profile bundle at all;
// - it has at least one release tag, because a source with no tagged release can never
//   contribute a `versions[]` entry and would only break the index invariants.
//
// Existing entries are never rewritten, so hand edits in `sources.json` survive.
//
// Usage:
//   node tools/discover-sources.mjs [--dry-run]
//
// Environment:
//   GITHUB_TOKEN / GH_TOKEN  API credential; without one `gh auth token` is tried and
//                            the run then falls back to unauthenticated requests.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasReleaseTag, isAuthenticated, isBundle, listOwnerRepositories, readManifest } from './github-api.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES_PATH = join(ROOT, 'sources.json');
const OWNER = process.env.DSH_INDEX_OWNER || 'wanggan768q';
const REPO_PREFIX = process.env.DSH_INDEX_REPO_PREFIX || 'dsh-';
const SELF = process.env.DSH_INDEX_SELF || 'dsh-plugin-index';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const knownRepositories = new Set(Object.values(sources).map((source) => String(source.url).replace(/\.git$/u, '')));
  const claimedNames = new Set(Object.keys(sources));
  const lines = [];
  const log = (line) => lines.push(line);
  const added = [];

  log(`discovering ${OWNER} repositories named ${REPO_PREFIX}*`);
  if (!isAuthenticated()) log('note: no API token; unauthenticated limits may cut the run short');

  const repositories = await listOwnerRepositories(OWNER);
  log(`  ${String(repositories.length)} repository(ies) listed`);

  for (const repository of repositories) {
    const { name } = repository;
    if (!name.startsWith(REPO_PREFIX) || name === SELF) continue;
    if (repository.fork || repository.archived) {
      log(`  skip ${name}: fork or archived`);
      continue;
    }
    const url = `https://github.com/${OWNER}/${name}`;
    if (knownRepositories.has(url)) continue;

    const manifest = await readManifest(OWNER, name, repository.default_branch);
    if (!isBundle(manifest)) {
      log(`  skip ${name}: package.json declares no dsh.bundle`);
      continue;
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      log(`  skip ${name}: package.json declares no name`);
      continue;
    }
    if (claimedNames.has(manifest.name)) {
      log(`  skip ${name}: package ${manifest.name} is already a source`);
      continue;
    }
    if (!(await hasReleaseTag(OWNER, name))) {
      log(`  skip ${name}: no release tag to index yet`);
      continue;
    }

    sources[manifest.name] = { url, directory: name, allowMajor: false };
    claimedNames.add(manifest.name);
    knownRepositories.add(url);
    added.push(manifest.name);
    log(`  add ${manifest.name} <- ${url}`);
  }

  if (added.length === 0) log('  no new plugin repository');
  else if (DRY_RUN) log('dry run: sources.json not written');
  else {
    const sorted = Object.fromEntries(Object.entries(sources).sort(([left], [right]) => (left < right ? -1 : 1)));
    await writeFile(SOURCES_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    log('sources.json updated');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`discover failed: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
