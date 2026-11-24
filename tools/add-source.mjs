// Add one plugin repository to `sources.json`, so the sync picks it up.
//
// `discover-sources.mjs` only looks at repositories owned by the index owner and only
// keeps names starting with `dsh-`. A third-party plugin, or one outside that naming
// rule, has to be added deliberately; this script is that path, and the `Add a plugin`
// workflow is a thin wrapper around it.
//
// What it checks before writing anything:
// - the repository exists on GitHub, is neither archived nor a fork;
// - its `package.json` on the default branch declares `dsh.bundle.patch`, which is what
//   makes a package loadable as a profile bundle;
// - the package name is a valid npm name and is not already a source under another URL;
// - the source can actually produce a version: a SemVer release tag for a git source, or
//   at least one published version for an npm source.
//
// Usage:
//   node tools/add-source.mjs <repository> [options]
//
//   <repository>        https://github.com/<owner>/<repo>, or just <owner>/<repo>
//   --source <kind>     git (default) or npm; npm indexes registry versions instead of
//                       git tags, for a package that publishes built output
//   --name <package>    index package name; defaults to the upstream package.json name
//   --directory <dir>   local checkout directory for a git source; defaults to the repo name
//   --allow-major       accept an `engines.dsh` move to another DSH minor line
//   --dry-run           print the entry without writing `sources.json`
//
// Environment:
//   GITHUB_TOKEN / GH_TOKEN  API credential; falls back to `gh auth token`, then anonymous.
//   DSH_INDEX_NPM_REGISTRY   registry to ask about an npm source.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { api, hasReleaseTag, isBundle, parseRepositoryUrl, readManifest } from './github-api.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES_PATH = join(ROOT, 'sources.json');
const NPM_REGISTRY = process.env.DSH_INDEX_NPM_REGISTRY || 'https://registry.npmjs.org';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

/** Printed as a message rather than a stack trace: this is a user mistake, not a crash. */
class AddError extends Error {}

function parseArgs(argv) {
  const options = { source: 'git', allowMajor: false, dryRun: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new AddError(`${argument} needs a value`);
      index += 1;
      return next.trim();
    };
    if (argument === '--source') options.source = value();
    else if (argument === '--name') options.name = value();
    else if (argument === '--directory') options.directory = value();
    else if (argument === '--allow-major') options.allowMajor = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument.startsWith('--')) throw new AddError(`unknown option ${argument}`);
    else positional.push(argument);
  }
  if (positional.length !== 1) throw new AddError('pass exactly one repository: https://github.com/<owner>/<repo> or <owner>/<repo>');
  if (options.source !== 'git' && options.source !== 'npm') throw new AddError(`--source must be git or npm, not ${options.source}`);
  // Inputs often arrive from web forms with stray whitespace; trim once here.
  positional[0] = positional[0].trim();
  const repository = parseRepositoryUrl(positional[0].includes('://') ? positional[0] : `https://github.com/${positional[0]}`);
  if (repository === undefined) throw new AddError(`not a GitHub repository URL: ${positional[0]}`);
  options.repository = repository;
  return options;
}

/** The metadata endpoint is the one call that proves the repository is public and alive. */
async function describeRepository({ owner, name }) {
  const repository = await api(`/repos/${owner}/${name}`);
  if (repository === undefined) throw new AddError(`${owner}/${name} does not exist or is not public`);
  if (repository.archived) throw new AddError(`${owner}/${name} is archived`);
  return repository;
}

/** Whether the registry serves at least one version under this name. */
async function assertPublishedOnNpm(packageName) {
  const response = await fetch(`${NPM_REGISTRY}/${packageName.replace('/', '%2f')}`, { headers: { accept: 'application/json' } });
  if (response.status === 404) throw new AddError(`${packageName} is not published on ${NPM_REGISTRY}; use --source git instead`);
  if (!response.ok) throw new AddError(`cannot read ${packageName} from ${NPM_REGISTRY}: HTTP ${String(response.status)}`);
  const packument = await response.json();
  const versions = Object.keys(packument.versions ?? {});
  if (versions.length === 0) throw new AddError(`${packageName} is published on npm but has no version`);
  return versions.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { owner, name: repositoryName } = options.repository;
  const url = `https://github.com/${owner}/${repositoryName}`;
  const lines = [];
  const log = (line) => lines.push(line);

  const repository = await describeRepository(options.repository);
  log(`repository ${owner}/${repositoryName} (default branch ${repository.default_branch})`);
  if (repository.fork) log('  note: this is a fork; the index will point at the fork');

  const manifest = await readManifest(owner, repositoryName, repository.default_branch);
  if (manifest === undefined) throw new AddError(`${owner}/${repositoryName} has no readable package.json on ${repository.default_branch}`);
  if (!isBundle(manifest)) throw new AddError(`${owner}/${repositoryName} declares no dsh.bundle.patch in package.json, so it cannot load as a plugin`);

  const packageName = options.name ?? manifest.name;
  if (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName) || packageName.length > 214) {
    throw new AddError(`not a valid npm package name: ${String(packageName)}; pass --name with the published name`);
  }
  log(`  package ${packageName} ${String(manifest.version)}`);

  const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  if (sources[packageName] !== undefined) {
    const existing = String(sources[packageName].url).replace(/\.git$/u, '');
    throw new AddError(`${packageName} is already a source (${existing}); nothing to add`);
  }
  const clash = Object.entries(sources).find(([, source]) => String(source.url).replace(/\.git$/u, '') === url);
  if (clash !== undefined) throw new AddError(`${url} is already a source as ${clash[0]}`);

  let entry;
  if (options.source === 'npm') {
    const count = await assertPublishedOnNpm(packageName);
    log(`  ${String(count)} version(s) on ${NPM_REGISTRY}`);
    entry = { url, source: 'npm', allowMajor: options.allowMajor };
  } else {
    if (!(await hasReleaseTag(owner, repositoryName))) {
      throw new AddError(`${owner}/${repositoryName} has no SemVer release tag, so the index would stay empty; tag a release first`);
    }
    const directory = options.directory ?? repositoryName;
    log(`  release tag found; local directory ${directory}`);
    entry = { url, directory, allowMajor: options.allowMajor };
  }

  sources[packageName] = entry;
  const sorted = Object.fromEntries(Object.entries(sources).sort(([left], [right]) => (left < right ? -1 : 1)));
  log(`add ${packageName} <- ${JSON.stringify(entry)}`);

  if (options.dryRun) log('dry run: sources.json not written');
  else {
    await writeFile(SOURCES_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    log('sources.json updated');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  if (error instanceof AddError) {
    process.stderr.write(`add failed: ${error.message}\n`);
    // Set the code rather than calling `process.exit`: an exit during a pending fetch
    // aborts libuv on Windows.
    process.exitCode = 1;
    return;
  }
  throw error;
});
