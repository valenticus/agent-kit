#!/usr/bin/env node
// Agent Kit Claude Code bootstrap. Exposes the canonical project .agents/skills through the
// generated, git-ignored .claude/skills link that Claude Code discovers natively.
// Local only: no network, no package installation, no file changes outside .claude/skills.
// Silent on success (SessionStart stdout becomes model context); diagnostics go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const POSIX_LINK_TARGET = '../.agents/skills';

export class BootstrapError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function samePath(a, b, platform) {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function paths(projectRoot) {
  const root = path.resolve(projectRoot);
  return { root, canonical: path.join(root, '.agents', 'skills'), link: path.join(root, '.claude', 'skills') };
}

// Classify .claude/skills without ever modifying it.
// state: missing | correct | wrong | directory | file
export function inspectSkillsLink(projectRoot, { fsImpl = fs, platform = process.platform } = {}) {
  const { canonical, link } = paths(projectRoot);
  let stat;
  try { stat = fsImpl.lstatSync(link); } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing', link, canonical };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    try {
      if (samePath(fsImpl.realpathSync(link), fsImpl.realpathSync(canonical), platform)) return { state: 'correct', link, canonical };
    } catch { /* broken link or missing canonical: treated as wrong below */ }
    return { state: 'wrong', link, canonical };
  }
  return { state: stat.isDirectory() ? 'directory' : 'file', link, canonical };
}

const REFUSALS = {
  wrong: (link, canonical) => `${link} is a link that does not resolve to ${canonical}. Remove or repair it manually; Agent Kit never overwrites an existing link.`,
  directory: (link) => `${link} is a real directory. Agent Kit never deletes or replaces it. Move its contents into .agents/skills (the canonical location) and remove the directory, then rerun.`,
  file: (link) => `${link} is an ordinary file. Agent Kit never deletes or replaces it. Remove it manually and rerun.`,
};

export function assertCanonicalSkills(projectRoot, { fsImpl = fs } = {}) {
  const { canonical } = paths(projectRoot);
  let stat = null;
  try { stat = fsImpl.statSync(canonical); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!stat || !stat.isDirectory()) {
    throw new BootstrapError('missing-canonical', `Canonical skills directory ${canonical} is missing; refusing to create a broken .claude/skills adapter. Install skills first (installer -Tools claude or any shared-skill tool).`);
  }
}

export function ensureSkillsLink(projectRoot, { fsImpl = fs, platform = process.platform } = {}) {
  const { root, canonical, link } = paths(projectRoot);
  assertCanonicalSkills(root, { fsImpl });
  for (let attempt = 0; attempt < 2; attempt++) {
    const inspected = inspectSkillsLink(root, { fsImpl, platform });
    if (inspected.state === 'correct') return { status: 'unchanged', link };
    if (inspected.state !== 'missing') throw new BootstrapError(`existing-${inspected.state}`, REFUSALS[inspected.state](link, canonical));
    fsImpl.mkdirSync(path.dirname(link), { recursive: true });
    try {
      // Windows: a junction needs no elevation, Developer Mode or core.symlinks, but requires an absolute target.
      if (platform === 'win32') fsImpl.symlinkSync(canonical, link, 'junction');
      else fsImpl.symlinkSync(POSIX_LINK_TARGET, link, 'dir');
    } catch (error) {
      if (error.code === 'EEXIST') continue; // lost a race: re-inspect instead of overwriting
      throw new BootstrapError('link-failed', `Could not create ${link}: ${error.message}. No fallback copy is made; canonical skills stay only in .agents/skills.`);
    }
    const verified = inspectSkillsLink(root, { fsImpl, platform });
    if (verified.state !== 'correct') throw new BootstrapError('link-unverified', `Created ${link} but it does not resolve to ${canonical}.`);
    return { status: 'created', link };
  }
  throw new BootstrapError('race', `${link} changed while it was being created; rerun.`);
}

function defaultProjectRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(scriptDir) !== 'agent-kit' || path.basename(path.dirname(scriptDir)) !== '.claude') return null;
  return path.resolve(scriptDir, '..', '..');
}

function main(argv) {
  const flag = argv.indexOf('--project');
  const projectRoot = flag >= 0 ? argv[flag + 1] : defaultProjectRoot();
  if (!projectRoot) {
    console.error('Agent Kit Claude bootstrap: run the installed copy at .claude/agent-kit/claude-bootstrap.mjs, or pass --project <dir>.');
    return 2;
  }
  try { ensureSkillsLink(projectRoot); return 0; } catch (error) {
    console.error(`Agent Kit Claude bootstrap refused: ${error.message}`);
    return 2; // Claude Code hook convention: exit 2 surfaces stderr to the user
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
