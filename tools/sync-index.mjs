// Sync `index.json` from the upstream repositories listed in `sources.json`.
//
// For every source this script reads the upstream `package.json` at each release tag
// (lightweight or annotated), keeps the tags whose manifest declares the tag's own
// version, and merges every such version into the matching `plugins[]` entry.
//
// Design rules:
// - Manual metadata (title, description, icon, author, homepage, repository,
//   metadata) belongs to `index.json` and is never touched; only `versions` grows.
//   A plugin the index does not carry yet is created from the manifest's own fields,
//   so a freshly discovered repository needs no hand-written entry.
// - A release is appended only when its tag points at a commit reachable from the
//   upstream default branch head. A tag that points elsewhere is skipped, so the
//   index never pins a SHA that a fresh clone cannot fetch.
// - A release whose manifest names a different package than the index entry is
//   skipped: the index name becomes the install spec, so a rename has to arrive as
//   a rename rather than as a version under a stale name.
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareVersions } from './compare-versions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(ROOT, 'index.json');
const SOURCES_PATH = join(ROOT, 'sources.json');
const ICONS_DIR = join(ROOT, 'icons');
const SOURCE_ROOT = process.env.DSH_INDEX_SOURCE_ROOT || dirname(ROOT);
const SEMVER_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
// `package.json.dsh.icon` is a file at most 256 KiB, which is also what the market
// parser accepts for an inline icon; larger files are skipped rather than truncated.
const MAX_ICON_BYTES = 256 * 1024;
const DRY_RUN = process.argv.includes('--dry-run');

class SyncError extends Error {}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitBuffer(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function firstLine(error) {
  return String(error.message ?? error).split('\n')[0];
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
  // An automatically discovered source is guaranteed a tag when it is added, but a tag
  // deleted afterwards must not fail the whole run: the plugin simply stops contributing
  // versions until it releases again, and the other sources still sync.
  if (candidates.length === 0) {
    log(`    no SemVer tag in ${repoDir}`);
    return [];
  }

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

/**
 * Copy the icon a release declares into `icons/`, so the market shows the upstream
 * artwork without a second copy of it living in two places. A repository whose
 * manifest declares no icon, or one that is not a web image, keeps no icon at all.
 * @returns the index-relative path, or `undefined` when there is nothing to import.
 */
async function importIcon(repoDir, manifest, pluginName, log) {
  const declared = manifest.dsh?.icon ?? manifest.icon;
  if (typeof declared !== 'string' || declared === '') return undefined;
  const relative = normalize(declared).split(sep).join('/');
  if (relative.startsWith('../') || relative.startsWith('/') || isAbsolute(declared)) {
    log(`    icon ${declared}: outside the package directory, ignored`);
    return undefined;
  }
  const extension = extname(relative).toLowerCase();
  if (!ICON_EXTENSIONS.has(extension)) {
    log(`    icon ${declared}: not an SVG, PNG, JPEG, or WebP file, ignored`);
    return undefined;
  }
  let bytes;
  try {
    bytes = gitBuffer(['-C', repoDir, 'show', `${manifest.commit ?? 'HEAD'}:${relative}`]);
  } catch {
    log(`    icon ${declared}: unreadable at the release commit, ignored`);
    return undefined;
  }
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
    log(`    icon ${declared}: ${String(bytes.length)} bytes, outside the 1..${String(MAX_ICON_BYTES)} range, ignored`);
    return undefined;
  }
  const file = `${pluginName.replace(/^@[^/]+\//u, '').replace(/[^a-z0-9._-]/giu, '-')}${extension}`;
  if (!DRY_RUN) {
    await mkdir(ICONS_DIR, { recursive: true });
    await writeFile(join(ICONS_DIR, file), bytes);
  }
  log(`    icon ${declared} -> icons/${file} (${String(bytes.length)} bytes)`);
  return `icons/${file}`;
}

/**
 * Build the `plugins[]` entry for a source the index does not carry yet, using the
 * newest release's manifest. Everything here is a default a human may replace later:
 * `sync-index.mjs` only ever appends versions to an entry that already exists.
 */
async function createPlugin(pluginName, release, source, log) {
  const { manifest } = release;
  const description = typeof manifest.description === 'string' && manifest.description !== ''
    ? { en: manifest.description }
    : undefined;
  const icon = await importIcon(source.repoDir, { ...manifest, commit: release.commit }, pluginName, log);
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((word) => typeof word === 'string') : [];
  // Field order follows the committed index files, so a newly created entry reads the
  // same way as a hand-written one and its diff stays small.
  const plugin = {
    name: pluginName,
    title: { en: pluginName },
    ...description === undefined ? {} : { description },
    ...icon === undefined ? {} : { icon },
    ...typeof manifest.author === 'string' && manifest.author !== '' ? { author: manifest.author } : {},
    ...typeof manifest.homepage === 'string' && manifest.homepage.startsWith('https://') ? { homepage: manifest.homepage } : {},
    repository: { url: source.url.replace(/\.git$/u, '') },
    metadata: keywords.length > 0 ? { keywords } : {},
    versions: [],
  };
  if (source.subdirectory === true) plugin.repository.directory = source.directory;
  log(`    created a new plugins[] entry for ${pluginName}${icon === undefined ? '' : ` with ${icon}`}`);
  return plugin;
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
      plugin = await createPlugin(pluginName, releases[0], { ...source, repoDir }, log);
      index.plugins.push(plugin);
      changed = true;
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
  // A stable order keeps every run's output identical to the last one, so a sync that
  // finds nothing new produces no diff at all.
  index.plugins.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

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
