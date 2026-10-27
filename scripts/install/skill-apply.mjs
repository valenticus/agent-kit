// Applies a skill update plan from skill-update.mjs, and recovers an interrupted update.
//   node skill-apply.mjs apply   --project <dir> [--skills a,b]
//   node skill-apply.mjs recover --project <dir>
// install.ps1 -UpdateSkills [-DryRun] and -RecoverSkillUpdate call these commands.
//
// Safety model:
// - The plan is never trusted: it is rebuilt and must match exactly, and every skill is re-verified against the
//   catalog immediately before it is replaced. Only skills whose content matches a released version are touched.
// - One update per project at a time: .agent-kit-update.lock in the project root records the operation and what it
//   will stage. It is written completely to a private temporary file first and then hard-linked into place, so it is
//   never observed empty or half written.
// - New content is staged in <.agents|.cline>/.agent-kit-update/<operation>/new, outside the skills roots, and its
//   hashes are verified. A journal (written once, never updated) then records the old and new hashes of every skill.
// - Each skill is swapped with two renames: live -> staging/old, then staging/new -> live. They are not atomic
//   together; if the second fails, the first is reversed. If that also fails, the old version stays in staging/old,
//   and the lock and journal are kept for recovery. Transient Windows errors (EPERM, EBUSY, EACCES) are retried a few
//   times, but only when the failed rename changed nothing and the expected state still holds.
// - Ownership of leftovers requires the lock, the staging directory name, and the journal to name the same
//   operation, plus matching hashes. Journal and lock contents are validated against the catalog; target paths are
//   always derived from the verified project root, never taken from those files, and every rename stays inside the
//   project. Nothing is deleted recursively: only files this process created, or trees whose files match the
//   journal, are removed, and directories only when empty.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { distributedSkills, isSafeRelativePath, loadCatalog, normalizedHash } from './skill-catalog.mjs';
import { LOCATIONS, LOCK_NAME, PlanError, STAGING_NAME, formatPlan, planSkillUpdate } from './skill-update.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export { LOCK_NAME, STAGING_NAME };
const JOURNAL = 'journal.json';
const FORMAT = 1;
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RECOVER = 'install.ps1 -ProjectRoot <project> -RecoverSkillUpdate (or: node scripts/install/skill-apply.mjs recover --project <project>)';
// Bounded retries for errors Windows reports while another program briefly holds a file or directory open.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
// File systems without hard links (for example FAT) fall back to exclusive creation of the lock itself.
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EINVAL', 'EXDEV']);

