// Managed Git-authorship policy block for consumer AGENTS.md files.
//   node policy-block.mjs preflight-update --project <dir>   validate only; writes nothing
//   node policy-block.mjs update           --project <dir>   preflight, then write
// The canonical block lives in templates/project-rules/AGENTS.md between stable markers. Only that block is ever
// added or replaced; project-authored content outside it is never touched. Anything ambiguous (malformed markers,
// non-UTF-8 content, broken links) fails before any write.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const START_MARKER = '<!-- agent-kit:git-authorship:start -->';
export const END_MARKER = '<!-- agent-kit:git-authorship:end -->';

export class PolicyError extends Error {}

export const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

// A marker counts only when the whole logical line (minus its terminator) is exactly the marker: indented or
// suffixed look-alikes (examples, prose, fenced samples) are ordinary text. Returns null when there is no block.
export function locateBlock(text) {
  let offset = 0;
  const starts = [];
  const ends = [];
  for (const line of text.split('\n')) {
    const logical = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (logical === START_MARKER) starts.push({ begin: offset, end: offset + logical.length });
    if (logical === END_MARKER) ends.push({ begin: offset, end: offset + logical.length });
    offset += line.length + 1;
  }
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw new PolicyError(`AGENTS.md has ${starts.length} start and ${ends.length} end Git-authorship markers; expected exactly one pair (duplicate, nested, or unpaired markers). Fix it manually before updating.`);
  }
  if (ends[0].begin < starts[0].begin) throw new PolicyError('AGENTS.md Git-authorship end marker appears before the start marker. Fix it manually before updating.');
  return { begin: starts[0].begin, end: ends[0].end };
}

// Strict UTF-8 only. A UTF-8 BOM is accepted and reported so it can be written back unchanged; UTF-16, NUL bytes,
// and invalid UTF-8 are refused rather than transcoded.
export function decodeStrict(buffer) {
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    throw new PolicyError('AGENTS.md is UTF-16 encoded; Agent Kit will not transcode it. Convert it to UTF-8 and rerun.');
  }
  if (buffer.includes(0)) throw new PolicyError('AGENTS.md contains NUL bytes (UTF-16 or binary content); Agent Kit will not modify it.');
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  try {
    return { bom, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(bom ? 3 : 0)) };
  } catch {
    throw new PolicyError('AGENTS.md is not valid UTF-8; Agent Kit will not modify it.');
  }
}

export function canonicalBlock(root = kitRoot) {
  const template = normalizeEol(fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8'));
  const found = locateBlock(template);
  if (!found) throw new PolicyError('Canonical template lacks the managed Git-authorship block.');
  return template.slice(found.begin, found.end);
}

// existing === null means AGENTS.md is absent. Returns { action: create | append | replace | noop, content }.
export function planUpdate(existing, root = kitRoot) {
  const block = canonicalBlock(root);
  if (existing === null) return { action: 'create', content: fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8') };
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (text) => text.replace(/\n/g, eol);
  const found = locateBlock(existing);
  if (!found) {
    const separator = existing === '' ? '' : `${existing.endsWith('\n') ? '' : eol}${eol}`;
    return { action: 'append', content: `${existing}${separator}${toEol(block)}${eol}` };
  }
  if (normalizeEol(existing.slice(found.begin, found.end)) === block) return { action: 'noop' };
  return { action: 'replace', content: `${existing.slice(0, found.begin)}${toEol(block)}${existing.slice(found.end)}` };
}

// Resolves AGENTS.md (following a link to its real target, which is what gets updated) and decodes it strictly.
function readTarget(project) {
  const file = path.join(project, 'AGENTS.md');
  let linkStat;
  try { linkStat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { file, real: file, text: null, bom: false, mode: undefined };
    throw error;
  }
  let real = file;
  if (linkStat.isSymbolicLink()) {
    try { real = fs.realpathSync(file); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') throw new PolicyError(`${file} is a broken or circular link; refusing to modify it.`);
      throw error;
    }
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new PolicyError(`${real} is not a regular file.`);
  return { file, real, ...decodeStrict(fs.readFileSync(real)), mode: stat.mode & 0o7777 };
}

export function preflightUpdate(projectRoot, root = kitRoot) {
  planUpdate(readTarget(path.resolve(projectRoot)).text, root);
}

export function update(projectRoot, root = kitRoot, { fsImpl = fs } = {}) {
  const target = readTarget(path.resolve(projectRoot));
  const plan = planUpdate(target.text, root);
  if (plan.action === 'noop') return plan.action;
  const data = Buffer.concat([target.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(plan.content, 'utf8')]);
  // Temp file beside the real target (same filesystem); always removed, and the original failure is never masked.
  const temp = path.join(path.dirname(target.real), `${path.basename(target.real)}.agent-kit-${process.pid}-${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, data, { flag: 'wx' });
    if (target.mode !== undefined) fsImpl.chmodSync(temp, target.mode);
    fsImpl.renameSync(temp, target.real);
  } finally {
    try { fsImpl.unlinkSync(temp); } catch { /* already renamed or never created */ }
  }
  return plan.action;
}

function main(argv) {
  const [command] = argv;
  const flag = argv.indexOf('--project');
  const project = flag >= 0 ? argv[flag + 1] : undefined;
  if (!['preflight-update', 'update'].includes(command) || !project) { console.error('usage: policy-block.mjs <preflight-update|update> --project <dir>'); return 2; }
  try {
    if (command === 'preflight-update') preflightUpdate(project);
    else console.log(`Policy block: ${update(project)} AGENTS.md`);
    return 0;
  } catch (error) {
    if (error instanceof PolicyError) { console.error(`Policy update refused: ${error.message}`); return 1; }
    throw error;
  }
}

// Compare real paths so invocation through links, junctions, SUBST drives, or alternate casing still runs main().
// If the comparison itself fails, fail loudly instead of silently exiting 0 without doing anything.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (file) => (fs.realpathSync.native ?? fs.realpathSync)(file);
  const entry = real(process.argv[1]);
  const self = real(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}
let direct = false;
try { direct = invokedDirectly(); } catch (error) {
  console.error(`policy-block: could not determine how it was invoked: ${error.message}`);
  process.exitCode = 2;
}
if (direct) process.exitCode = main(process.argv.slice(2));
