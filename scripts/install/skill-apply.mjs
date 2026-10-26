// Applies a skill update plan from skill-update.mjs, and recovers an interrupted update.
//   node skill-apply.mjs apply   --project <dir> [--skills a,b]
//   node skill-apply.mjs recover --project <dir>
// install.ps1 -UpdateSkills [-DryRun] and -RecoverSkillUpdate call these commands.
//
// Safety model:
// - The plan is never trusted: it is rebuilt and must match exactly, and every skill is re-verified against the
//   catalog immediately before it is replaced. Only skills whose content matches a released version are touched.
// - One update per project at a time: .agent-kit-update.lock in the project root is created exclusively ('wx') and
//   records the operation and what it will stage.
// - New content is staged in <.agents|.cline>/.agent-kit-update/<operation>/new, outside the skills roots, and its
//   hashes are verified. A journal (written once, never updated) then records the old and new hashes of every skill.
// - Each skill is swapped with two renames: live -> staging/old, then staging/new -> live. They are not atomic
//   together; if the second fails, the first is reversed. If that also fails, the old version stays in staging/old,
//   and the lock and journal are kept for recovery.
// - Ownership of leftovers requires the lock, the staging directory name, and the journal to name the same
//   operation, plus matching hashes. Nothing is deleted recursively: only files this process created, or trees whose
//   files exactly match the journal, are removed, and directories only when empty.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { distributedSkills, loadCatalog, normalizedHash } from './skill-catalog.mjs';
import { LOCK_NAME, PlanError, STAGING_NAME, formatPlan, planSkillUpdate } from './skill-update.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export { LOCK_NAME, STAGING_NAME };
const JOURNAL = 'journal.json';
const FORMAT = 1;
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVER = 'install.ps1 -ProjectRoot <project> -RecoverSkillUpdate (or: node scripts/install/skill-apply.mjs recover --project <project>)';