export class UpdateError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, details); }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameFiles = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => b[key] === a[key]);
const posixRelative = (from, to) => path.relative(from, to).split(path.sep).join('/');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function lstatOrNull(fsImpl, file) {
  try { return fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const validFiles = (files) => isObject(files) && Object.keys(files).length > 0
  && Object.entries(files).every(([file, digest]) => isSafeRelativePath(file) && typeof digest === 'string' && DIGEST.test(digest));

// Files (normalized hashes) and directories of a tree; links and special files are refused.
function tree(fsImpl, dir) {
  const files = {};
  const dirs = [];
  const walk = (current, prefix) => {
    for (const name of fsImpl.readdirSync(current).sort(byCodeUnit)) {
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fsImpl.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { dirs.push(relative); walk(absolute, relative); }
      else if (stat.isFile()) files[relative] = normalizedHash(fsImpl.readFileSync(absolute));
      else throw new UpdateError(`${absolute} is a link, junction, or special file.`);
    }
  };
  walk(dir, '');
  return { files, dirs };
}

// True when every file is part of `expected` with the same content and every directory leads to an expected file:
// what remains of an expected tree after some of its files were deleted.
function partOf(files, dirs, expected) {
  const parents = new Set(Object.keys(expected).flatMap((file) => file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
  return Object.entries(files).every(([file, digest]) => expected[file] === digest) && dirs.every((dir) => parents.has(dir));
}

// absent; from or to (exact); from-part, to-part, or part (an incomplete remainder of from, of to, or of both);
// other (unknown content); unsafe (link, file, special entry).
function classify(fsImpl, dir, from, to) {
  const stat = lstatOrNull(fsImpl, dir);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unsafe';
  let found;
  try { found = tree(fsImpl, dir); } catch { return 'unsafe'; }
  if (sameFiles(found.files, from)) return 'from';
  if (sameFiles(found.files, to)) return 'to';
  const [ofFrom, ofTo] = [partOf(found.files, found.dirs, from), partOf(found.files, found.dirs, to)];
  return ofFrom && ofTo ? 'part' : ofFrom ? 'from-part' : ofTo ? 'to-part' : 'other';
}

// Every component from the project root down to `target` must exist (the last one may be absent with `mayBeAbsent`)
// and be a real directory (a regular file for a `file` leaf), never a symbolic link or junction. Called immediately
// before each read of a staged tree and each rename, unlink, rmdir, mkdir, or file creation, so a link planted in any
// parent is refused instead of followed. Node.js has no openat/O_NOFOLLOW for directories, so a concurrent process
// that swaps a component in the instant between this check and the system call is not excluded; see the docs.
// With `absentOk`, any missing component means there is nothing there (false) rather than an error.
function assertRealPath(fsImpl, project, target, { leaf = 'dir', mayBeAbsent = false, absentOk = false } = {}) {
  if (!inside(project, target)) throw new UpdateError(`Refusing to touch ${target}: it is not inside the project.`, { unsafePath: true });
  const parts = path.relative(project, target).split(path.sep);
  let current = project;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const last = index === parts.length - 1;
    const stat = lstatOrNull(fsImpl, current);
    if (!stat) {
      if (absentOk || (last && mayBeAbsent)) return false;
      throw new UpdateError(`Refusing to touch ${posixRelative(project, target)}: ${posixRelative(project, current)} is missing.`, { unsafePath: true });
    }
    if (stat.isSymbolicLink()) throw new UpdateError(`Refusing to touch ${posixRelative(project, target)}: ${posixRelative(project, current)} is a link or junction.`, { unsafePath: true });
    if (last && leaf === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new UpdateError(`Refusing to touch ${posixRelative(project, target)}: ${posixRelative(project, current)} is not the expected ${last && leaf === 'file' ? 'file' : 'directory'}.`, { unsafePath: true });
  }
  return true;
}

function safeUnlink(fsImpl, project, file) {
  assertRealPath(fsImpl, project, file, { leaf: 'file' });
  fsImpl.unlinkSync(file);
}

// true when removed; false when absent or not empty. Links are never removed or followed.
function safeRmdir(fsImpl, project, dir) {
  if (!assertRealPath(fsImpl, project, dir, { absentOk: true })) return false;
  try { fsImpl.rmdirSync(dir); return true; } catch (error) { if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }
}

function safeMkdir(fsImpl, project, dir) {
  assertRealPath(fsImpl, project, path.dirname(dir));
  fsImpl.mkdirSync(dir);
}

// Removes a tree only when its files match the expected hashes (all of them, or with `partial` a remainder of them);
// directories are removed only when empty. The tree and every parent are re-checked for links before each step.
function removeVerified(fsImpl, project, dir, expected, { partial = false } = {}) {
  assertRealPath(fsImpl, project, dir);
  const { files, dirs } = tree(fsImpl, dir);
  if (!(partial ? partOf(files, dirs, expected) : sameFiles(files, expected))) throw new UpdateError(`${dir} no longer matches the recorded content; it was left in place.`, { mismatch: true });
  for (const file of Object.keys(files)) safeUnlink(fsImpl, project, path.join(dir, ...file.split('/')));
  for (const sub of dirs.reverse()) { const target = path.join(dir, ...sub.split('/')); assertRealPath(fsImpl, project, target); fsImpl.rmdirSync(target); }
  assertRealPath(fsImpl, project, dir);
  fsImpl.rmdirSync(dir);
}

// A rename whose source and target parent are re-checked for links before every attempt; the target must not exist.
// The content check (`stillValid`, which reads whole trees) runs first, so the link checks are the last thing before
// the rename: this narrows, but cannot close, the window in which a concurrent process could swap a component.
function guardedRename(fsImpl, project, from, to, delays, stillValid = () => true) {
  const check = () => {
    if (!stillValid()) return false;
    assertRealPath(fsImpl, project, from);
    assertRealPath(fsImpl, project, path.dirname(to));
    if (lstatOrNull(fsImpl, to)) throw new UpdateError(`Refusing to move onto ${posixRelative(project, to)}: it already exists.`, { unsafePath: true });
    return true;
  };
  if (!check()) throw new UpdateError(`${posixRelative(project, from)} changed before it could be moved; it was not moved.`);
  renameWithRetry(fsImpl, from, to, delays, check);
}

// A rename target must be a direct child of <project>/<.agents|.cline>/skills, and every component from the project
// to that skills root must be a real directory: never written through a link, never outside the project.
function assertSkillTarget(fsImpl, project, parent, target) {
  const root = path.join(project, parent, 'skills');
  if (!inside(project, target) || path.dirname(target) !== root) throw new UpdateError(`Refusing to write ${target}: it is not a skill directory of this project.`);
  for (const component of [path.join(project, parent), root]) {
    const stat = lstatOrNull(fsImpl, component);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new UpdateError(`Refusing to write into ${posixRelative(project, component)}: it is missing, a link or junction, or not a directory.`);
  }
}

// Renames, retrying transient Windows errors only while the failed attempt changed nothing and `stillValid` holds.
function renameWithRetry(fsImpl, from, to, delays, stillValid = () => true) {
  for (let attempt = 0; ; attempt++) {
    try { fsImpl.renameSync(from, to); return; } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= delays.length) throw error;
      sleep(delays[attempt]);
      if (!lstatOrNull(fsImpl, from) || lstatOrNull(fsImpl, to) || !stillValid()) throw error;
    }
  }
}

// null when absent; the lock when complete and well formed; { incomplete: true } otherwise.
export function readLock(fsImpl, project) {
  const file = path.join(project, LOCK_NAME);
  const stat = lstatOrNull(fsImpl, file);
  if (!stat) return null;
  let lock = null;
  if (stat.isFile()) {
    try { lock = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (error) {
      // Released by its owner between lstat and read: there is no lock any more.
      if (error.code === 'ENOENT') return null;
    }
  }
  if (lock?.format !== FORMAT || !OPERATION.test(lock?.operation ?? '')) return { incomplete: true };
  return lock;
}

const lockedError = (lock) => new UpdateError(lock.incomplete
  ? `${LOCK_NAME} exists but is not a complete Agent Kit lock. It may belong to an update that is just starting (try again in a moment), be left by a much older interrupted start, or be an unrelated file. It was left untouched; remove it only after confirming that no Agent Kit update is running for this project.`
  : `Another skill update holds ${LOCK_NAME} (operation ${lock.operation}, pid ${lock.pid} on ${lock.host}). Wait for it, or if it was interrupted run: ${RECOVER}`, { locked: true });

// The lock records what will be staged (skill, location, target hashes), so an interruption before the journal exists
// can still be cleaned up without guessing. It appears under its final name only once completely written.
function acquireLock(fsImpl, project, operation, entries, delays) {
  const file = path.join(project, LOCK_NAME);
  const temp = path.join(project, `${LOCK_NAME}.${operation}.tmp`);
  const content = `${JSON.stringify({ format: FORMAT, operation, pid: process.pid, host: os.hostname(), started: new Date().toISOString(), entries })}\n`;
  // EEXIST: report the holder. A lock released between our attempt and the read is simply retried, a few times.
  const taken = (attempt) => {
    const held = readLock(fsImpl, project);
    if (held) throw lockedError(held);
    if (attempt >= 2) throw new UpdateError(`Another skill update kept taking and releasing ${LOCK_NAME}; try again.`, { locked: true });
  };
  const exclusive = (target) => {
    let fd;
    try { fd = fsImpl.openSync(target, 'wx'); } catch (error) { error.exists = error.code === 'EEXIST'; throw error; }
    try { fsImpl.writeFileSync(fd, content); } catch (error) { fsImpl.closeSync(fd); fsImpl.unlinkSync(target); throw error; }
    fsImpl.closeSync(fd);
  };
  exclusive(temp);
  let linked = false;
  let failure = null;
  try {
    for (let attempt = 0; !linked; attempt++) {
      try { fsImpl.linkSync(temp, file); linked = true; } catch (error) {
        if (error.code === 'EEXIST') { taken(attempt); continue; }
        if (!NO_HARD_LINKS.has(error.code)) throw error;
        try { exclusive(file); linked = true; } catch (fallback) { if (!fallback.exists) throw fallback; taken(attempt); }
      }
    }
  } catch (error) { failure = error; }
  // The private file is always removed. If that fails (Windows: another program holds it), the update does not start
  // and a lock created here is released, so no half-acquired state remains; the leftover file is named.
  for (let attempt = 0; ; attempt++) {
    try { fsImpl.unlinkSync(temp); break; } catch (error) {
      if (error.code === 'ENOENT') break;
      if (RETRYABLE.has(error.code) && attempt < delays.length) { sleep(delays[attempt]); continue; }
      if (linked) try { releaseLock(fsImpl, project, operation); } catch { /* reported below */ }
      throw new UpdateError(`Could not remove the temporary lock file ${path.basename(temp)} (${error.code ?? error.message}); the update did not start and nothing else was changed. Close programs that may hold it (for example antivirus), delete that file, and try again.${failure ? ` Earlier: ${failure.message}` : ''}`, { cause: error });
    }
  }
  if (failure) throw failure;
}

function releaseLock(fsImpl, project, operation) {
  if (readLock(fsImpl, project)?.operation === operation) fsImpl.unlinkSync(path.join(project, LOCK_NAME));
}

const signature = (plan) => JSON.stringify([plan.project, plan.version, plan.blockers.length, plan.entries.map((entry) => [entry.skill, entry.location, entry.status, entry.installedReleases ?? null, entry.targetReleases])]);
const stagingBase = (project, location) => path.join(project, location.split('/')[0], STAGING_NAME);

export function applySkillUpdate(plan, { kitRoot: root = kitRoot, fsImpl = fs, onStep = () => {}, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.project !== 'string' || !Array.isArray(plan.entries) || !Array.isArray(plan.blockers)) throw new UpdateError('Not a skill update plan.');
  // A running or interrupted update is reported as such, before any replanning.
  const held = readLock(fsImpl, plan.project);
  if (held) throw lockedError(held);
  if (plan.canApply !== true) throw new UpdateError('The plan has conflicts or blockers; nothing was changed.');
  const stale = () => new UpdateError('The plan is out of date: the project, catalog, or installed skills changed since planning. Plan again; nothing was changed.', { stale: true });
  let fresh;
  try { fresh = planSkillUpdate(plan.project, { kitRoot: root, skills: plan.selected ?? undefined, fsImpl }); } catch (error) {
    // Another update moved a skill while this one was replanning.
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw stale();
    throw error;
  }
  if (!fresh.canApply || signature(fresh) !== signature(plan)) throw stale();
  const updates = fresh.entries.filter((entry) => entry.status === 'update');
  if (updates.length === 0) return { operation: null, updated: [] };

  const project = fresh.project;
  const catalog = loadCatalog(root);
  const sources = distributedSkills(root);
  const work = updates.map((entry) => {
    const versions = catalog.skills[entry.skill].versions;
    const to = versions.find((version) => version.releases.includes(fresh.version)).files;
    const from = versions.find((version) => version.releases.join() === entry.installedReleases.join()).files;
    const source = sources.get(entry.skill).dir;
    let sourceFiles;
    try { sourceFiles = tree(fsImpl, source).files; } catch (error) { throw new UpdateError(`Kit source for ${entry.skill}: ${error.message}`); }
    if (!sameFiles(sourceFiles, to)) throw new UpdateError(`The kit source for ${entry.skill} differs from the catalog entry for ${fresh.version}; nothing was changed.`);
    return { ...entry, from, to, source, parent: entry.location.split('/')[0], live: path.join(project, ...entry.location.split('/'), entry.skill) };
  });

  const operation = randomUUID();
  acquireLock(fsImpl, project, operation, work.map(({ skill, location, to }) => ({ skill, location, to })), retryDelaysMs);
  // Leftovers of another operation must be recovered or removed by a person first.
  for (const location of new Set(work.map((item) => item.location))) {
    const base = stagingBase(project, location);
    let problem = null;
    try {
      if (assertRealPath(fsImpl, project, base, { mayBeAbsent: true }) && fsImpl.readdirSync(base).length) problem = `${posixRelative(project, base)} contains leftovers of an earlier update that ${LOCK_NAME} does not cover; review them manually.`;
    } catch (error) { if (!error.unsafePath) throw error; problem = `${error.message} It was left untouched.`; }
    if (problem) { releaseLock(fsImpl, project, operation); throw new UpdateError(problem); }
  }
  const createdFiles = [];
  const createdDirs = [];
  const mkdir = (dir) => { safeMkdir(fsImpl, project, dir); createdDirs.push(dir); };
  const copy = (from, to) => {
    mkdir(to);
    for (const name of fsImpl.readdirSync(from).sort(byCodeUnit)) {
      const source = path.join(from, name);
      if (fsImpl.lstatSync(source).isDirectory()) { copy(source, path.join(to, name)); continue; }
      const target = path.join(to, name);
      assertRealPath(fsImpl, project, to);
      const fd = fsImpl.openSync(target, 'wx');
      createdFiles.push(target);
      try { fsImpl.writeFileSync(fd, fsImpl.readFileSync(source)); } finally { fsImpl.closeSync(fd); }
    }
  };
  // The previous copy normally matches the journal exactly; if it changed during the update it is kept, because it
  // may hold someone's edits, and the lock and journal stay so that recovery can finish once it is moved away.
  const removeOld = (item) => {
    try { removeVerified(fsImpl, project, item.old, item.from); } catch (error) {
      if (!error.mismatch) throw error;
      throw new UpdateError(`${item.skill} in ${item.location} was updated, but its previous copy changed during the update and may contain edits. It was kept at ${posixRelative(project, item.old)}. Move that directory out of the project's staging area, then run: ${RECOVER}`, { recoveryRequired: true, operation, updated: updatedSoFar() });
    }
  };
  const stages = new Map();
  const done = [];
  const updatedSoFar = () => done.map(({ old, item, ...entry }) => entry);
  try {
    for (const location of [...new Set(work.map((item) => item.location))].sort(byCodeUnit)) {
      const base = stagingBase(project, location);
      if (!assertRealPath(fsImpl, project, base, { mayBeAbsent: true })) mkdir(base);
      const stage = path.join(base, operation);
      mkdir(stage);
      if (!inside(project, fsImpl.realpathSync(stage))) throw new UpdateError(`Staging ${stage} resolves outside the project.`);
      mkdir(path.join(stage, 'new'));
      mkdir(path.join(stage, 'old'));
      const items = work.filter((item) => item.location === location);
      for (const item of items) {
        item.staged = path.join(stage, 'new', item.skill);
        item.old = path.join(stage, 'old', item.skill);
        copy(item.source, item.staged);
        assertRealPath(fsImpl, project, item.staged);
        if (!sameFiles(tree(fsImpl, item.staged).files, item.to)) throw new UpdateError(`The staged copy of ${item.skill} does not match the catalog.`);
      }
      const journal = path.join(stage, JOURNAL);
      assertRealPath(fsImpl, project, stage);
      const fd = fsImpl.openSync(journal, 'wx');
      createdFiles.push(journal);
      try { fsImpl.writeFileSync(fd, `${JSON.stringify({ format: FORMAT, operation, project, location, version: fresh.version, entries: items.map(({ skill, from, to }) => ({ skill, from, to })) }, null, 2)}\n`); }
      finally { fsImpl.closeSync(fd); }
      stages.set(location, stage);
    }
    onStep('staged', { operation, project });

    for (const item of work) {
      onStep('before-swap', item);
      assertSkillTarget(fsImpl, project, item.parent, item.live);
      const liveUnchanged = () => classify(fsImpl, item.live, item.from, item.to) === 'from';
      if (!liveUnchanged()) throw new UpdateError(`${item.skill} in ${item.location} changed after planning; it was not replaced.`);
      try { guardedRename(fsImpl, project, item.live, item.old, retryDelaysMs, liveUnchanged); } catch (error) {
        // A rename can report an error after it took effect; then the previous version is already in staging/old.
        if (!lstatOrNull(fsImpl, item.live) && lstatOrNull(fsImpl, item.old)) {
          throw new UpdateError(`Moving ${item.skill} in ${item.location} reported ${error.code ?? error.message} but took effect. The previous version is kept at ${posixRelative(project, item.old)}. Run: ${RECOVER}`, { recoveryRequired: true, operation, updated: updatedSoFar() });
        }
        throw error;
      }
      try {
        guardedRename(fsImpl, project, item.staged, item.live, retryDelaysMs, () => classify(fsImpl, item.staged, item.from, item.to) === 'to');
      } catch (error) {
        try { guardedRename(fsImpl, project, item.old, item.live, retryDelaysMs); } catch (rollbackError) {
          throw new UpdateError(`Could not finish or undo the update of ${item.skill} in ${item.location} (${error.code ?? error.message}; restore failed: ${rollbackError.code ?? rollbackError.message}). The previous version is kept at ${posixRelative(project, item.old)}. Close programs using the skill, then run: ${RECOVER}`, { recoveryRequired: true, operation, updated: updatedSoFar() });
        }
        throw error;
      }
      done.push({ skill: item.skill, location: item.location, from: item.installedReleases, to: item.targetReleases, old: item.old, item });
      if (classify(fsImpl, item.live, item.from, item.to) !== 'to') throw new UpdateError(`${item.skill} in ${item.location} does not match the catalog after replacement. Run: ${RECOVER}`, { recoveryRequired: true, operation, updated: updatedSoFar() });
    }
  } catch (error) {
    if (error.recoveryRequired) throw error;
    // Completed swaps stay; their old copies and everything this run created are removed.
    try {
      for (const entry of done) removeOld(entry.item);
      for (const file of createdFiles.reverse()) if (assertRealPath(fsImpl, project, file, { leaf: 'file', absentOk: true })) fsImpl.unlinkSync(file);
      for (const dir of createdDirs.reverse()) safeRmdir(fsImpl, project, dir);
      releaseLock(fsImpl, project, operation);
    } catch (cleanupError) {
      if (cleanupError.recoveryRequired) throw cleanupError;
      throw new UpdateError(`Skill update stopped (${error.code ?? error.message}) and its cleanup also failed (${cleanupError.code ?? cleanupError.message}). Run: ${RECOVER}`, { recoveryRequired: true, operation, cause: error });
    }
    const updated = updatedSoFar();
    if (error instanceof UpdateError) { error.updated = updated; throw error; }
    throw new UpdateError(`Skill update stopped (${error.code ?? error.message}); ${updated.length ? `already updated: ${updated.map((entry) => `${entry.skill} in ${entry.location}`).join(', ')}; ` : ''}nothing else was changed.`, { cause: error, updated });
  }

  for (const entry of done) removeOld(entry.item);
  for (const [location, stage] of stages) {
    safeUnlink(fsImpl, project, path.join(stage, JOURNAL));
    for (const dir of [path.join(stage, 'new'), path.join(stage, 'old'), stage, stagingBase(project, location)]) safeRmdir(fsImpl, project, dir);
  }
  releaseLock(fsImpl, project, operation);
  return { operation, updated: updatedSoFar() };
}

// The JSON text a journal starts with; a crash while writing it leaves a prefix of this text (or a longer one).
const journalHeader = (operation, project, location) => JSON.stringify({ format: FORMAT, operation, project, location }, null, 2).slice(0, -2);

// A stage without a usable journal was interrupted while staging. No rename happens before every journal is complete,
// so installed skills are untouched. Lists what to remove, provided that staging/old is empty and every staged file is
// declared by the lock and is a byte prefix of the kit source whose hash the lock recorded; otherwise refuses. A
// truncated journal is removable only when it is a prefix of (or starts with) this operation's journal header.
function stagingLeftovers(fsImpl, project, stage, location, lock, sources, truncatedJournal) {
  const fail = (why) => { throw new UpdateError(`Cannot clean up operation ${lock.operation} in ${location.split('/')[0]}: ${why}. Nothing was changed; review ${posixRelative(project, stage)} and ${LOCK_NAME} manually.`); };
  if (!Array.isArray(lock.entries)) fail('its lock does not record what was being staged');
  const intended = new Map(lock.entries.filter((entry) => entry.location === location).map((entry) => [entry.skill, entry.to]));
  const files = [];
  const dirs = [];
  for (const name of fsImpl.readdirSync(stage).sort(byCodeUnit)) {
    const dir = path.join(stage, name);
    const stat = fsImpl.lstatSync(dir);
    if (name === JOURNAL && truncatedJournal && stat.isFile() && !stat.isSymbolicLink()) { files.push(dir); continue; }
    if (!['new', 'old'].includes(name) || stat.isSymbolicLink() || !stat.isDirectory()) fail(`unexpected entry ${name}`);
    if (name === 'old') {
      if (fsImpl.readdirSync(dir).length) fail('staging/old is not empty');
      dirs.push(dir);
      continue;
    }
    for (const skill of fsImpl.readdirSync(dir).sort(byCodeUnit)) {
      const to = intended.get(skill);
      if (!to || !sources.has(skill)) fail(`${skill} was not being staged`);
      const skillDir = path.join(dir, skill);
      const skillStat = fsImpl.lstatSync(skillDir);
      if (skillStat.isSymbolicLink() || !skillStat.isDirectory()) fail(`new/${skill} is not a directory`);
      let staged;
      try { staged = tree(fsImpl, skillDir); } catch (error) { fail(error.message); }
      for (const rel of Object.keys(staged.files)) {
        if (!Object.hasOwn(to, rel)) fail(`new/${skill}/${rel} was not part of the version being staged`);
        let source;
        try { source = fsImpl.readFileSync(path.join(sources.get(skill).dir, ...rel.split('/'))); } catch { fail(`the kit source of ${skill}/${rel} is missing`); }
        if (normalizedHash(source) !== to[rel]) fail(`the kit source of ${skill} changed since the update started`);
        const file = path.join(skillDir, ...rel.split('/'));
        const bytes = fsImpl.readFileSync(file);
        if (bytes.length > source.length || !bytes.equals(source.subarray(0, bytes.length))) fail(`new/${skill}/${rel} does not match the kit source`);
        files.push(file);
      }
      dirs.push(...staged.dirs.reverse().map((sub) => path.join(skillDir, ...sub.split('/'))), skillDir);
    }
    dirs.push(dir);
  }
  return { files, dirs };
}

// Resolves an interrupted update: completes a swap that reached its second rename, otherwise restores the previous
// version, finishes removing copies left half deleted, and removes the staging of an update interrupted before its
// journals were complete. Every entry is classified before anything changes; any ambiguity stops with a diagnostic.
export function recoverSkillUpdate(projectRoot, { kitRoot: root = kitRoot, fsImpl = fs, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const project = fsImpl.realpathSync(path.resolve(projectRoot));
  const lock = readLock(fsImpl, project);
  if (!lock) throw new UpdateError(`No ${LOCK_NAME}: there is no interrupted update to recover.`);
  if (lock.incomplete) throw new UpdateError(`${LOCK_NAME} is not a complete Agent Kit lock, so recovery cannot prove what it belongs to; nothing was changed. If no Agent Kit update is running for this project, review it and remove it manually.`);
  const { operation } = lock;
  if (lock.host === os.hostname() && lock.pid !== process.pid) {
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
    if (alive) throw new UpdateError(`Process ${lock.pid} that started operation ${operation} is still running; nothing was changed.`);
  }
  const catalog = loadCatalog(root);
  const knownSkill = (name) => typeof name === 'string' && SKILL_NAME.test(name) && Object.hasOwn(catalog.skills, name);
  if (lock.entries !== undefined && !(Array.isArray(lock.entries) && lock.entries.every((entry) => isObject(entry) && knownSkill(entry.skill) && LOCATIONS.includes(entry.location) && validFiles(entry.to)))) {
    throw new UpdateError(`${LOCK_NAME} records entries that are not valid Agent Kit skills, locations, or hashes; nothing was changed.`);
  }
  let sources = null;
  const actions = [];
  const stages = [];
  try {
    for (const parent of ['.agents', '.cline']) {
      const location = `${parent}/skills`;
      const base = path.join(project, parent, STAGING_NAME);
      // The parent and the staging root must be real directories inside the project; links are refused, not followed.
      if (!assertRealPath(fsImpl, project, path.join(project, parent), { mayBeAbsent: true })) continue;
      if (!assertRealPath(fsImpl, project, base, { mayBeAbsent: true })) continue;
      const names = fsImpl.readdirSync(base);
      const unknown = names.filter((name) => name !== operation);
      if (unknown.length) throw new UpdateError(`${parent}/${STAGING_NAME} contains entries that do not belong to operation ${operation}: ${unknown.join(', ')}. Review them manually; nothing was changed.`);
      if (!names.length) { stages.push({ base }); continue; }
      const stage = path.join(base, operation);
      assertRealPath(fsImpl, project, stage);
      const journalFile = path.join(stage, JOURNAL);
      const journalStat = assertRealPath(fsImpl, project, journalFile, { leaf: 'file', mayBeAbsent: true });
      let journal = null;
      if (journalStat) {
        const text = fsImpl.readFileSync(journalFile, 'utf8');
        try { journal = JSON.parse(text); } catch {
          const header = journalHeader(operation, project, location);
          if (!(text.startsWith(header) || header.startsWith(text))) throw new UpdateError(`${posixRelative(project, journalFile)} is unreadable and not a journal of operation ${operation}; nothing was changed.`);
        }
      }
      if (!journal) {
        stages.push({ base, stage, leftovers: stagingLeftovers(fsImpl, project, stage, location, lock, sources ??= distributedSkills(root), Boolean(journalStat)) });
        continue;
      }
      // Every field is checked; paths are derived from the verified project root, never from the journal.
      const entries = Array.isArray(journal.entries) ? journal.entries : [];
      const valid = isObject(journal) && journal.format === FORMAT && journal.operation === operation && journal.project === project && journal.location === location
        && entries.length > 0 && entries.every((entry) => isObject(entry) && knownSkill(entry.skill) && validFiles(entry.from) && validFiles(entry.to))
        && new Set(entries.map((entry) => entry.skill)).size === entries.length;
      if (!valid) throw new UpdateError(`${posixRelative(project, journalFile)} is not a valid journal of operation ${operation} for ${location}; nothing was changed.`);
      // Every directory the actions read, move, or delete through must be a real directory, never a link.
      for (const dir of [path.join(stage, 'old'), path.join(stage, 'new'), path.join(project, parent, 'skills')]) assertRealPath(fsImpl, project, dir, { mayBeAbsent: true });
      for (const { skill, from, to } of entries) {
        const live = path.join(project, parent, 'skills', skill);
        const old = path.join(stage, 'old', skill);
        const staged = path.join(stage, 'new', skill);
        const state = [classify(fsImpl, live, from, to), classify(fsImpl, old, from, to), classify(fsImpl, staged, from, to)].join(',');
        const label = `${skill} in ${location}`;
        // live,old,new -> action. A "-part"/"part" copy is what remains of a tree whose removal was interrupted.
        const decision = {
          'to,from,absent': 'finish', 'to,from-part,absent': 'finish', 'to,part,absent': 'finish', 'to,absent,absent': 'done',
          'from,absent,to': 'discard', 'from,absent,to-part': 'discard', 'from,absent,part': 'discard', 'from,absent,absent': 'done',
          'absent,from,to': 'restore', 'absent,from,absent': 'restore',
        }[state];
        if (!decision) {
          const kept = state.startsWith('to,other') || state.startsWith('to,unsafe')
            ? ` The previous copy at ${posixRelative(project, old)} differs from the recorded version and may contain edits; move it out of the staging area, then run recovery again.` : ' Resolve it manually.';
          throw new UpdateError(`Cannot recover ${label} unambiguously (live, staged old, staged new: ${state}). Nothing was changed.${kept}`);
        }
        actions.push({ label, parent, decision, live, old, staged, from, to });
      }
      stages.push({ base, stage, journalFile });
    }
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(`Recovery could not inspect the leftovers (${error.code ?? error.message}); nothing was changed.`, { cause: error });
  }
  const results = [];
  let current = null;
  try {
    for (const action of actions) {
      current = action;
      if (action.decision === 'restore') {
        assertSkillTarget(fsImpl, project, action.parent, action.live);
        guardedRename(fsImpl, project, action.old, action.live, retryDelaysMs, () => classify(fsImpl, action.old, action.from, action.to) === 'from');
      }
      if (action.decision === 'finish') removeVerified(fsImpl, project, action.old, action.from, { partial: true });
      if (['restore', 'discard'].includes(action.decision) && assertRealPath(fsImpl, project, action.staged, { absentOk: true })) removeVerified(fsImpl, project, action.staged, action.to, { partial: true });
      results.push({ skill: action.label, result: action.decision === 'finish' || (action.decision === 'done' && classify(fsImpl, action.live, action.from, action.to) === 'to') ? 'updated' : 'previous version' });
    }
    current = null;
    for (const { base, stage, journalFile, leftovers } of stages) {
      if (leftovers) {
        for (const file of leftovers.files) safeUnlink(fsImpl, project, file);
        for (const dir of [...leftovers.dirs, stage]) if (!safeRmdir(fsImpl, project, dir) && assertRealPath(fsImpl, project, dir, { absentOk: true })) throw new UpdateError(`${dir} still contains unexpected files; review it manually. ${LOCK_NAME} was kept.`);
        results.push({ skill: `staging in ${posixRelative(project, base)}`, result: 'removed; installed skills were not changed' });
      } else if (stage) {
        safeUnlink(fsImpl, project, journalFile);
        for (const dir of [path.join(stage, 'new'), path.join(stage, 'old'), stage]) if (!safeRmdir(fsImpl, project, dir) && assertRealPath(fsImpl, project, dir, { absentOk: true })) throw new UpdateError(`${dir} still contains unexpected files; review it manually. ${LOCK_NAME} was kept.`);
      }
      safeRmdir(fsImpl, project, base);
    }
    releaseLock(fsImpl, project, operation);
  } catch (error) {
    if (error.unsafePath) throw new UpdateError(`Recovery stopped${current ? ` while handling ${current.label}` : ''}: ${error.message} ${LOCK_NAME} was kept; nothing outside the project was touched. Review the staging area manually.`, { cause: error });
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(`Recovery stopped (${error.code ?? error.message})${current ? ` while handling ${current.label}` : ' while removing staging'}; ${LOCK_NAME} was kept. Resolve the cause (for example close programs using the skill), then run recovery again.`, { cause: error });
  }
  return { operation, results };
}

function main(argv) {
  const [command] = argv;
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const project = option('--project');
  if (!['apply', 'recover'].includes(command) || !project) { console.error('usage: skill-apply.mjs <apply|recover> --project <dir> [--skills a,b]'); return 2; }
  try {
    if (command === 'recover') {
      const { operation, results } = recoverSkillUpdate(project);
      for (const { skill, result } of results) console.log(`Recovered ${skill}: ${result}`);
      console.log(`Operation ${operation} recovered.`);
      return 0;
    }
    const skills = option('--skills')?.split(',').map((name) => name.trim()).filter(Boolean);
    const plan = planSkillUpdate(project, { skills });
    if (!plan.canApply && !readLock(fs, plan.project)) {
      console.log(formatPlan(plan));
      console.error('Skill update refused: resolve the conflicts or blockers above, or narrow the selection; nothing was changed.');
      return 1;
    }
    const { updated } = applySkillUpdate(plan);
    for (const item of updated) console.log(`Updated ${item.skill} in ${item.location}: ${item.from.at(-1)} -> ${item.to.at(-1)}`);
    if (!updated.length) {
      console.log(plan.entries.length
        ? 'All selected Agent Kit skills are current; nothing was changed.'
        : `No ${plan.selected ? 'selected ' : ''}Agent Kit skills are installed in .agents/skills or .cline/skills; nothing was changed.`);
    }
    for (const name of plan.notInstalled) console.log(`Not installed, so not added: ${name}`);
    for (const note of plan.notes) console.log(`Note: ${note}`);
    return 0;
  } catch (error) {
    console.error(error instanceof UpdateError || error instanceof PlanError ? `Skill update refused: ${error.message}` : `Skill update failed: ${error.code ?? ''} ${error.message}`.trim());
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
