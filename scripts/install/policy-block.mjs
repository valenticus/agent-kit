// Managed policy blocks for consumer AGENTS.md files.
//   node policy-block.mjs preflight-update --project <dir>   validate only; writes nothing
//   node policy-block.mjs update           --project <dir>   preflight, then write
// The canonical blocks live in templates/project-rules/AGENTS.md between stable `agent-kit:<policy>:start/end`
// markers; the set of managed policies and their order are exactly the blocks found there. Only those blocks are
// ever added or replaced; project-authored content outside them is never touched. Anything ambiguous in any block
// (malformed or overlapping markers, non-UTF-8 content, broken links) fails before any write, so an update is
// all-or-nothing.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_POLICY = 'git-authorship';
const POLICY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const startMarker = (policy) => `<!-- agent-kit:${policy}:start -->`;
export const endMarker = (policy) => `<!-- agent-kit:${policy}:end -->`;
// Kept for existing callers: the markers of the original Git-authorship policy.
export const START_MARKER = startMarker(DEFAULT_POLICY);
export const END_MARKER = endMarker(DEFAULT_POLICY);
// Name used in messages; Git-authorship keeps its established wording.
export const policyLabel = (policy) => (policy === DEFAULT_POLICY ? 'Git-authorship' : policy);

export class PolicyError extends Error {}

export const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

const logicalLines = (text) => {
  let offset = 0;
  const lines = [];
  for (const line of text.split('\n')) {
    lines.push({ text: line.endsWith('\r') ? line.slice(0, -1) : line, offset });
    offset += line.length + 1;
  }
  return lines;
};

// A marker counts only when the whole logical line (minus its terminator) is exactly the marker: indented or
// suffixed look-alikes (examples, prose, fenced samples) are ordinary text. Returns null when there is no block.
export function locateBlock(text, policy = DEFAULT_POLICY) {
  const [startText, endText, label] = [startMarker(policy), endMarker(policy), policyLabel(policy)];
  const starts = [];
  const ends = [];
  for (const line of logicalLines(text)) {
    if (line.text === startText) starts.push({ begin: line.offset, end: line.offset + line.text.length });
    if (line.text === endText) ends.push({ begin: line.offset, end: line.offset + line.text.length });
  }
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw new PolicyError(`AGENTS.md has ${starts.length} start and ${ends.length} end ${label} markers; expected exactly one pair (duplicate, nested, or unpaired markers). Fix it manually before updating.`);
  }
  if (ends[0].begin < starts[0].begin) throw new PolicyError(`AGENTS.md ${label} end marker appears before the start marker. Fix it manually before updating.`);
  return { begin: starts[0].begin, end: ends[0].end };
}

