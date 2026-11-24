import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { END, START, renderReadme, renderTable, updateReadme } from './render-readme.mjs';

const git = { type: 'git', url: 'https://github.com/owner/plugin', commit: 'abc123' };
const plugin = (name, versions, title) => ({ name, title, versions });
const entry = (version, source = git) => ({ version, source });
const template = `# Manual introduction\n${START}\nold table\n${END}\nManual footer\n`;

test('sorts plugins, selects highest SemVer rather than array order, and does not mutate input', () => {
  const index = { plugins: [plugin('z-plugin', [entry('1.0.0'), entry('1.10.0'), entry('1.2.0')], { zh: '中文', en: 'English' }), plugin('a-plugin', [entry('2.0.0-rc.1'), entry('2.0.0')], { en: 'English' })] };
  const original = JSON.stringify(index);
  const table = renderTable(index);
  assert.ok(table.indexOf('a-plugin') < table.indexOf('z-plugin'));
  assert.match(table, /`a-plugin` — English \| 2\.0\.0 \|/u);
  assert.match(table, /`z-plugin` — 中文 \| 1\.10\.0 \|/u);
  assert.equal(JSON.stringify(index), original);
});

test('renders npm sources using the index package name and optional repository link', () => {
  const item = plugin('@scope/package', [entry('0.2.0-beta.1', { type: 'npm' })]);
  item.repository = { url: 'https://github.com/owner/repo' };
  assert.match(renderTable({ plugins: [item] }), /npm：`@scope\/package`；\[源码\]\(https:\/\/github.com\/owner\/repo\)/u);
});

test('escapes upstream text and rejects unsafe link protocols', () => {
  const item = plugin('package', [entry('1.0.0')], { zh: 'a|b\n<script>`[x]' });
  const table = renderTable({ plugins: [item] });
  assert.ok(table.includes('a&#124;b &lt;script&gt;&#96;&#91;x&#93;'));
  item.versions[0].source = { ...git, url: 'javascript:alert(1)' };
  assert.throws(() => renderTable({ plugins: [item] }), /Unsupported source URL/u);
});

test('preserves text outside markers, supports CRLF, and is idempotent', () => {
  const index = { plugins: [plugin('package', [entry('1.0.0')])] };
  for (const input of [template, template.replace(/\n/gu, '\r\n')]) {
    const rendered = renderReadme(input, index);
    assert.equal(rendered.slice(0, rendered.indexOf(START)), input.slice(0, input.indexOf(START)));
    assert.equal(rendered.slice(rendered.indexOf(END)), input.slice(input.indexOf(END)));
    assert.equal(renderReadme(rendered, index), rendered);
    if (input.includes('\r\n')) assert.ok(!rendered.replace(/\r\n/gu, '').includes('\n'));
  }
});

test('fails closed on missing, reversed, or duplicated markers and missing versions', () => {
  for (const input of ['no markers', `${END}${START}`, `${START}${START}${END}`, `${START}${END}${END}`]) {
    assert.throws(() => renderReadme(input, { plugins: [] }), /marker pair/u);
  }
  assert.throws(() => renderTable({ plugins: [plugin('empty', [])] }), /No indexed versions/u);
  assert.equal(renderTable({ plugins: [] }).split('\n').length, 2);
});

test('CLI file update writes once and leaves an unchanged file untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-readme-test-'));
  try {
    await writeFile(join(root, 'README.md'), template);
    await writeFile(join(root, 'index.json'), JSON.stringify({ plugins: [plugin('package', [entry('1.0.0')])] }));
    assert.equal(await updateReadme(root), true);
    const first = await readFile(join(root, 'README.md'), 'utf8');
    const before = await stat(join(root, 'README.md'));
    assert.equal(await updateReadme(root), false);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), first);
    assert.equal((await stat(join(root, 'README.md'))).mtimeMs, before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
