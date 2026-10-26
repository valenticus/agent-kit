// Read-only planner for updating installed Agent Kit skills.
//   node skill-update.mjs plan --project <dir> [--skills a,b] [--json]
// It inventories .agents/skills and .cline/skills, identifies each installed kit skill against the skill catalog, and
// returns a plan of current, update, and conflict entries. It never writes, renames, or deletes anything: there is no
// executor yet. A skill counts as Agent Kit content only when its whole file set matches a released catalog version;
// a hash match proves the content is identical to that release, not that Agent Kit installed it.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectSkillsLink } from '../../adapters/claude/claude-bootstrap.mjs';
import { currentVersion, loadCatalog, normalizedHash } from './skill-catalog.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCATIONS = ['.agents/skills', '.cline/skills'];
// Written only by skill-apply.mjs; their presence means an update is running or was interrupted.
export const LOCK_NAME = '.agent-kit-update.lock';
export const STAGING_NAME = '.agent-kit-update';
// Operating-system metadata files are still extra files (never ignored), but conflicts name them.
const OS_METADATA = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export class PlanError extends Error {}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
function lstatOrNull(fsImpl, file) {
  try { return fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// Regular files with normalized hashes plus anything that is not a plain file or directory.
function inventory(fsImpl, dir) {
  const files = {};
  const problems = [];
  const walk = (current, prefix) => {
    for (const name of fsImpl.readdirSync(current, { withFileTypes: true }).map((entry) => entry.name).sort(byCodeUnit)) {
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fsImpl.lstatSync(absolute);
      if (stat.isSymbolicLink()) problems.push(`${relative} is a link or junction`);
      else if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) {
        try { files[relative] = normalizedHash(fsImpl.readFileSync(absolute)); } catch (error) { problems.push(`${relative} cannot be read (${error.code ?? error.message})`); }
      } else problems.push(`${relative} is a special file`);
    }
  };
  walk(dir, '');
  return { files, problems };
}

function compare(installed, expected) {
  const modified = [];
  const missing = [];
  for (const file of Object.keys(expected)) {
    if (!(file in installed)) missing.push(file);
    else if (installed[file] !== expected[file]) modified.push(file);
  }
  const extra = Object.keys(installed).filter((file) => !(file in expected));
  return { modified, extra, missing };
}

function identify(entry, installed) {
  const matched = entry.versions.find((version) => {
    const diff = compare(installed, version.files);
    return diff.modified.length + diff.extra.length + diff.missing.length === 0;
  });
  if (matched) return { matched };
  // Closest version: most identical files, newest on a tie.
  let closest = null;
  for (const version of entry.versions) {
    const same = Object.keys(version.files).filter((file) => installed[file] === version.files[file]).length;
    if (!closest || same >= closest.same) closest = { version, same };
  }
  return { closest: closest.version, diff: compare(installed, closest.version.files) };
}

function inspectSkill(fsImpl, dir, entry, target) {
  const stat = fsImpl.lstatSync(dir);
  if (stat.isSymbolicLink()) return { status: 'conflict', reasons: ['the skill directory is a link or junction'] };
  if (!stat.isDirectory()) return { status: 'conflict', reasons: ['the skill path is not a directory'] };
  const { files, problems } = inventory(fsImpl, dir);
  if (problems.length) return { status: 'conflict', reasons: problems };
  const { matched, closest, diff } = identify(entry, files);
  if (matched === target) return { status: 'current', installedReleases: matched.releases };
  if (matched) return { status: 'update', installedReleases: matched.releases };
  const reasons = [
    ...diff.modified.map((file) => `${file} differs from every released version`),
    ...diff.extra.map((file) => `${file} is not part of the skill${OS_METADATA.has(path.posix.basename(file)) ? ' (operating-system metadata; remove it if it is not needed)' : ''}`),
    ...diff.missing.map((file) => `${file} is missing`),
  ];
  return { status: 'conflict', closestReleases: closest.releases, files: diff, reasons };
}

export function planSkillUpdate(projectRoot, { kitRoot: root = kitRoot, skills, fsImpl = fs } = {}) {
  const catalog = loadCatalog(root);
  const version = currentVersion(root);
  const targets = new Map();
  for (const [name, entry] of Object.entries(catalog.skills)) {
    const target = entry.versions.find((candidate) => candidate.releases.includes(version));
    if (!target) throw new PlanError(`The skill catalog has no ${name} version for ${version}; regenerate it.`);
    targets.set(name, target);
  }
  let selected = null;
  if (skills !== undefined) {
    selected = [...new Set(skills)].sort(byCodeUnit);
    const unknown = selected.filter((name) => !targets.has(name));
    if (unknown.length) throw new PlanError(`Not Agent Kit skills: ${unknown.join(', ')}.`);
  }
  const wanted = (name) => targets.has(name) && (!selected || selected.includes(name));

  const resolved = path.resolve(projectRoot);
  const projectStat = lstatOrNull(fsImpl, resolved);
  if (!projectStat) throw new PlanError(`Project ${resolved} does not exist.`);
  const project = fsImpl.realpathSync(resolved);
  if (!fsImpl.statSync(project).isDirectory()) throw new PlanError(`Project ${resolved} is not a directory.`);

  const plan = { project, version, selected, roots: [], entries: [], unmanaged: [], notInstalled: [], notes: [], blockers: [], claudeLink: null };
  const present = new Map();
  for (const location of LOCATIONS) {
    const segments = location.split('/');
    const absolute = path.join(project, ...segments);
    let state = 'present';
    // Every component from the project to the skills root must be a real directory, never a link or junction.
    for (let depth = 1; depth <= segments.length; depth++) {
      const component = path.join(project, ...segments.slice(0, depth));
      const stat = lstatOrNull(fsImpl, component);
      if (!stat) { state = 'absent'; break; }
      if (stat.isSymbolicLink()) {
        let target = null;
        try { target = fsImpl.realpathSync(component); } catch { /* broken link */ }
        plan.blockers.push(`${segments.slice(0, depth).join('/')} is a link or junction${target && !inside(project, target) ? ' that leads outside the project' : ''}; updates never write through links.`);
        state = 'refused';
        break;
      }
      if (!stat.isDirectory()) { plan.blockers.push(`${segments.slice(0, depth).join('/')} is not a directory.`); state = 'refused'; break; }
    }
    if (state === 'present' && !inside(project, fsImpl.realpathSync(absolute))) { plan.blockers.push(`${location} resolves outside the project.`); state = 'refused'; }
    plan.roots.push({ location, state });
    if (state !== 'present') continue;
    const names = [];
    for (const item of fsImpl.readdirSync(absolute, { withFileTypes: true })) {
      if (!targets.has(item.name)) { plan.unmanaged.push({ location, name: item.name }); continue; }
      names.push(item.name);
      if (!wanted(item.name)) continue;
      const entry = catalog.skills[item.name];
      const target = targets.get(item.name);
      plan.entries.push({ skill: item.name, kind: entry.kind, location, targetReleases: target.releases, ...inspectSkill(fsImpl, path.join(absolute, item.name), entry, target) });
    }
    present.set(location, new Set(names));
  }

  if (lstatOrNull(fsImpl, path.join(project, LOCK_NAME))) {
    plan.blockers.push(`${LOCK_NAME} exists: a skill update is running or was interrupted. If none is running, run: node scripts/install/skill-apply.mjs recover --project <project>`);
  }
  for (const parent of ['.agents', '.cline']) {
    if (lstatOrNull(fsImpl, path.join(project, parent, STAGING_NAME))) plan.blockers.push(`${parent}/${STAGING_NAME} exists: leftovers of an earlier skill update; recover or review them first.`);
  }

  if (present.has('.agents/skills') && present.has('.cline/skills')) {
    const mirror = present.get('.cline/skills');
    for (const name of [...present.get('.agents/skills')].filter((skill) => wanted(skill) && !mirror.has(skill)).sort(byCodeUnit)) {
      plan.notes.push(`.cline/skills lacks ${name}; add it with install.ps1 -Tools cline -Skills ${name} (updates never add skills).`);
    }
  }
  if (selected) plan.notInstalled = selected.filter((name) => ![...present.values()].some((names) => names.has(name)));

  // Claude Code reads .agents/skills through the .claude/skills link; any other state would hide updates from it.
  const agentsRoot = plan.roots.find((root) => root.location === '.agents/skills');
  if (agentsRoot.state === 'present' || lstatOrNull(fsImpl, path.join(project, '.claude', 'skills'))) {
    const link = inspectSkillsLink(project, { fsImpl });
    plan.claudeLink = link.state;
    if (!['missing', 'correct'].includes(link.state)) plan.blockers.push(`.claude/skills is ${link.state === 'wrong' ? 'a link that does not resolve to .agents/skills' : `a real ${link.state}`}; Claude Code would not see updated skills.`);
  }

  plan.unmanaged.sort((a, b) => byCodeUnit(a.location, b.location) || byCodeUnit(a.name, b.name));
  plan.entries.sort((a, b) => byCodeUnit(a.skill, b.skill) || byCodeUnit(a.location, b.location));
  plan.summary = { current: 0, update: 0, conflict: 0 };
  for (const entry of plan.entries) plan.summary[entry.status]++;
  plan.canApply = plan.blockers.length === 0 && plan.summary.conflict === 0;
  return plan;
}

export function formatPlan(plan) {
  const range = (releases) => (releases.length === 1 ? releases[0] : `${releases[0]}..${releases.at(-1)}`);
  const lines = [`Agent Kit ${plan.version} skill update plan for ${plan.project} (read-only; nothing was written)`];
  for (const blocker of plan.blockers) lines.push(`  BLOCKED   ${blocker}`);
  for (const entry of plan.entries) {
    const head = `  ${entry.status.toUpperCase().padEnd(9)} ${entry.skill} in ${entry.location}`;
    if (entry.status === 'current') lines.push(`${head} (${range(entry.installedReleases)})`);
    else if (entry.status === 'update') lines.push(`${head}: ${range(entry.installedReleases)} -> ${plan.version}`);
    else lines.push(`${head}${entry.closestReleases ? ` (closest release ${range(entry.closestReleases)})` : ''}`, ...entry.reasons.map((reason) => `            - ${reason}`));
  }
  for (const item of plan.unmanaged) lines.push(`  SKIPPED   ${item.name} in ${item.location}: not an Agent Kit skill, left untouched`);
  for (const name of plan.notInstalled) lines.push(`  ABSENT    ${name}: not installed; updates never add skills`);
  for (const note of plan.notes) lines.push(`  NOTE      ${note}`);
  if (plan.claudeLink === 'correct') lines.push('  NOTE      .claude/skills links to .agents/skills, so Claude Code sees the same copies.');
  lines.push(`Current ${plan.summary.current}, update ${plan.summary.update}, conflict ${plan.summary.conflict}${plan.blockers.length ? `, blocked ${plan.blockers.length}` : ''}.`);
  lines.push(plan.canApply ? 'No conflicts.' : 'Conflicts or blockers must be resolved, or the selection narrowed, before any update.');
  return lines.join('\n');
}

function main(argv) {
  const [command] = argv;
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const project = option('--project');
  const skillList = option('--skills');
  if (command !== 'plan' || !project || (argv.includes('--skills') && !skillList)) {
    console.error('usage: skill-update.mjs plan --project <dir> [--skills a,b] [--json]');
    return 2;
  }
  try {
    const plan = planSkillUpdate(project, { skills: skillList === undefined ? undefined : skillList.split(',').map((name) => name.trim()).filter(Boolean) });
    console.log(argv.includes('--json') ? JSON.stringify(plan, null, 2) : formatPlan(plan));
    return plan.canApply ? 0 : 1;
  } catch (error) {
    if (error instanceof PlanError) { console.error(`Skill update plan refused: ${error.message}`); return 2; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
