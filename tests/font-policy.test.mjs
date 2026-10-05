import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText, verifyFontPolicy, verifyGitFontPolicy } from '../tools/check-font-policy.mjs';

const checkerPath = fileURLToPath(new URL('../tools/check-font-policy.mjs', import.meta.url));

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'team-builder-font-policy-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'src'));
  await mkdir(path.join(rootDir, 'public'));
  return rootDir;
}

function namedFont(name) {
  const value = Buffer.from(name, 'utf16le');
  value.swap16();
  const table = Buffer.alloc(18 + value.length);
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(18, 4);
  table.writeUInt16BE(3, 6);
  table.writeUInt16BE(1, 8);
  table.writeUInt16BE(0x409, 10);
  table.writeUInt16BE(1, 12);
  table.writeUInt16BE(value.length, 14);
  value.copy(table, 18);
  const font = Buffer.alloc(28 + table.length);
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(1, 4);
  font.write('name', 12, 'ascii');
  font.writeUInt32BE(28, 20);
  font.writeUInt32BE(table.length, 24);
  table.copy(font, 28);
  return font;
}

test('rejects font families, shorthand, fallback, aliases and inherited policy bans', () => {
  for (const text of [
    '.amount { font-family: Georgia, sans-serif; }',
    '.amount { font: bold 32px "Georgia Pro"; }',
    '.amount { font-family: Arial, gEoRgIa; }',
    '@font-face { font-family: Brand; src: url("/fonts/GeoProBold.woff"); }',
    '.amount { font-family: "MS Gothic"; }',
    '.amount { font-family: "ＭＳ ゴシック"; }',
    '.amount { --number-family: Georgia; font-family: var(--number-family); }',
  ]) assert.ok(checkText(text, 'style.css').length, text);
});

test('rejects CSS, JavaScript, HTML and URL escaped font names', () => {
  const cases = [
    [String.raw`.amount{font-family:Geor\67 ia}`, 'style.css'],
    [String.raw`.amount{font-family:\47 eorgia}`, 'style.css'],
    [String.raw`const style = {fontFamily: "Geor\u0067ia"}`, 'App.jsx'],
    [String.raw`const style = {fontFamily: "Geor\x67ia"}`, 'App.jsx'],
    ['<span style="font-family:Geor&#103;ia">Price</span>', 'index.html'],
    ['@font-face{font-family:Brand;src:url("/%47eorgia-Pro.woff")}', 'style.css'],
  ];
  for (const [text, file] of cases) assert.ok(checkText(text, file).length, text);
});

test('allows the replacement fonts and ignores policy comments', () => {
  assert.deepEqual(checkText("body{font-family:'Noto Sans SC','Microsoft YaHei',sans-serif} /* Georgia is forbidden */", 'style.css'), []);
  assert.deepEqual(checkText('// Never use Georgia\nconst s={fontFamily:"Noto Sans SC, Microsoft YaHei, sans-serif"};', 'App.jsx'), []);
  assert.deepEqual(checkText('<!-- Never use MS Gothic --> <p style="font-family:Microsoft YaHei">费用</p>', 'index.html'), []);
});

test('scans deployable inputs while excluding test fixtures, docs and image bytes', async t => {
  const rootDir = await fixture(t);
  await mkdir(path.join(rootDir, 'tests'));
  await writeFile(path.join(rootDir, 'AGENTS.md'), 'Georgia is forbidden');
  await writeFile(path.join(rootDir, 'tests', 'fixture.test.mjs'), 'Georgia');
  await writeFile(path.join(rootDir, 'public', 'image.png'), Buffer.from('Georgia'));
  await writeFile(path.join(rootDir, 'src', 'style.css'), "body{font-family:'Noto Sans SC','Microsoft YaHei',sans-serif}");
  assert.deepEqual(await verifyFontPolicy({ rootDir }), []);
  await writeFile(path.join(rootDir, 'src', 'style.css'), 'body{font:32px Georgia}');
  const findings = await verifyFontPolicy({ rootDir });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/style.css');
});

