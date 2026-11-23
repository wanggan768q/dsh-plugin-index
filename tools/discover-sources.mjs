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

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES_PATH = join(ROOT, 'sources.json');
const OWNER = process.env.DSH_INDEX_OWNER || 'wanggan768q';
const REPO_PREFIX = process.env.DSH_INDEX_REPO_PREFIX || 'dsh-';
const SELF = process.env.DSH_INDEX_SELF || 'dsh-plugin-index';
const API = 'https://api.github.com';
const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DRY_RUN = process.argv.includes('--dry-run');

/** The API token, from the environment or the `gh` CLI when it is logged in. */
function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

const TOKEN = resolveToken();

/** One API request; returns `undefined` for 404 so a deleted repository is skipped, not fatal. */
async function api(path, retryWithoutAuth = true) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-index',
      ...TOKEN === undefined ? {} : { authorization: `Bearer ${TOKEN}` },
    },
  });
  if (response.status === 404) return undefined;
  // A token scoped to only this repository can still read other public repositories
  // anonymously, so an auth rejection is retried once without the credential.
  if ((response.status === 401 || response.status === 403) && TOKEN !== undefined && retryWithoutAuth) {
    return api(path, false);
  }
  if (!response.ok) throw new Error(`GET ${path} -> ${String(response.status)} ${await response.text()}`);
  return response.json();
}

async function listRepositories() {
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/users/${OWNER}/repos?per_page=100&type=owner&sort=updated&page=${String(page)}`);
    if (batch === undefined || batch.length === 0) break;
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  return repositories;
}

/** The repository's `package.json` on its default branch, or `undefined` when unreadable. */
async function readManifest(repository) {
  const file = await api(`/repos/${OWNER}/${repository.name}/contents/package.json?ref=${encodeURIComponent(repository.default_branch)}`);
  if (file === undefined || typeof file.content !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

async function hasReleaseTag(repository) {
  const tags = await api(`/repos/${OWNER}/${repository.name}/tags?per_page=100`);
  if (tags === undefined) return false;
  return tags.some((tag) => SEMVER_TAG.test(tag.name));
}

function isBundle(manifest) {
  const patch = manifest?.dsh?.bundle?.patch;
  return typeof patch === 'string' || (Array.isArray(patch) && patch.length > 0);
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const knownRepositories = new Set(Object.values(sources).map((source) => String(source.url).replace(/\.git$/u, '')));
  const claimedNames = new Set(Object.keys(sources));
  const lines = [];
  const log = (line) => lines.push(line);
  const added = [];

  log(`discovering ${OWNER} repositories named ${REPO_PREFIX}*`);
  if (TOKEN === undefined) log('note: no API token; unauthenticated limits may cut the run short');

  const repositories = await listRepositories();
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

    const manifest = await readManifest(repository);
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
    if (!(await hasReleaseTag(repository))) {
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
