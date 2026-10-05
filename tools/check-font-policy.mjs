import { readFile, readdir, stat, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const textExtensions = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.svg']);
const fontExtensions = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
const forbidden = /\b(?:georgia[a-z0-9_-]*|geopro[a-z0-9_-]*|m[\s_-]*s[\s_-]*(?:p[\s_-]*)?gothic)\b|m[\s_-]*s[\s_-]*ゴシック/gi;
const runFile = promisify(execFile);

// Preserve quoted values and line breaks; policy comments are not active references.
function removeComments(input, extension) {
  let output = '', quote = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      output += char;
      if (char === '\\') output += input[++i] ?? '';
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
    } else if (char === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        output += input[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++;
    } else if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(extension) && char === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      output += '\n';
    } else if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      const stop = end < 0 ? input.length : end + 3;
      output += input.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else output += char;
  }
  return output;
}

function normalizeReferences(input) {
  let output = input.replace(/\\(?:\r\n|\n|\r)/g, '');
  for (let pass = 0; pass < 3; pass++) {
    output = output
      .replace(/\\u\{([a-f\d]{1,6})\}|\\u([a-f\d]{4})|\\x([a-f\d]{2})/gi, (_, a, b, c) => {
        const codepoint = parseInt(a ?? b ?? c, 16);
        return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '\ufffd';
      })
      .replace(/\\([a-f\d]{1,6})(?:\r\n|[\t\n\r\f ])?/gi, (_, hex) => {
        const codepoint = parseInt(hex, 16);
        return codepoint && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '\ufffd';
      })
      .replace(/\\([^\n\r\f])/g, '$1')
      .replace(/&#(?:x([a-f\d]+)|(\d+));?/gi, (_, hex, dec) => {
        const codepoint = parseInt(hex ?? dec, hex ? 16 : 10);
        return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '\ufffd';
      })
      .replace(/(?:%[a-f\d]{2})+/gi, encoded => {
        try { return decodeURIComponent(encoded); } catch { return encoded; }
      });
  }
  return output.normalize('NFKC');
}