export class UpdateError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, details); }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameFiles = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => b[key] === a[key]);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function lstatOrNull(fsImpl, file) {
  try { return fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

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

// Absent, a real directory whose files are known, or unsafe (link, file, special entry).
function classify(fsImpl, dir, from, to) {
  const stat = lstatOrNull(fsImpl, dir);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unsafe';
  let files;
  try { ({ files } = tree(fsImpl, dir)); } catch { return 'unsafe'; }
  return sameFiles(files, from) ? 'from' : sameFiles(files, to) ? 'to' : 'other';
}

// Removes a tree only when its files exactly match the expected hashes; directories are removed only when empty.
function removeVerified(fsImpl, dir, expected) {
  const { files, dirs } = tree(fsImpl, dir);
  if (!sameFiles(files, expected)) throw new UpdateError(`${dir} no longer matches the recorded content; it was left in place.`);
  for (const file of Object.keys(files)) fsImpl.unlinkSync(path.join(dir, ...file.split('/')));
  for (const sub of dirs.reverse()) fsImpl.rmdirSync(path.join(dir, ...sub.split('/')));
  fsImpl.rmdirSync(dir);
}

function rmdirIfEmpty(fsImpl, dir) {
  try { fsImpl.rmdirSync(dir); return true; } catch (error) { if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }
}

export function readLock(fsImpl, project) {
  const file = path.join(project, LOCK_NAME);
  const stat = lstatOrNull(fsImpl, file);
  if (!stat) return null;
  let lock = null;
  if (stat.isFile()) try { lock = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { /* not ours */ }
  if (lock?.format !== FORMAT || !OPERATION.test(lock?.operation ?? '')) return { foreign: true };
  return lock;
}

const lockedError = (lock) => new UpdateError(lock.foreign
  ? `${LOCK_NAME} exists but was not written by an Agent Kit update; it was left untouched. Remove or rename it before updating.`
  : `Another skill update holds ${LOCK_NAME} (operation ${lock.operation}, pid ${lock.pid} on ${lock.host}). Wait for it, or if it was interrupted run: ${RECOVER}`, { locked: true });

// The lock also records what will be staged (skill, location, target hashes), so an interruption before the journal
// exists can still be cleaned up without guessing.
function acquireLock(fsImpl, project, operation, entries) {
  const file = path.join(project, LOCK_NAME);
  let fd;
  try { fd = fsImpl.openSync(file, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw lockedError(readLock(fsImpl, project) ?? { foreign: true });
  }
  try { fsImpl.writeFileSync(fd, `${JSON.stringify({ format: FORMAT, operation, pid: process.pid, host: os.hostname(), started: new Date().toISOString(), entries })}\n`); }
  catch (error) { fsImpl.closeSync(fd); fd = null; fsImpl.unlinkSync(file); throw error; }
  finally { if (fd !== null) fsImpl.closeSync(fd); }
}

function releaseLock(fsImpl, project, operation) {
  if (readLock(fsImpl, project)?.operation === operation) fsImpl.unlinkSync(path.join(project, LOCK_NAME));
}

const signature = (plan) => JSON.stringify([plan.project, plan.version, plan.blockers.length, plan.entries.map((entry) => [entry.skill, entry.location, entry.status, entry.installedReleases ?? null, entry.targetReleases])]);
const stagingBase = (project, location) => path.join(project, location.split('/')[0], STAGING_NAME);

export function applySkillUpdate(plan, { kitRoot: root = kitRoot, fsImpl = fs, onStep = () => {} } = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.project !== 'string' || !Array.isArray(plan.entries) || !Array.isArray(plan.blockers)) throw new UpdateError('Not a skill update plan.');
  // A running or interrupted update is reported as such, before any replanning.
  const held = readLock(fsImpl, plan.project);
  if (held) throw lockedError(held);
  if (plan.canApply !== true) throw new UpdateError('The plan has conflicts or blockers; nothing was changed.');
  const fresh = planSkillUpdate(plan.project, { kitRoot: root, skills: plan.selected ?? undefined, fsImpl });
  if (!fresh.canApply || signature(fresh) !== signature(plan)) throw new UpdateError('The plan is out of date: the project, catalog, or installed skills changed since planning. Plan again; nothing was changed.', { stale: true });
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
    return { ...entry, from, to, source, live: path.join(project, ...entry.location.split('/'), entry.skill) };
  });

  const operation = randomUUID();
  acquireLock(fsImpl, project, operation, work.map(({ skill, location, to }) => ({ skill, location, to })));
  // Leftovers of another operation must be recovered or removed by a person first.
  for (const location of new Set(work.map((item) => item.location))) {
    const base = stagingBase(project, location);
    const stat = lstatOrNull(fsImpl, base);
    let problem = null;
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) problem = `${path.relative(project, base)} exists but is not a staging directory; it was left untouched.`;
    else if (stat && fsImpl.readdirSync(base).length) problem = `${path.relative(project, base)} contains leftovers of an earlier update that ${LOCK_NAME} does not cover; review them manually.`;
    if (problem) { releaseLock(fsImpl, project, operation); throw new UpdateError(problem); }
  }
  const createdFiles = [];
  const createdDirs = [];
  const mkdir = (dir) => { fsImpl.mkdirSync(dir); createdDirs.push(dir); };
  const copy = (from, to) => {
    mkdir(to);
    for (const name of fsImpl.readdirSync(from).sort(byCodeUnit)) {
      const source = path.join(from, name);
      if (fsImpl.lstatSync(source).isDirectory()) { copy(source, path.join(to, name)); continue; }
      const target = path.join(to, name);
      const fd = fsImpl.openSync(target, 'wx');
      createdFiles.push(target);
      try { fsImpl.writeFileSync(fd, fsImpl.readFileSync(source)); } finally { fsImpl.closeSync(fd); }
    }
  };
  const stages = new Map();
  const done = [];
  try {
    for (const location of [...new Set(work.map((item) => item.location))].sort(byCodeUnit)) {
      const base = stagingBase(project, location);
      if (!lstatOrNull(fsImpl, base)) mkdir(base);
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
        if (!sameFiles(tree(fsImpl, item.staged).files, item.to)) throw new UpdateError(`The staged copy of ${item.skill} does not match the catalog.`);
      }
      const journal = path.join(stage, JOURNAL);
      const fd = fsImpl.openSync(journal, 'wx');
      createdFiles.push(journal);
      try { fsImpl.writeFileSync(fd, `${JSON.stringify({ format: FORMAT, operation, project, location, version: fresh.version, entries: items.map(({ skill, from, to }) => ({ skill, from, to })) }, null, 2)}\n`); }
      finally { fsImpl.closeSync(fd); }
      stages.set(location, stage);
    }
    onStep('staged', { operation, project });

