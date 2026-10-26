// Skill catalog and read-only update-planner checks. Run from validate-installer.mjs before PowerShell is required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureSkillsLink } from '../../adapters/claude/claude-bootstrap.mjs';
import { buildCatalog, catalogErrors, distributedSkills, isSafeRelativePath, loadCatalog, normalizedHash, serializeCatalog } from '../install/skill-catalog.mjs';
import { PlanError, formatPlan, planSkillUpdate } from '../install/skill-update.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUTATING = ['appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'cpSync', 'futimesSync', 'linkSync', 'lutimesSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'renameSync', 'rmSync', 'rmdirSync', 'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync'];
// Any write attempted through this fs fails the check.
const readOnlyFs = { ...fs, ...Object.fromEntries(MUTATING.map((name) => [name, () => { throw new Error(`planner attempted fs.${name}`); }])) };

export async function testSkillCatalogAndPlanner() {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-skill-update-')));
  let counter = 0;
  let checks = 0;
  const skipped = [];
  const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
  const fresh = (prefix) => { const dir = path.join(workspace, `${prefix}${counter++}`); fs.mkdirSync(dir); return dir; };
  const hashes = (files) => Object.fromEntries(Object.entries(files).map(([file, text]) => [file, normalizedHash(Buffer.from(text))]));
  const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const writeSkill = (project, location, name, files, eol = '\n') => { for (const [file, text] of Object.entries(files)) write(project, `${location}/${name}/${file}`, text.replace(/\n/g, eol)); };
  const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
  // Paths, kinds, sizes, modification times, contents, and link targets; any change between two snapshots is a write.
  const snapshot = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const stat = fs.lstatSync(file);
        const id = `${path.relative(dir, file)}|${stat.mtimeMs}|${stat.size}`;
        if (stat.isSymbolicLink()) out.push(`${id}|link:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) { out.push(`${id}|dir`); walk(file); }
        else out.push(`${id}|${normalizedHash(fs.readFileSync(file))}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };

  const ALPHA_V1 = { 'SKILL.md': 'alpha v1\n' };
  const ALPHA_V2 = { 'references/a.md': 'reference\n', 'SKILL.md': 'alpha v2\n' };
  const BETA = { 'SKILL.md': 'beta\n' };
  const snapshots = [
    { release: '2.0.0', skills: { beta: { kind: 'core', files: hashes(BETA) }, alpha: { kind: 'core', files: hashes(ALPHA_V2) } } },
    { release: '1.0.0', skills: { alpha: { kind: 'core', files: hashes(ALPHA_V1) }, beta: { kind: 'core', files: hashes(BETA) } } },
  ];
  const kit = fresh('kit');
  write(kit, 'VERSION', '2.0.0\n');
  write(kit, 'scripts/install/skill-catalog.json', serializeCatalog(buildCatalog(snapshots)));
  // Every plan goes through the read-only fs and must leave the project byte- and timestamp-identical.
  const plan = (project, options = {}) => {
    const before = snapshot(project);
    const result = planSkillUpdate(project, { kitRoot: kit, fsImpl: readOnlyFs, ...options });
    assert.equal(snapshot(project), before, 'the planner changed the project');
    return result;
  };
  const entry = (result, skill, location) => result.entries.find((item) => item.skill === skill && item.location === location);

  try {
    check('catalog: deterministic build, merged identical content, canonical order', () => {
      const catalog = buildCatalog(snapshots);
      assert.equal(serializeCatalog(catalog), serializeCatalog(buildCatalog([...snapshots].reverse())));
      assert.deepEqual(catalog.releases, ['1.0.0', '2.0.0']);
      assert.deepEqual(Object.keys(catalog.skills), ['alpha', 'beta']);
      assert.deepEqual(catalog.skills.alpha.versions.map((version) => version.releases), [['1.0.0'], ['2.0.0']]);
      assert.deepEqual(catalog.skills.beta.versions.map((version) => version.releases), [['1.0.0', '2.0.0']]);
      assert.deepEqual(Object.keys(catalog.skills.alpha.versions[1].files), ['SKILL.md', 'references/a.md']);
      assert.throws(() => buildCatalog([...snapshots, { release: '3.0.0', skills: { beta: { kind: 'vendored', files: {} } } }]), /changes kind/);
      assert.throws(() => buildCatalog([snapshots[0], snapshots[0]]), /more than one snapshot/);
    });
    check('catalog: content hashes ignore CRLF versus LF only', () => {
      assert.equal(normalizedHash(Buffer.from('a\r\nb\r\n')), normalizedHash(Buffer.from('a\nb\n')));
      assert.notEqual(normalizedHash(Buffer.from('a\rb')), normalizedHash(Buffer.from('a\nb')));
      assert.notEqual(normalizedHash(Buffer.from('a \n')), normalizedHash(Buffer.from('a\n')));
    });
    check('catalog: safe relative paths', () => {
      for (const good of ['SKILL.md', 'references/a.md', '.hidden', 'a b/c.md']) assert.ok(isSafeRelativePath(good), good);
      for (const bad of ['', '/abs', '../x', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:x', 'a\0b', 'a/', 1]) assert.ok(!isSafeRelativePath(bad), JSON.stringify(bad));
    });
    check('catalog: the committed catalog covers this checkout', () => {
      assert.deepEqual(catalogErrors(loadCatalog(root), root), []);
      assert.deepEqual(Object.keys(loadCatalog(root).skills).sort(), [...distributedSkills(root).keys()].sort());
    });
    check('catalog: malformed, unsafe, ambiguous, unknown, or stale catalogs are reported', () => {
      const base = loadCatalog(root);
      const version = base.releases.at(-1);
      const current = (catalog, name) => catalog.skills[name].versions.find((item) => item.releases.includes(version));
      const firstFile = (catalog, name) => Object.keys(current(catalog, name).files)[0];
      const cases = [
        [/lowercase SHA-256/, (c) => { current(c, 'safe-change').files['SKILL.md'] = 'XYZ'; }],
        [/unsafe path/, (c) => { c.skills['safe-change'].versions[0].files = { '../escape.md': '0'.repeat(64) }; }],
        [/not a skill this kit distributes/, (c) => { c.skills.zzz = structuredClone(c.skills.ui); }],
        [/missing from the catalog/, (c) => { delete c.skills.ui; }],
        [/identical content/, (c) => { c.skills.debugging.versions[1].files = structuredClone(c.skills.debugging.versions[0].files); }],
        [/ambiguous/, (c) => { c.skills.ui.versions[1].releases = ['1.0.0', ...c.skills.ui.versions[1].releases]; }],
        [/no version lists the current VERSION/, (c) => { current(c, 'handoff').releases = current(c, 'handoff').releases.filter((item) => item !== version); }],
        [/kind must be/, (c) => { c.skills.handoff.kind = 'vendored'; }],
        [/working tree differs/, (c) => { current(c, 'handoff').files[firstFile(c, 'handoff')] = '0'.repeat(64); }],
        [/sorted by name/, (c) => { const { ui, ...rest } = c.skills; c.skills = { ui, ...rest }; }],
        [/must end with the current VERSION/, (c) => { c.releases = c.releases.slice(0, -1); }],
        [/strictly increasing/, (c) => { c.releases = [...c.releases].reverse(); }],
        [/format must be/, (c) => { c.format = 2; }],
      ];
      for (const [pattern, mutate] of cases) {
        const catalog = structuredClone(base);
        mutate(catalog);
        const errors = catalogErrors(catalog, root);
        assert.ok(errors.some((error) => pattern.test(error)), `${pattern} not reported: ${errors.join('; ')}`);
      }
    });

    check('plan: current versions are current; the plan is complete and applicable', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2);
      writeSkill(project, '.agents/skills', 'beta', BETA);
      const result = plan(project);
      assert.deepEqual(result.entries.map((item) => `${item.skill}:${item.status}`), ['alpha:current', 'beta:current']);
      assert.deepEqual(entry(result, 'alpha', '.agents/skills').installedReleases, ['2.0.0']);
      assert.ok(result.canApply);
      assert.deepEqual(result.roots, [{ location: '.agents/skills', state: 'present' }, { location: '.cline/skills', state: 'absent' }]);
    });
    check('plan: an older released version is an update', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const item = entry(plan(project), 'alpha', '.agents/skills');
      assert.equal(item.status, 'update');
      assert.deepEqual([item.installedReleases, item.targetReleases], [['1.0.0'], ['2.0.0']]);
    });
    check('plan: a modified file is a conflict naming the file and closest release', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', { ...ALPHA_V2, 'SKILL.md': 'alpha v2 with my edits\n' });
      const result = plan(project);
      const item = entry(result, 'alpha', '.agents/skills');
      assert.equal(item.status, 'conflict');
      assert.deepEqual(item.files, { modified: ['SKILL.md'], extra: [], missing: [] });
      assert.deepEqual(item.closestReleases, ['2.0.0']);
      assert.ok(!result.canApply);
      assert.match(formatPlan(result), /CONFLICT  alpha in \.agents\/skills \(closest release 2\.0\.0\)\n\s+- SKILL\.md differs from every released version/);
    });
    check('plan: extra and missing files are conflicts; operating-system metadata is named', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', { 'SKILL.md': ALPHA_V2['SKILL.md'], 'notes.md': 'mine\n', '.DS_Store': 'x' });
      const item = entry(plan(project), 'alpha', '.agents/skills');
      assert.deepEqual(item.files, { modified: [], extra: ['.DS_Store', 'notes.md'], missing: ['references/a.md'] });
      assert.ok(item.reasons.some((reason) => /\.DS_Store .*operating-system metadata/.test(reason)));
    });
    check('plan: CRLF copies of released versions are recognized', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2, '\r\n');
      writeSkill(project, '.cline/skills', 'alpha', ALPHA_V1, '\r\n');
      const result = plan(project);
      assert.equal(entry(result, 'alpha', '.agents/skills').status, 'current');
      assert.equal(entry(result, 'alpha', '.cline/skills').status, 'update');
    });
    check('plan: third-party skills and files are skipped, never inspected or owned', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'beta', BETA);
      writeSkill(project, '.agents/skills', 'my-skill', { 'SKILL.md': 'mine\n' });
      write(project, '.agents/skills/README.md', 'notes\n');
      const result = plan(project);
      assert.deepEqual(result.unmanaged, [{ location: '.agents/skills', name: 'README.md' }, { location: '.agents/skills', name: 'my-skill' }]);
      assert.deepEqual(result.entries.map((item) => item.skill), ['beta']);
      assert.ok(result.canApply);
    });
    check('plan: selected skills that are not installed are reported and never added', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2);
      const result = plan(project, { skills: ['beta', 'alpha', 'beta'] });
      assert.deepEqual(result.selected, ['alpha', 'beta']);
      assert.deepEqual(result.notInstalled, ['beta']);
      assert.deepEqual(result.entries.map((item) => item.skill), ['alpha']);
      assert.deepEqual(plan(fresh('p')).entries, []);
    });
    check('plan: shared and Cline copies are identified independently', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2);
      writeSkill(project, '.cline/skills', 'alpha', ALPHA_V1);
      const result = plan(project);
      assert.deepEqual(result.entries.map((item) => `${item.location}:${item.status}`), ['.agents/skills:current', '.cline/skills:update']);
      assert.ok(result.canApply);
    });
    check('plan: a damaged Cline mirror is a conflict, and a missing mirror skill is a note', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2);
      writeSkill(project, '.agents/skills', 'beta', BETA);
      writeSkill(project, '.cline/skills', 'alpha', { ...ALPHA_V2, 'SKILL.md': 'edited mirror\n' });
      const result = plan(project);
      assert.equal(entry(result, 'alpha', '.agents/skills').status, 'current');
      assert.equal(entry(result, 'alpha', '.cline/skills').status, 'conflict');
      assert.deepEqual(result.notes, ['.cline/skills lacks beta; add it with install.ps1 -Tools cline -Skills beta (updates never add skills).']);
    });
    check('plan: linked skill directories and links inside skills are conflicts', () => {
      const project = fresh('p');
      const elsewhere = fresh('outside');
      writeSkill(elsewhere, '.', 'alpha', ALPHA_V2);
      link(path.join(elsewhere, 'alpha'), path.join(project, '.agents', 'skills', 'alpha'));
      writeSkill(project, '.agents/skills', 'beta', BETA);
      link(path.join(elsewhere, 'alpha'), path.join(project, '.agents', 'skills', 'beta', 'linked'));
      const result = plan(project);
      assert.deepEqual(entry(result, 'alpha', '.agents/skills').reasons, ['the skill directory is a link or junction']);
      assert.deepEqual(entry(result, 'beta', '.agents/skills').reasons, ['linked is a link or junction']);
      const fileLinkProject = fresh('p');
      writeSkill(fileLinkProject, '.agents/skills', 'beta', BETA);
      try { fs.symlinkSync(path.join(elsewhere, 'alpha', 'SKILL.md'), path.join(fileLinkProject, '.agents', 'skills', 'beta', 'extra.md'), 'file'); } catch (error) {
        if (process.platform !== 'win32') throw error;
        skipped.push('file symbolic link inside a skill (needs symlink privilege on Windows)');
        return;
      }
      assert.deepEqual(entry(plan(fileLinkProject), 'beta', '.agents/skills').reasons, ['extra.md is a link or junction']);
    });
    check('plan: skills roots reached through links, or leading outside the project, are blocked', () => {
      const viaLink = fresh('p');
      writeSkill(viaLink, '.agents/skills', 'alpha', ALPHA_V2);
      link(path.join(viaLink, '.agents', 'skills'), path.join(viaLink, '.cline', 'skills'));
      const inner = plan(viaLink);
      assert.deepEqual(inner.blockers, ['.cline/skills is a link or junction; updates never write through links.']);
      assert.deepEqual(inner.entries.map((item) => item.location), ['.agents/skills']);
      assert.ok(!inner.canApply);
      const escape = fresh('p');
      const outside = fresh('outside');
      writeSkill(outside, 'skills', 'alpha', ALPHA_V2);
      link(outside, path.join(escape, '.agents'));
      const outer = plan(escape);
      assert.deepEqual(outer.blockers, ['.agents is a link or junction that leads outside the project; updates never write through links.']);
      assert.deepEqual(outer.entries, []);
    });
    check('plan: .claude/skills is checked without being changed', () => {
      const linked = fresh('p');
      writeSkill(linked, '.agents/skills', 'alpha', ALPHA_V2);
      ensureSkillsLink(linked);
      const ok = plan(linked);
      assert.equal(ok.claudeLink, 'correct');
      assert.deepEqual(ok.blockers, []);
      assert.match(formatPlan(ok), /Claude Code sees the same copies/);
      const copied = fresh('p');
      writeSkill(copied, '.agents/skills', 'alpha', ALPHA_V2);
      writeSkill(copied, '.claude/skills', 'alpha', ALPHA_V2);
      const blocked = plan(copied);
      assert.equal(blocked.claudeLink, 'directory');
      assert.match(blocked.blockers.join('\n'), /\.claude\/skills is a real directory; Claude Code would not see updated skills/);
      const none = fresh('p');
      writeSkill(none, '.agents/skills', 'alpha', ALPHA_V2);
      assert.equal(plan(none).claudeLink, 'missing');
    });
    check('plan: narrowing the selection excludes other skills, including their conflicts', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', { 'SKILL.md': 'edited\n' });
      writeSkill(project, '.agents/skills', 'beta', BETA);
      assert.ok(!plan(project).canApply);
      const narrowed = plan(project, { skills: ['beta'] });
      assert.deepEqual(narrowed.entries.map((item) => item.skill), ['beta']);
      assert.ok(narrowed.canApply);
      assert.throws(() => plan(project, { skills: ['nope'] }), (error) => error instanceof PlanError && /Not Agent Kit skills: nope/.test(error.message));
    });
    check('plan: repeated plans are identical', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.cline/skills', 'alpha', { 'SKILL.md': 'edited\n' });
      writeSkill(project, '.agents/skills', 'other', { 'SKILL.md': 'x\n' });
      const first = plan(project);
      assert.deepEqual(plan(project), first);
      assert.equal(formatPlan(plan(project)), formatPlan(first));
    });
    check('plan: a missing project is refused', () => {
      assert.throws(() => planSkillUpdate(path.join(workspace, 'missing'), { kitRoot: kit, fsImpl: readOnlyFs }), PlanError);
    });
    check('plan with the real kit: freshly copied and CRLF-converted skills are current; CLI exit codes', () => {
      const project = fresh('p');
      const copy = (from, to, crlf) => {
        for (const item of fs.readdirSync(from, { withFileTypes: true })) {
          if (item.isDirectory()) copy(path.join(from, item.name), path.join(to, item.name), crlf);
          else write(to, item.name, crlf ? fs.readFileSync(path.join(from, item.name), 'utf8').replace(/\r?\n/g, '\r\n') : fs.readFileSync(path.join(from, item.name), 'utf8'));
        }
      };
      for (const [name, { dir }] of distributedSkills(root)) copy(dir, path.join(project, '.agents', 'skills', name), false);
      copy(distributedSkills(root).get('handoff').dir, path.join(project, '.cline', 'skills', 'handoff'), true);
      const before = snapshot(project);
      const result = planSkillUpdate(project, { fsImpl: readOnlyFs });
      assert.equal(result.summary.current, distributedSkills(root).size + 1);
      assert.equal(result.summary.update + result.summary.conflict, 0);
      const cli = path.join(root, 'scripts', 'install', 'skill-update.mjs');
      const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      const all = run('plan', '--project', project);
      assert.equal(all.status, 0, all.stderr);
      assert.match(all.stdout, /NOTE      \.cline\/skills lacks debugging/);
      assert.equal(snapshot(project), before, 'the CLI changed the project');
      write(project, '.agents/skills/debugging/SKILL.md', 'edited\n');
      const conflict = run('plan', '--project', project, '--skills', 'debugging');
      assert.equal(conflict.status, 1);
      assert.match(conflict.stdout, /CONFLICT  debugging in \.agents\/skills/);
      assert.equal(run('plan', '--project', project, '--skills', 'handoff').status, 0);
      assert.equal(run('plan', '--project', project, '--skills', 'nope').status, 2);
      assert.equal(run('plan').status, 2);
      assert.equal(JSON.parse(run('plan', '--project', project, '--skills', 'handoff', '--json').stdout).summary.current, 2);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`Validated ${checks} skill catalog and read-only update-planner checks (deterministic catalog, CRLF identity, safe paths, catalog consistency, current/update/conflict, extra/missing files, third-party skills, absent skills, independent Cline copies, links and junctions, roots outside the project, Claude link state, narrowing, repeatable plans, zero writes, CLI exit codes).${skipped.length ? ` Not exercised on this host: ${skipped.join('; ')}.` : ''}`);
}
