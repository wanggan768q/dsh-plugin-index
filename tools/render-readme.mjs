// Render only the marked plugin table; preserve all hand-written documentation.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './compare-versions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const START = '<!-- plugin-table:start -->';
export const END = '<!-- plugin-table:end -->';

function text(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/\|/gu, '&#124;').replace(/`/gu, '&#96;').replace(/\[/gu, '&#91;')
    .replace(/\]/gu, '&#93;').replace(/[\r\n]+/gu, ' ');
}

function link(label, value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`Unsupported source URL: ${value}`);
  const href = url.href.replace(/[()|]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${text(label)}](${href})`;
}

function sourceLabel(source, packageName) {
  if (source.type === 'npm') {
    return `npm：\`${text(packageName)}\``;
  }
  if (source.type === 'git') {
    const url = new URL(source.url);
    const label = url.hostname === 'github.com' ? url.pathname.replace(/^\//u, '').replace(/\.git$/u, '') : source.url;
    return `${link(label, source.url)} @ \`${text(source.commit)}\``;
  }
  throw new Error(`Unsupported source type: ${source.type}`);
}

export function renderTable(index) {
  if (!Array.isArray(index.plugins)) throw new Error('index.plugins must be an array');
  const rows = ['| 插件 | 版本 | 来源 |', '|---|---|---|'];
  const plugins = [...index.plugins].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const plugin of plugins) {
    if (!plugin.versions?.length) throw new Error(`No indexed versions for ${plugin.name}`);
    const latest = plugin.versions.reduce((best, entry) => compareVersions(entry.version, best.version) > 0 ? entry : best);
    const title = typeof plugin.title === 'string' ? plugin.title : plugin.title?.zh || plugin.title?.en;
    const name = `\`${text(plugin.name)}\`${title && title !== plugin.name ? ` — ${text(title)}` : ''}`;
    let source = sourceLabel(latest.source, plugin.name);
    if (latest.source.type === 'npm' && plugin.repository?.url) {
      source += `；${link('源码', plugin.repository.url)}`;
    }
    rows.push(`| ${name} | ${text(latest.version)} | ${source} |`);
  }
  return rows.join('\n');
}

export function renderReadme(readme, index) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end < start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error('README must contain exactly one ordered plugin-table:start/end marker pair');
  }
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const table = renderTable(index).replace(/\n/gu, newline);
  return readme.slice(0, start + START.length) + newline + table + newline + readme.slice(end);
}

export async function updateReadme(root = ROOT) {
  const readmePath = join(root, 'README.md');
  const [readme, index] = await Promise.all([
    readFile(readmePath, 'utf8'),
    readFile(join(root, 'index.json'), 'utf8').then(JSON.parse),
  ]);
  const next = renderReadme(readme, index);
  if (next === readme) return false;
  await writeFile(readmePath, next, 'utf8');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await updateReadme() ? 'README plugin table updated' : 'README plugin table is already up to date');
  } catch (error) {
    console.error(`render README failed: ${error.message}`);
    process.exitCode = 1;
  }
}
