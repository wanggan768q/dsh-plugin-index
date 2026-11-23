// Validate `index.json` with the same parser DSH uses, then check repository invariants.
//
// Run with `pnpm validate` (or `npm run validate`). The parser comes from
// `@deepseek-ai/dsh-plugin-market-index`, pinned to the DSH release the index targets,
// so a green run means the index loads in DSH with the same rules.

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

import { compareVersions } from './compare-versions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(ROOT, 'index.json');
const SOURCES_PATH = join(ROOT, 'sources.json');
// DSH resolves relative icon references against the URL the index was read from.
const INDEX_URL = 'https://wanggan768q.github.io/dsh-plugin-index/index.json';

async function main() {
  const failures = [];
  const notes = [];

  const raw = await readFile(INDEX_PATH, 'utf8');
  const document = JSON.parse(raw);
  const sourcesRaw = await readFile(SOURCES_PATH, 'utf8');
  const sources = JSON.parse(sourcesRaw);
  const index = parseMarketIndex(document, INDEX_URL);
  notes.push(`format ${String(index.format)}: ${String(index.plugins.length)} plugin(s) valid`);

  for (const plugin of index.plugins) {
    const spec = marketInstallTarget(plugin.name, plugin.versions[0]).spec;
    notes.push(`  ${plugin.name} @ ${plugin.versions[0].version} -> ${spec}`);
    for (const version of plugin.versions) {
      if (!/^[0-9a-f]{40}$/u.test(version.source.commit)) {
        failures.push(`${plugin.name}@${version.version}: commit must be a full 40-character SHA`);
      }
    }
  }

  // Every `sources.json` key must name a plugin the index carries, and vice versa.
  // The reverse direction is the one that breaks installs: an index entry with no
  // source can never be updated again. A source the index does not carry yet is a
  // normal transient state — discovery just added it and it has no release to index.
  const indexed = new Set(index.plugins.map((plugin) => plugin.name));
  for (const [name, source] of Object.entries(sources)) {
    if (!indexed.has(name)) notes.push(`  source ${name} has no index entry yet`);
    if (typeof source.url !== 'string' || !source.url.startsWith('https://')) {
      failures.push(`sources.json entry ${name} needs an https "url"`);
    }
    if (typeof source.directory !== 'string' || source.directory === '') {
      failures.push(`sources.json entry ${name} needs a "directory"`);
    }
  }
  for (const name of indexed) {
    if (!(name in sources)) failures.push(`index.json carries ${name}, which sources.json does not list`);
  }

  // Icons the index references with a relative path must exist in this repository.
  for (const icon of collectIcons(document)) {
    if (/^https:/u.test(icon) || icon.startsWith('data:')) continue;
    try {
      await stat(join(ROOT, icon));
    } catch {
      failures.push(`icon ${icon} is referenced but missing from the repository`);
    }
  }

  // Keep the committed formatting canonical, so a sync run never produces a diff that
  // is only whitespace.
  const formatted = `${JSON.stringify(document, null, 2)}\n`;
  if (formatted !== raw) failures.push('index.json is not formatted as 2-space JSON with a trailing newline');

  const versions = document.plugins.flatMap((plugin) => plugin.versions.map((entry) => entry.version));
  if (new Set(versions).size !== versions.length) failures.push('a plugin lists the same version twice');

  // `sync-index.mjs` sorts both levels on every run, so unsorted input would make the
  // next sync produce a diff that is only reordering.
  const names = index.plugins.map((plugin) => plugin.name);
  const sortedNames = [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (names.join('\n') !== sortedNames.join('\n')) failures.push('plugins[] is not sorted by name');
  for (const plugin of index.plugins) {
    const listed = document.plugins.find((entry) => entry.name === plugin.name).versions.map((entry) => entry.version);
    for (let position = 1; position < listed.length; position += 1) {
      if (compareVersions(listed[position - 1], listed[position]) <= 0) {
        failures.push(`${plugin.name}: versions[] is not in descending SemVer order at ${listed[position]}`);
        break;
      }
    }
  }

  const sourcesFormatted = `${JSON.stringify(
    Object.fromEntries(Object.entries(sources).sort(([left], [right]) => (left < right ? -1 : 1))),
    null,
    2,
  )}\n`;
  if (sourcesFormatted !== sourcesRaw) failures.push('sources.json is not sorted, 2-space JSON with a trailing newline');

  process.stdout.write(`${notes.join('\n')}\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`error: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write('all checks passed\n');
}

function collectIcons(document) {
  return document.plugins
    .map((plugin) => plugin.icon)
    .filter((icon) => typeof icon === 'string');
}

main().catch((error) => {
  process.stderr.write(`validation crashed: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