    for (const item of work) {
      onStep('before-swap', item);
      if (classify(fsImpl, item.live, item.from, item.to) !== 'from') throw new UpdateError(`${item.skill} in ${item.location} changed after planning; it was not replaced.`);
      fsImpl.renameSync(item.live, item.old);
      try { fsImpl.renameSync(item.staged, item.live); } catch (error) {
        try { fsImpl.renameSync(item.old, item.live); } catch (rollbackError) {
          throw new UpdateError(`Could not finish or undo the update of ${item.skill} in ${item.location} (${error.code ?? error.message}; restore failed: ${rollbackError.code ?? rollbackError.message}). The previous version is kept at ${path.relative(project, item.old).split(path.sep).join('/')}. Close programs using the skill, then run: ${RECOVER}`, { recoveryRequired: true, operation, updated: done });
        }
        throw error;
      }
      done.push({ skill: item.skill, location: item.location, from: item.installedReleases, to: item.targetReleases, old: item.old });
      if (classify(fsImpl, item.live, item.from, item.to) !== 'to') throw new UpdateError(`${item.skill} in ${item.location} does not match the catalog after replacement. Run: ${RECOVER}`, { recoveryRequired: true, operation, updated: done });
    }
  } catch (error) {
    if (error.recoveryRequired) throw error;
    // Completed swaps stay; their old copies and everything this run created are removed.
    for (const item of done) removeVerified(fsImpl, item.old, work.find((entry) => entry.skill === item.skill && entry.location === item.location).from);
    for (const file of createdFiles.reverse()) if (lstatOrNull(fsImpl, file)) fsImpl.unlinkSync(file);
    for (const dir of createdDirs.reverse()) rmdirIfEmpty(fsImpl, dir);
    releaseLock(fsImpl, project, operation);
    if (error instanceof UpdateError) { error.updated = done; throw error; }
    throw new UpdateError(`Skill update stopped (${error.code ?? error.message}); ${done.length ? `already updated: ${done.map((item) => `${item.skill} in ${item.location}`).join(', ')}; ` : ''}nothing else was changed.`, { cause: error, updated: done });
  }

  for (const item of done) removeVerified(fsImpl, item.old, work.find((entry) => entry.skill === item.skill && entry.location === item.location).from);
  for (const [location, stage] of stages) {
    fsImpl.unlinkSync(path.join(stage, JOURNAL));
    for (const dir of [path.join(stage, 'new'), path.join(stage, 'old'), stage, stagingBase(project, location)]) rmdirIfEmpty(fsImpl, dir);
  }
  releaseLock(fsImpl, project, operation);
  return { operation, updated: done.map(({ old, ...item }) => item) };
}