/** Check deployable text, excluding comments. Test fixtures and policy docs are not scan targets. */
export function checkText(text, file = 'style.css') {
  const extension = path.extname(file).toLowerCase();
  const normalized = normalizeReferences(removeComments(text, extension));
  const findings = [];
  for (const match of normalized.matchAll(forbidden)) {
    const line = normalized.slice(0, match.index).split('\n').length;
    findings.push({ file, line, font: match[0], reason: 'Forbidden font reference' });
  }
  const inlineFonts = /data:(font\/[^;,]+|application\/(?:x-font-[^;,]+|font-[^;,]+|vnd\.ms-fontobject|vnd\.ms-opentype))((?:;[^,]*)?),([^"'()\s]+)/gi;
  for (const match of normalized.matchAll(inlineFonts)) {
    const line = normalized.slice(0, match.index).split('\n').length;
    try {
      if (!/;base64(?:;|$)/i.test(match[2]) || !/^[a-z\d+/]*={0,2}$/i.test(match[3])) {
        throw new Error('Embedded font must have inspectable base64 metadata');
      }
      const format = match[1].toLowerCase();
      const extension = /woff2?$/.test(format) ? '.' + format.match(/woff2?$/)[0]
        : /(?:otf|opentype)$/.test(format) ? '.otf'
          : /fontobject$/.test(format) ? '.eot' : '.ttf';
      const names = fontNames(Buffer.from(match[3], 'base64'), extension);
      for (const finding of checkText(names.join('\n'), file)) findings.push({ ...finding, line, reason: 'Forbidden embedded font metadata' });
    } catch (error) {
      findings.push({ file, line, reason: error.message });
    }
  }
  return findings;
}

function readNameTable(table) {
  if (table.length < 6) throw new Error('Truncated font name table');
  const count = table.readUInt16BE(2), strings = table.readUInt16BE(4);
  if (6 + count * 12 > table.length) throw new Error('Invalid font name records');
  const names = [];
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const platform = table.readUInt16BE(record), nameId = table.readUInt16BE(record + 6);
    if (![1, 4, 6, 16, 17].includes(nameId)) continue;
    const length = table.readUInt16BE(record + 8), offset = strings + table.readUInt16BE(record + 10);
    if (offset + length > table.length) throw new Error('Invalid font name string');
    const value = table.subarray(offset, offset + length);
    if (platform === 0 || platform === 3) {
      if (length % 2) throw new Error('Invalid UTF-16 font name');
      const littleEndian = Buffer.from(value);
      littleEndian.swap16();
      names.push(littleEndian.toString('utf16le'));
    } else names.push(value.toString('latin1'));
  }
  return names;
}

function fontNames(buffer, extension) {
  if (extension === '.woff2' || extension === '.eot') {
    throw new Error('This font format cannot be verified by the policy checker; use a verified TTF, OTF or WOFF resource');
  }
  const woff = extension === '.woff';
  const header = woff ? 44 : 12, recordLength = woff ? 20 : 16;
  if (buffer.length < header) throw new Error('Truncated font header');
  if (woff && buffer.toString('ascii', 0, 4) !== 'wOFF') throw new Error('Invalid WOFF signature');
  if (!woff && !['00010000', '4f54544f', '74727565'].includes(buffer.subarray(0, 4).toString('hex'))) {
    throw new Error('Invalid SFNT signature');
  }
  const count = buffer.readUInt16BE(woff ? 12 : 4);
  if (header + count * recordLength > buffer.length) throw new Error('Invalid font table directory');
  for (let i = 0; i < count; i++) {
    const record = header + i * recordLength;
    if (buffer.toString('ascii', record, record + 4) !== 'name') continue;
    const offset = buffer.readUInt32BE(record + (woff ? 4 : 8));
    const length = buffer.readUInt32BE(record + (woff ? 8 : 12));
    if (offset + length > buffer.length) throw new Error('Invalid font name table bounds');
    let table = buffer.subarray(offset, offset + length);
    if (woff && length < buffer.readUInt32BE(record + 12)) {
      table = inflateSync(table, { maxOutputLength: 16 * 1024 * 1024 });
    }
    return readNameTable(table);
  }
  throw new Error('Font has no inspectable name metadata');
}

async function filesIn(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

/** Inspect source/public assets, plus build output when includeDist is enabled. */
export async function verifyFontPolicy({ rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url))), includeDist = false } = {}) {
  const candidates = [
    ...await filesIn(path.join(rootDir, 'src')),
    ...await filesIn(path.join(rootDir, 'public')),
    ...(['index.html', 'vite.config.mjs', 'vite.config.js', 'vite.config.ts'].map(file => path.join(rootDir, file))),
  ];
  const findings = [];
  if (includeDist) {
    const distDir = path.join(rootDir, 'dist');
    try { if (!(await stat(distDir)).isDirectory()) throw new Error('dist is not a directory'); }
    catch { return [{ file: 'dist', line: 1, reason: 'Build output is missing; run the site build before checking --dist' }]; }
    candidates.push(...await filesIn(distDir));
  }
  for (const file of candidates.sort()) {
    const extension = path.extname(file).toLowerCase();
    if (!textExtensions.has(extension) && !fontExtensions.has(extension)) continue;
    let buffer;
    try { buffer = await readFile(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const relative = path.relative(rootDir, file).replaceAll(path.sep, '/');
    if (fontExtensions.has(extension)) {
      findings.push(...checkText(relative, relative));
      try { findings.push(...checkText(fontNames(buffer, extension).join('\n'), relative)); }
      catch (error) { findings.push({ file: relative, line: 1, reason: error.message }); }
    } else findings.push(...checkText(buffer.toString('utf8'), relative));
  }
  return findings;
}

/** Inspect the exact commit to be pushed, even when the worktree has newer fixes. */
export async function verifyGitFontPolicy(ref, { cwd = process.cwd() } = {}) {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(ref)) throw new Error('--git-ref requires a complete commit SHA');
  const { stdout: commit } = await runFile('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  if (commit.trim().toLowerCase() !== ref.toLowerCase()) throw new Error('--git-ref must identify a commit directly');
  const { stdout: listing } = await runFile('git', ['ls-tree', '-r', '--name-only', '-z', ref], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const sourceFiles = listing.split('\0').filter(Boolean).filter(file => {
    if (!/^(?:src\/|public\/|dist\/|index\.html$|vite\.config\.(?:js|mjs|ts)$)/.test(file)) return false;
    const extension = path.extname(file).toLowerCase();
    return textExtensions.has(extension) || fontExtensions.has(extension);
  });
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'team-builder-font-commit-'));
  try {
    for (const file of sourceFiles) {
      const destination = path.resolve(rootDir, file);
      if (!destination.startsWith(rootDir + path.sep)) throw new Error('Invalid commit file path');
      const { stdout: contents } = await runFile('git', ['show', `${ref}:${file}`], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    return await verifyFontPolicy({ rootDir, includeDist: sourceFiles.some(file => file.startsWith('dist/')) });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  const gitMode = flags.length === 2 && flags[0] === '--git-ref';
  if (!gitMode && flags.some(flag => flag !== '--dist')) {
    console.error('Usage: node tools/check-font-policy.mjs [--dist] | --git-ref <complete-commit-SHA>');
    process.exitCode = 1;
  } else {
    let findings;
    try {
      findings = gitMode ? await verifyGitFontPolicy(flags[1]) : await verifyFontPolicy({ includeDist: flags.includes('--dist') });
    } catch (error) {
      console.error(`Font policy check failed: ${error.message}`);
      process.exitCode = 1;
      findings = null;
    }
    if (findings?.length) {
      console.error('Font policy check failed:');
      for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.reason}${finding.font ? ` (${finding.font})` : ''}`);
      process.exitCode = 1;
    } else if (findings) console.log(`Font policy passed${gitMode ? ` (commit ${flags[1]})` : flags.includes('--dist') ? ' (source and dist)' : ' (source)'}.`);
  }
}
