// Shared GitHub and registry helpers for the index tooling.
//
// `discover-sources.mjs` and `add-source.mjs` both need the same three things: a
// credential, a way to call the GitHub API that survives a narrow token, and a way to
// read an upstream `package.json`. Keeping them here means the two entry points agree
// on what counts as a bundle and on how a token rejection is handled.

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

/** A release tag that can pin a version: `v1.2.0` or `1.2.0`, with build metadata. */
export const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** The API token, from the environment or the `gh` CLI when it is logged in. */
export function resolveToken() {
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
export async function api(path, retryWithoutAuth = true) {
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

export function isAuthenticated() {
  return TOKEN !== undefined;
}

/** Every repository owned by `owner`, newest activity first. */
export async function listOwnerRepositories(owner) {
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/users/${owner}/repos?per_page=100&type=owner&sort=updated&page=${String(page)}`);
    if (batch === undefined || batch.length === 0) break;
    repositories.push(...batch);
    if (batch.length < 100) break;
  }
  return repositories;
}

/** The repository's `package.json` on a branch, or `undefined` when unreadable. */
export async function readManifest(owner, repository, branch) {
  const file = await api(`/repos/${owner}/${repository}/contents/package.json?ref=${encodeURIComponent(branch)}`);
  if (file === undefined || typeof file.content !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Whether the repository carries at least one SemVer release tag. */
export async function hasReleaseTag(owner, repository) {
  const tags = await api(`/repos/${owner}/${repository}/tags?per_page=100`);
  if (tags === undefined) return false;
  return tags.some((tag) => SEMVER_TAG.test(tag.name));
}

/** A package loads as a profile bundle only when it declares a patch to apply. */
export function isBundle(manifest) {
  const patch = manifest?.dsh?.bundle?.patch;
  return typeof patch === 'string' || (Array.isArray(patch) && patch.length > 0);
}

/**
 * Split `https://github.com/<owner>/<repo>` (trailing `.git` and slash tolerated) into
 * its two parts. Returns `undefined` for anything else, so a typo is rejected instead
 * of being turned into an API path.
 */
export function parseRepositoryUrl(value) {
  if (typeof value !== 'string') return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(url.pathname);
  if (match === null) return undefined;
  return { owner: match[1], name: match[2] };
}
