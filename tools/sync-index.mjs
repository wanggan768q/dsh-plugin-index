// Sync `index.json` from the upstream repositories listed in `sources.json`.
//
// For every source this script reads the upstream `package.json` at each release tag
// (lightweight or annotated), keeps the tags whose manifest declares the tag's own
// version, and merges every such version into the matching `plugins[]` entry.
//
// Design rules:
// - Manual metadata (title, description, icon, author, homepage, repository,
//   metadata) belongs to `index.json` and is never touched; only `versions` grows.
// - A release is appended only when its tag points at a commit reachable from the
//   upstream default branch head. A tag that points elsewhere is skipped, so the
//   index never pins a SHA that a fresh clone cannot fetch.
// - Every valid tag is backfilled, not only the newest, so a release pushed between
//   two runs still reaches the index.
// - An `engines.dsh` move to another DSH minor line aborts the run unless
//   `allowMajor` is set on the source; that range change needs a human decision.
// - `--dry-run` prints the plan without writing.
// - Nothing is written when the computed index is unchanged.
// - Relative `directory` values resolve against the parent of this repository, which
//   matches the local `E:\Git\<repo>` layout. Set `DSH_INDEX_SOURCE_ROOT` to resolve
//   them somewhere else, such as a CI checkout directory.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(ROOT, 'index.json');
const SOURCES_PATH = join(ROOT, 'sources.json');
const SOURCE_ROOT = process.env.DSH_INDEX_SOURCE_ROOT || dirname(ROOT);
const SEMVER_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const DRY_RUN = process.argv.includes('--dry-run');

class SyncError extends Error {}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function firstLine(error) {
  return String(error.message ?? error).split('\n')[0];
}

/** Compare two SemVer strings without pulling in a dependency. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const withoutBuild = value.split('+')[0];
    const dash = withoutBuild.indexOf('-');
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);
    return {
      numbers: core.split('.').map(Number),
      pre: prerelease === '' ? [] : prerelease.split('.'),
      hasPre: prerelease !== '',
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.hasPre !== b.hasPre) return a.hasPre ? -1 : 1;
  if (!a.hasPre) return 0;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/u.test(x);
    const numericY = /^\d+$/u.test(y);
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (numericX !== numericY) {
      return numericX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function readManifestAt(repoDir, commit, log) {
  try {
    return JSON.parse(git(['-C', repoDir, 'show', `${commit}:package.json`]));
  } catch (error) {
    log(`    skip ${commit.slice(0, 12)}: package.json unreadable (${firstLine(error)})`);
    return undefined;
  }
}

/**
 * Resolve every publishable release for one source, newest first.
 * Each release is a tag whose name is an exact SemVer, whose commit is reachable from
 * the upstream head, and whose `package.json` at that commit declares the same version
 * and the same package name the index entry uses.
 * @returns {Array<{ version: string, commit: string, manifest: object, timestamp: number }>}
 */
function resolveReleases(repoDir, pluginName, log) {
  let tags;
  try {
    tags = git(['-C', repoDir, 'tag', '--list']).split('\n').filter(Boolean);
  } catch (error) {
    throw new SyncError(`cannot list tags in ${repoDir}: ${firstLine(error)}`);
  }
  const candidates = tags
    .map((tag) => ({ tag, version: SEMVER_TAG.exec(tag)?.[1] }))
    .filter((entry) => entry.version !== undefined)
    .sort((left, right) => compareVersions(right.version, left.version));
  if (candidates.length === 0) throw new SyncError(`no release tags in ${repoDir}`);

  let reachable;
  try {
    reachable = new Set(git(['-C', repoDir, 'rev-list', 'HEAD']).split('\n'));
  } catch (error) {
    throw new SyncError(`cannot list commits in ${repoDir}: ${firstLine(error)}`);
  }

  const releases = [];
  for (const { tag, version } of candidates) {
    let commit;
    try {
      // `rev-list` peels an annotated tag down to the commit it names.
      commit = git(['-C', repoDir, 'rev-list', '-n', '1', tag]);
    } catch (error) {
      log(`    skip ${tag}: cannot resolve tag (${firstLine(error)})`);
      continue;
    }
    if (!reachable.has(commit)) {
      log(`    skip ${tag}: commit ${commit.slice(0, 12)} is not reachable from HEAD`);
      continue;
    }
    const manifest = readManifestAt(repoDir, commit, log);
    if (manifest === undefined) continue;
    if (manifest.version !== version) {
      log(`    skip ${tag}: tag says ${version}, package.json says ${String(manifest.version)}`);
      continue;
    }
    // The index name becomes the install spec and the profile's dependency key, so a
    // rename upstream must land here as a rename, not as a version under the old name.
    if (manifest.name !== pluginName) {
      log(`    skip ${tag}: package.json names ${String(manifest.name)}, index entry is ${pluginName}`);
      continue;
    }
    if (manifest.private !== true) {
      log(`    note ${tag}: manifest is not private, so npm install would also work`);
    }
    let timestamp;
    try {
      timestamp = Number(git(['-C', repoDir, 'show', '-s', '--format=%ct', commit]));
    } catch (error) {
      throw new SyncError(`cannot read commit time for ${tag}: ${firstLine(error)}`);
    }
    releases.push({ version, commit, manifest, timestamp });
  }
  return releases;
}