// Locates every listed policy and refuses blocks that overlap or nest, since replacing one would corrupt another.
export function locateBlocks(text, policies) {
  const located = policies.map((policy) => ({ policy, found: locateBlock(text, policy) }));
  const present = located.filter((entry) => entry.found).sort((a, b) => a.found.begin - b.found.begin);
  for (let index = 1; index < present.length; index++) {
    if (present[index].found.begin < present[index - 1].found.end) {
      throw new PolicyError(`AGENTS.md managed ${policyLabel(present[index - 1].policy)} and ${policyLabel(present[index].policy)} blocks overlap or are nested. Fix it manually before updating.`);
    }
  }
  return located;
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

const templatePath = (root) => path.join(root, 'templates', 'project-rules', 'AGENTS.md');

// The canonical managed blocks, in template order, with EOL-normalized text.
export function canonicalBlocks(root = kitRoot) {
  const template = normalizeEol(fs.readFileSync(templatePath(root), 'utf8'));
  const policies = [];
  for (const line of logicalLines(template)) {
    const match = /^<!-- agent-kit:([^:\s]+):start -->$/.exec(line.text);
    if (!match) continue;
    if (!POLICY_ID.test(match[1])) throw new PolicyError(`Canonical template has an invalid managed policy name "${match[1]}".`);
    if (!policies.includes(match[1])) policies.push(match[1]);
  }
  let located;
  try { located = locateBlocks(template, policies); } catch (error) {
    throw new PolicyError(`Canonical template is invalid: ${error.message}`);
  }
  if (!policies.includes(DEFAULT_POLICY)) throw new PolicyError('Canonical template lacks the managed Git-authorship block.');
  return located.map(({ policy, found }) => ({ policy, block: template.slice(found.begin, found.end) }));
}

export function canonicalBlock(root = kitRoot, policy = DEFAULT_POLICY) {
  const entry = canonicalBlocks(root).find((candidate) => candidate.policy === policy);
  if (!entry) throw new PolicyError(`Canonical template lacks the managed ${policyLabel(policy)} block.`);
  return entry.block;
}

// Per-policy state of an existing AGENTS.md text: missing, stale, or current. Throws on malformed markers.
export function policyStatus(existing, root = kitRoot) {
  const canonical = canonicalBlocks(root);
  const located = locateBlocks(existing, canonical.map((entry) => entry.policy));
  return canonical.map(({ policy, block }, index) => {
    const { found } = located[index];
    return { policy, found, block, state: !found ? 'missing' : normalizeEol(existing.slice(found.begin, found.end)) === block ? 'current' : 'stale' };
  });
}

// existing === null means AGENTS.md is absent. Returns { action, content, changes }, where action is create, append,
// replace, update (both appends and replacements), or noop, and changes lists { policy, action } per changed block.
// A missing block goes right after the nearest earlier managed block that is present, else right before the nearest
// later one, else at the end of the file; several missing blocks keep template order. Every block is located and
// checked before anything is planned, so a single malformed block refuses the whole update.
export function planUpdate(existing, root = kitRoot) {
  if (existing === null) return { action: 'create', content: fs.readFileSync(templatePath(root), 'utf8'), changes: [] };
  const status = policyStatus(existing, root);
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (text) => text.replace(/\n/g, eol);
  const edits = [];
  const changes = [];
  for (const entry of status) {
    if (entry.state === 'stale') {
      edits.push({ begin: entry.found.begin, end: entry.found.end, text: toEol(entry.block) });
      changes.push({ policy: entry.policy, action: 'replace' });
    }
  }
  const insertions = new Map();
  status.forEach((entry, index) => {
    if (entry.state !== 'missing') return;
    const before = status.slice(0, index).reverse().find((candidate) => candidate.found);
    const after = status.slice(index + 1).find((candidate) => candidate.found);
    const key = before ? `after:${before.policy}` : after ? `before:${after.policy}` : 'eof';
    if (!insertions.has(key)) insertions.set(key, { anchor: before ?? after, blocks: [] });
    insertions.get(key).blocks.push(toEol(entry.block));
    changes.push({ policy: entry.policy, action: 'append' });
  });
  for (const [key, { anchor, blocks }] of insertions) {
    const joined = blocks.join(`${eol}${eol}`);
    if (key === 'eof') {
      const separator = existing === '' ? '' : `${existing.endsWith('\n') ? '' : eol}${eol}`;
      edits.push({ begin: existing.length, end: existing.length, text: `${separator}${joined}${eol}` });
    } else if (key.startsWith('after:')) edits.push({ begin: anchor.found.end, end: anchor.found.end, text: `${eol}${eol}${joined}` });
    else edits.push({ begin: anchor.found.begin, end: anchor.found.begin, text: `${joined}${eol}${eol}` });
  }
  if (edits.length === 0) return { action: 'noop', changes };
  // Apply from the end so earlier offsets stay valid; at one offset, a replacement goes before an insertion.
  edits.sort((a, b) => b.begin - a.begin || b.end - a.end);
  let content = existing;
  for (const edit of edits) content = `${content.slice(0, edit.begin)}${edit.text}${content.slice(edit.end)}`;
  const kinds = [...new Set(changes.map((change) => change.action))];
  return { action: kinds.length === 1 ? kinds[0] : 'update', content, changes };
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
  // Temp file beside the real target (same filesystem), created exclusively. It is removed on failure only if this call
  // created it, so an existing file of the same name is never deleted; the original failure is never masked.
  const temp = path.join(path.dirname(target.real), `${path.basename(target.real)}.agent-kit-${process.pid}-${Date.now()}.tmp`);
  let created = false;
  try {
    const fd = fsImpl.openSync(temp, 'wx');
    created = true;
    try { fsImpl.writeFileSync(fd, data); } finally { fsImpl.closeSync(fd); }
    if (target.mode !== undefined) fsImpl.chmodSync(temp, target.mode);
    fsImpl.renameSync(temp, target.real);
    created = false;
  } finally {
    if (created) try { fsImpl.unlinkSync(temp); } catch { /* already gone */ }
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