test('detects renamed forbidden font metadata and permits verified replacement metadata', async t => {
  const rootDir = await fixture(t);
  await writeFile(path.join(rootDir, 'public', 'innocent.ttf'), namedFont('Georgia Pro'));
  assert.ok((await verifyFontPolicy({ rootDir })).some(item => item.font === 'Georgia'));
  await writeFile(path.join(rootDir, 'public', 'innocent.ttf'), namedFont('Noto Sans SC'));
  assert.deepEqual(await verifyFontPolicy({ rootDir }), []);
});

test('checks metadata inside embedded data font resources', () => {
  const embedded = name => `@font-face{font-family:Brand;src:url("data:font/ttf;base64,${namedFont(name).toString('base64')}")}`;
  assert.equal(checkText(embedded('Georgia Pro'), 'style.css')[0].reason, 'Forbidden embedded font metadata');
  assert.deepEqual(checkText(embedded('Noto Sans SC'), 'style.css'), []);
  assert.match(checkText('@font-face{font-family:Brand;src:url("data:font/woff2;base64,d09GMg==")}', 'style.css')[0].reason, /cannot be verified/);
});

test('fails closed for font formats without inspectable metadata', async t => {
  const rootDir = await fixture(t);
  await writeFile(path.join(rootDir, 'public', 'hidden.woff2'), Buffer.from('wOF2'));
  assert.match((await verifyFontPolicy({ rootDir }))[0].reason, /cannot be verified/);
});

test('dist validation rejects generated CSS and JavaScript contamination and missing output', async t => {
  const rootDir = await fixture(t);
  assert.match((await verifyFontPolicy({ rootDir, includeDist: true }))[0].reason, /missing/);
  await mkdir(path.join(rootDir, 'dist'));
  await writeFile(path.join(rootDir, 'dist', 'app.css'), 'body{font-family:Georgia}');
  await writeFile(path.join(rootDir, 'dist', 'app.js'), 'const style={fontFamily:"Georgia Pro"};');
  const findings = await verifyFontPolicy({ rootDir, includeDist: true });
  assert.equal(findings.length, 2);
  assert.ok(findings.every(item => item.file.startsWith('dist/')));
});

test('CLI exits nonzero when source contains a forbidden font', async t => {
  const rootDir = await fixture(t);
  // Copy only the checker to exercise its standalone CLI default-root behavior.
  await mkdir(path.join(rootDir, 'tools'));
  const { readFile } = await import('node:fs/promises');
  await writeFile(path.join(rootDir, 'tools', 'check-font-policy.mjs'), await readFile(checkerPath));
  await writeFile(path.join(rootDir, 'src', 'style.css'), 'body{font-family:Georgia}');
  const run = spawnSync(process.execPath, [path.join(rootDir, 'tools', 'check-font-policy.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /src\/style.css:1/);
});

test('Git checking inspects the actual committed tree rather than a corrected worktree', async t => {
  const rootDir = await fixture(t);
  const git = args => {
    const run = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git(['init', '--quiet']);
  await writeFile(path.join(rootDir, 'src', 'style.css'), 'body{font-family:Georgia}');
  git(['add', 'src/style.css']);
  git(['-c', 'user.name=FontPolicy', '-c', 'user.email=font-policy@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
  const badCommit = git(['rev-parse', 'HEAD']);
  await writeFile(path.join(rootDir, 'src', 'style.css'), 'body{font-family:Microsoft YaHei}');
  assert.deepEqual(await verifyFontPolicy({ rootDir }), []);
  assert.equal((await verifyGitFontPolicy(badCommit, { cwd: rootDir }))[0].font, 'Georgia');
  git(['add', 'src/style.css']);
  git(['-c', 'user.name=FontPolicy', '-c', 'user.email=font-policy@example.invalid', 'commit', '--quiet', '-m', 'Fixed']);
  const goodCommit = git(['rev-parse', 'HEAD']);
  assert.deepEqual(await verifyGitFontPolicy(goodCommit, { cwd: rootDir }), []);
  const cli = spawnSync(process.execPath, [checkerPath, '--git-ref', badCommit], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Georgia/);
});