/** The `major.minor` of a DSH range's lower bound, which is what `engines.dsh` gates on. */
function dshLine(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(range));
  return match === null ? undefined : `${match[1]}.${match[2]}`;
}

/**
 * Build one `versions[]` entry.
 * @param previous the highest already-indexed version entry, used to detect an
 *   `engines.dsh` line change.
 */
function versionEntry(release, previous, plugin, source, log) {
  const range = release.manifest.engines?.dsh;
  const previousRange = previous?.engines?.dsh;
  if (range !== undefined && previousRange !== undefined && String(range) !== previousRange) {
    const line = dshLine(range);
    const previousLine = dshLine(previousRange);
    // A new DSH minor line means the plugin targets a different harness generation;
    // that is a decision for a human, not something a tag should silently flip.
    if (line !== previousLine && source.allowMajor !== true) {
      throw new SyncError(
        `${plugin.name}: engines.dsh moved from ${previousRange} to ${String(range)}; `
          + 'set allowMajor in sources.json after confirming the new DSH range',
      );
    }
    log(`    note ${release.version}: engines.dsh is ${String(range)} (was ${previousRange})`);
  }
  const entry = {
    version: release.version,
    publishTimestamp: release.timestamp,
    source: {
      type: 'git',
      url: plugin.repository?.url ?? previous?.source?.url ?? source.url,
      commit: release.commit,
    },
  };
  if (range !== undefined) entry.engines = { dsh: String(range) };
  else if (previousRange !== undefined) entry.engines = { dsh: previousRange };
  return entry;
}

async function main() {
  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const lines = [];
  const log = (line) => lines.push(line);
  let changed = false;

  for (const [pluginName, source] of Object.entries(sources)) {
    if (source.directory === undefined || source.directory === '') {
      throw new SyncError(`${pluginName}: sources.json entry needs a "directory"`);
    }
    const repoDir = isAbsolute(source.directory) ? source.directory : join(SOURCE_ROOT, source.directory);
    log(`${pluginName}  <-  ${repoDir}`);

    const releases = resolveReleases(repoDir, pluginName, log);
    if (releases.length === 0) {
      log('    no publishable release; index unchanged for this plugin');
      continue;
    }

    let plugin = index.plugins.find((entry) => entry.name === pluginName);
    if (plugin === undefined) {
      plugin = { name: pluginName, title: { en: pluginName }, metadata: {}, versions: [] };
      index.plugins.push(plugin);
      log(`    created a new plugins[] entry for ${pluginName}`);
    }

    // Backfill every tagged release, not only the newest: a tag pushed between two runs
    // would otherwise never reach the index. Releases arrive newest first, so the first
    // one compared against the existing index is the version a fresh install picks.
    for (const release of releases) {
      const existing = plugin.versions.find((entry) => entry.version === release.version);
      if (existing !== undefined && existing.source?.commit === release.commit) {
        log(`    ${release.version} already indexed at ${release.commit.slice(0, 12)}`);
        continue;
      }
      const newest = [...plugin.versions].sort((left, right) => compareVersions(right.version, left.version))[0];
      const entry = versionEntry(release, newest, plugin, source, log);
      if (existing === undefined) plugin.versions.push(entry);
      else Object.assign(existing, entry);
      log(`    ${existing === undefined ? 'indexed' : 'refreshed'} ${release.version} -> ${release.commit}`);
      changed = true;
    }
  }

  for (const plugin of index.plugins) {
    plugin.versions.sort((left, right) => compareVersions(right.version, left.version));
  }

  if (DRY_RUN) log('dry run: index.json not written');
  else if (changed) {
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    log('index.json updated');
  } else log('index.json already up to date');

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  if (error instanceof SyncError) {
    process.stderr.write(`sync failed: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
});