// A stage without a journal was interrupted while staging. No rename happens before the journal exists, so installed
// skills are untouched. Lists what to remove, provided that staging/old is empty and every staged file is declared by
// the lock and is a byte prefix of the kit source whose hash the lock recorded; otherwise refuses.
function stagingLeftovers(fsImpl, project, stage, location, lock, sources) {
  const fail = (why) => { throw new UpdateError(`Cannot clean up operation ${lock.operation} in ${location.split('/')[0]}: ${why}. Nothing was changed; review ${path.relative(project, stage).split(path.sep).join('/')} and ${LOCK_NAME} manually.`); };
  if (!Array.isArray(lock.entries)) fail('its lock does not record what was being staged');
  const intended = new Map(lock.entries.filter((entry) => entry?.location === location).map((entry) => [entry.skill, entry.to]));
  const files = [];
  const dirs = [];
  for (const name of fsImpl.readdirSync(stage).sort(byCodeUnit)) {
    const dir = path.join(stage, name);
    const stat = fsImpl.lstatSync(dir);
    if (!['new', 'old'].includes(name) || stat.isSymbolicLink() || !stat.isDirectory()) fail(`unexpected entry ${name}`);
    if (name === 'old') {
      if (fsImpl.readdirSync(dir).length) fail('staging/old is not empty');
      dirs.push(dir);
      continue;
    }
    for (const skill of fsImpl.readdirSync(dir).sort(byCodeUnit)) {
      const to = intended.get(skill);
      if (!to || typeof to !== 'object' || !sources.has(skill)) fail(`${skill} was not being staged`);
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
// version, and removes the staging of an update interrupted before its journal. Every entry is classified before
// anything changes; any ambiguity stops with a diagnostic.
export function recoverSkillUpdate(projectRoot, { kitRoot: root = kitRoot, fsImpl = fs } = {}) {
  const project = fsImpl.realpathSync(path.resolve(projectRoot));
  const lock = readLock(fsImpl, project);
  if (!lock) throw new UpdateError(`No ${LOCK_NAME}: there is no interrupted update to recover.`);
  if (lock.foreign) throw new UpdateError(`${LOCK_NAME} was not written by an Agent Kit update; nothing was changed.`);
  const { operation } = lock;
  if (lock.host === os.hostname() && lock.pid !== process.pid) {
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
    if (alive) throw new UpdateError(`Process ${lock.pid} that started operation ${operation} is still running; nothing was changed.`);
  }
  const actions = [];
  const stages = [];
  let sources = null;
  for (const parent of ['.agents', '.cline']) {
    const base = path.join(project, parent, STAGING_NAME);
    const stat = lstatOrNull(fsImpl, base);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UpdateError(`${parent}/${STAGING_NAME} is not a staging directory; nothing was changed.`);
    const names = fsImpl.readdirSync(base);
    const unknown = names.filter((name) => name !== operation);
    if (unknown.length) throw new UpdateError(`${parent}/${STAGING_NAME} contains entries that do not belong to operation ${operation}: ${unknown.join(', ')}. Review them manually; nothing was changed.`);
    if (!names.length) { stages.push({ base }); continue; }
    const stage = path.join(base, operation);
    const stageStat = fsImpl.lstatSync(stage);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) throw new UpdateError(`${stage} is not a staging directory; nothing was changed.`);
    const journalFile = path.join(stage, JOURNAL);
    const journalStat = lstatOrNull(fsImpl, journalFile);
    if (!journalStat) {
      stages.push({ base, stage, leftovers: stagingLeftovers(fsImpl, project, stage, `${parent}/skills`, lock, sources ??= distributedSkills(root)) });
      continue;
    }
    if (!journalStat.isFile()) throw new UpdateError(`${journalFile} is not a file; nothing was changed.`);
    let journal;
    try { journal = JSON.parse(fsImpl.readFileSync(journalFile, 'utf8')); } catch { throw new UpdateError(`${journalFile} is unreadable; nothing was changed.`); }
    if (journal.format !== FORMAT || journal.operation !== operation || journal.project !== project || !Array.isArray(journal.entries)) {
      throw new UpdateError(`${journalFile} does not belong to operation ${operation} in this project; nothing was changed.`);
    }
    for (const { skill, from, to } of journal.entries) {
      const live = path.join(project, ...journal.location.split('/'), skill);
      const old = path.join(stage, 'old', skill);
      const staged = path.join(stage, 'new', skill);
      const state = [classify(fsImpl, live, from, to), classify(fsImpl, old, from, to), classify(fsImpl, staged, from, to)].join(',');
      const label = `${skill} in ${journal.location}`;
      // live,old,new -> action
      const decision = {
        'to,from,absent': 'finish', 'to,absent,absent': 'done',
        'from,absent,to': 'discard', 'from,absent,absent': 'done',
        'absent,from,to': 'restore', 'absent,from,absent': 'restore',
      }[state];
      if (!decision) throw new UpdateError(`Cannot recover ${label} unambiguously (live, staged old, staged new: ${state}). Nothing was changed; resolve it manually.`);
      actions.push({ label, decision, live, old, staged, from, to });
    }
    stages.push({ base, stage, journalFile });
  }
  const results = [];
  for (const action of actions) {
    if (action.decision === 'restore') fsImpl.renameSync(action.old, action.live);
    if (action.decision === 'finish') removeVerified(fsImpl, action.old, action.from);
    if (['restore', 'discard'].includes(action.decision) && lstatOrNull(fsImpl, action.staged)) removeVerified(fsImpl, action.staged, action.to);
    results.push({ skill: action.label, result: action.decision === 'finish' || (action.decision === 'done' && classify(fsImpl, action.live, action.from, action.to) === 'to') ? 'updated' : 'previous version' });
  }
  for (const { base, stage, journalFile, leftovers } of stages) {
    if (leftovers) {
      for (const file of leftovers.files) fsImpl.unlinkSync(file);
      for (const dir of [...leftovers.dirs, stage]) if (!rmdirIfEmpty(fsImpl, dir) && lstatOrNull(fsImpl, dir)) throw new UpdateError(`${dir} still contains unexpected files; review it manually. ${LOCK_NAME} was kept.`);
      results.push({ skill: `staging in ${path.relative(project, base).split(path.sep).join('/')}`, result: 'removed; installed skills were not changed' });
    } else if (stage) {
      fsImpl.unlinkSync(journalFile);
      for (const dir of [path.join(stage, 'new'), path.join(stage, 'old'), stage]) if (!rmdirIfEmpty(fsImpl, dir) && lstatOrNull(fsImpl, dir)) throw new UpdateError(`${dir} still contains unexpected files; review it manually. ${LOCK_NAME} was kept.`);
    }
    rmdirIfEmpty(fsImpl, base);
  }
  releaseLock(fsImpl, project, operation);
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
    if (!updated.length) console.log('All selected Agent Kit skills are current; nothing was changed.');
    for (const name of plan.notInstalled) console.log(`Not installed, so not added: ${name}`);
    for (const note of plan.notes) console.log(`Note: ${note}`);
    return 0;
  } catch (error) {
    if (error instanceof UpdateError || error instanceof PlanError) { console.error(`Skill update refused: ${error.message}`); return 1; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
