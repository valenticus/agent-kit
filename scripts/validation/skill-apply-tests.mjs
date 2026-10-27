// Skill update executor and recovery checks. Run from validate-installer.mjs before PowerShell is required.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_NAME, STAGING_NAME, UpdateError, applySkillUpdate, recoverSkillUpdate } from '../install/skill-apply.mjs';
import { buildCatalog, normalizedHash, serializeCatalog } from '../install/skill-catalog.mjs';
import { planSkillUpdate } from '../install/skill-update.mjs';

const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install');

export async function testSkillApply() {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-skill-apply-')));
  let counter = 0;
  let checks = 0;
  const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
  const fresh = (prefix) => { const dir = path.join(workspace, `${prefix}${counter++}`); fs.mkdirSync(dir); return dir; };
  const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const writeSkill = (project, location, name, files) => { for (const [file, text] of Object.entries(files)) write(project, `${location}/${name}/${file}`, text); };
  const hashes = (files) => Object.fromEntries(Object.entries(files).map(([file, text]) => [file, normalizedHash(Buffer.from(text))]));
  const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
  // File contents keyed by relative path; directories as trailing '/'. Throws on links so they are never followed.
  const contents = (dir) => {
    const out = {};
    const walk = (current, prefix) => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const stat = fs.lstatSync(file);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (stat.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(file)}`;
        else if (stat.isDirectory()) { out[`${rel}/`] = ''; walk(file, rel); }
        else out[rel] = `${fs.readFileSync(file, 'utf8')}|${stat.mtimeMs}`;
      }
    };
    if (fs.existsSync(dir)) walk(dir, '');
    return out;
  };
  const text = (dir) => Object.fromEntries(Object.entries(contents(dir)).filter(([rel]) => !rel.endsWith('/')).map(([rel, value]) => [rel, value.replace(/\|[^|]*$/, '')]));
  const noLeftovers = (project) => {
    for (const rel of [LOCK_NAME, `.agents/${STAGING_NAME}`, `.cline/${STAGING_NAME}`]) assert.ok(!fs.existsSync(path.join(project, rel)), `${rel} was left behind`);
  };
  const refuses = (fn, pattern) => assert.throws(fn, (error) => error instanceof UpdateError && pattern.test(error.message), `expected ${pattern}`);

  const ALPHA_V1 = { 'SKILL.md': 'alpha v1\n', 'notes/old.md': 'old notes\n' };
  const ALPHA_V2 = { 'SKILL.md': 'alpha v2\n', 'references/a.md': 'reference\n' };
  const BETA_V1 = { 'SKILL.md': 'beta v1\n' };
  const BETA_V2 = { 'SKILL.md': 'beta v2\n' };
  const catalogFor = (alpha = [ALPHA_V1, ALPHA_V2]) => serializeCatalog(buildCatalog([
    { release: '1.0.0', skills: { alpha: { kind: 'core', files: hashes(alpha[0]) }, beta: { kind: 'core', files: hashes(BETA_V1) } } },
    { release: '2.0.0', skills: { alpha: { kind: 'core', files: hashes(alpha[1]) }, beta: { kind: 'core', files: hashes(BETA_V2) } } },
  ]));
  const makeKit = () => {
    const kit = fresh('kit');
    write(kit, 'VERSION', '2.0.0\n');
    write(kit, 'optional/catalog.json', '{}\n');
    writeSkill(kit, 'core/skills', 'alpha', ALPHA_V2);
    writeSkill(kit, 'core/skills', 'beta', BETA_V2);
    write(kit, 'scripts/install/skill-catalog.json', catalogFor());
    return kit;
  };
  const kit = makeKit();
  const plan = (project, options = {}) => planSkillUpdate(project, { kitRoot: kit, ...options });
  // Short retry pauses keep the tests fast; production uses RETRY_DELAYS_MS.
  const FAST = [1, 1, 1];
  const apply = (project, options = {}) => applySkillUpdate(plan(project, options.plan), { kitRoot: kit, retryDelaysMs: FAST, ...options });
  const recover = (project, options = {}) => recoverSkillUpdate(project, { kitRoot: kit, retryDelaysMs: FAST, ...options });
  // An fs whose renameSync persistently fails (EPERM, as Windows reports for open handles) for matching renames.
  const failingRenames = (rule, code = 'EPERM') => ({ ...fs, renameSync: (from, to) => { if (rule(from, to)) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}'`), { code }); return fs.renameSync(from, to); } });
  const LIVE = (from) => from.includes(`${path.sep}skills${path.sep}`); // live -> staging/old
  const STAGED = (from) => from.includes(`${path.sep}new${path.sep}`); // staging/new -> live
  const ROLLBACK = (from) => from.includes(`${path.sep}old${path.sep}`); // staging/old -> live
  // Runs an update in a child process that exits abruptly after the given fs call, like a crash or power loss.
  // Modes: 'before-rename' (just before the first rename), 'rename' (after N renames), 'open' (after opening the Nth staged file), 'unlink-old' (after deleting N
  // files of the previous copy), 'journal' (in the middle of writing the first journal).
  const crashScript = (mode, after, body) => `
      import fs from 'node:fs';
      import { planSkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-update.mjs')).href)};
      import { applySkillUpdate, recoverSkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-apply.mjs')).href)};
      const mode = ${JSON.stringify(mode)};
      let renames = 0, opens = 0, unlinks = 0;
      const fsImpl = { ...fs,
        renameSync: (...args) => { if (mode === 'before-rename') process.exit(9); fs.renameSync(...args); if (mode === 'rename' && ++renames === ${after}) process.exit(9); },
        openSync: (...args) => { const fd = fs.openSync(...args); if (mode === 'open' && String(args[0]).includes(${JSON.stringify(`${path.sep}new${path.sep}`)}) && ++opens === ${after}) process.exit(9); return fd; },
        unlinkSync: (file) => { fs.unlinkSync(file); for (const [m, part] of [['unlink-old', 'old'], ['unlink-new', 'new']]) if (mode === m && String(file).includes(${JSON.stringify(path.sep)} + part + ${JSON.stringify(path.sep)}) && ++unlinks === ${after}) process.exit(9); },
        writeFileSync: (target, data, ...rest) => { if (mode === 'journal' && typeof target === 'number' && String(data).includes('"location"') && !String(data).includes('"pid"')) { fs.writeFileSync(target, String(data).slice(0, ${after})); process.exit(9); } return fs.writeFileSync(target, data, ...rest); } };
      ${body}`;
  const crash = (project, mode, after, kitRoot = kit) => {
    const script = crashScript(mode, after, `const kitRoot = ${JSON.stringify(kitRoot)};
      applySkillUpdate(planSkillUpdate(${JSON.stringify(project)}, { kitRoot }), { kitRoot, fsImpl });`);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 9, `child did not crash as planned: ${result.stderr}`);
  };
  // Runs recovery in a child process that crashes the same way.
  const crashRecovery = (project, mode, after) => {
    const script = crashScript(mode, after, `recoverSkillUpdate(${JSON.stringify(project)}, { kitRoot: ${JSON.stringify(kit)}, fsImpl });`);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 9, `recovery did not crash as planned: ${result.stderr}`);
  };
  const stagingOf = (project, parent = '.agents') => {
    const base = path.join(project, parent, STAGING_NAME);
    const [operation] = fs.readdirSync(base);
    return { operation, stage: path.join(base, operation) };
  };

  try {
    check('apply: an older version is updated; current, third-party, and unrelated files are untouched', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V2);
      writeSkill(project, '.agents/skills', 'my-skill', { 'SKILL.md': 'mine\n' });
      write(project, 'README.md', 'project\n');
      const untouched = { beta: contents(path.join(project, '.agents/skills/beta')), mine: contents(path.join(project, '.agents/skills/my-skill')), readme: contents(project)['README.md'] };
      const result = apply(project);
      assert.deepEqual(result.updated, [{ skill: 'alpha', location: '.agents/skills', from: ['1.0.0'], to: ['2.0.0'] }]);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.deepEqual(contents(path.join(project, '.agents/skills/beta')), untouched.beta);
      assert.deepEqual(contents(path.join(project, '.agents/skills/my-skill')), untouched.mine);
      assert.equal(contents(project)['README.md'], untouched.readme);
      noLeftovers(project);
      assert.equal(plan(project).summary.update, 0);
    });
    check('apply and recover: link checks of the source and target are the last calls before every rename', () => {
      // Every fs call in order, with its string arguments.
      const logging = (calls, base = fs) => Object.fromEntries(Object.keys(base).map((key) => [key, typeof base[key] !== 'function' ? base[key]
        : (...args) => { calls.push([key, ...args.filter((arg) => typeof arg === 'string')]); return base[key](...args); }]));
      // The calls right before each rename must be lstat only and cover every component of the source, of the target's
      // parent, and the target itself: no content read may sit between the link checks and the rename.
      const checkedBeforeRenames = (calls, project) => {
        const chain = (target) => { const out = []; for (let current = target; current !== project; current = path.dirname(current)) out.push(current); return out; };
        const renames = calls.flatMap((call, index) => (call[0] === 'renameSync' ? [index] : []));
        for (const index of renames) {
          const [, from, to] = calls[index];
          let start = index;
          while (start > 0 && calls[start - 1][0] === 'lstatSync') start--;
          const checked = new Set(calls.slice(start, index).map((call) => call[1]));
          for (const component of [...chain(from), ...chain(path.dirname(to)), to]) assert.ok(checked.has(component), `${component} was not checked immediately before renaming ${from}`);
        }
        return renames.length;
      };
      const project = fresh('order');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.cline/skills', 'beta', BETA_V1);
      const calls = [];
      apply(project, { fsImpl: logging(calls) });
      assert.equal(checkedBeforeRenames(calls, project), 4);
      // A swap whose rollback also fails (with retries) leaves a restore for recovery; each attempt is checked the same way.
      const stuck = fresh('order');
      writeSkill(stuck, '.agents/skills', 'alpha', ALPHA_V1);
      calls.length = 0;
      refuses(() => apply(stuck, { fsImpl: logging(calls, failingRenames((from) => STAGED(from) || ROLLBACK(from))) }), /Could not finish or undo/);
      assert.ok(checkedBeforeRenames(calls, stuck) > 3, 'retried renames were logged');
      calls.length = 0;
      recover(stuck, { fsImpl: logging(calls) });
      assert.equal(checkedBeforeRenames(calls, stuck), 1);
      assert.deepEqual(text(path.join(stuck, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(stuck);
    });
    check('apply: a skill that disappears while replanning (another update moved it) is an out-of-date plan', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const planned = plan(project);
      const before = contents(project);
      const live = path.join(project, '.agents', 'skills', 'alpha');
      const vanishing = { ...fs, lstatSync: (file, ...rest) => { if (file === live) throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${file}'`), { code: 'ENOENT' }); return fs.lstatSync(file, ...rest); } };
      refuses(() => applySkillUpdate(planned, { kitRoot: kit, fsImpl: vanishing, retryDelaysMs: FAST }), /^The plan is out of date/);
      assert.deepEqual(contents(project), before);
      noLeftovers(project);
    });
    check('apply: a second run is a no-op that writes nothing', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      apply(project);
      const before = contents(project);
      assert.deepEqual(apply(project), { operation: null, updated: [] });
      assert.deepEqual(contents(project), before);
    });
    check('apply: several skills in one plan', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      assert.deepEqual(apply(project).updated.map((item) => item.skill), ['alpha', 'beta']);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V2);
      noLeftovers(project);
    });
    check('apply: the Cline mirror is updated on its own; the current shared copy is untouched', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V2);
      writeSkill(project, '.cline/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.cline/skills', 'beta', BETA_V1);
      const shared = contents(path.join(project, '.agents'));
      assert.deepEqual(apply(project).updated.map((item) => `${item.skill}@${item.location}`), ['alpha@.cline/skills', 'beta@.cline/skills']);
      assert.deepEqual(text(path.join(project, '.cline/skills/alpha')), ALPHA_V2);
      assert.deepEqual(text(path.join(project, '.cline/skills/beta')), BETA_V2);
      assert.deepEqual(contents(path.join(project, '.agents')), shared);
      noLeftovers(project);
    });
    check('apply: a skill edited after planning is refused and kept, with nothing changed', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const stale = plan(project);
      write(project, '.agents/skills/alpha/SKILL.md', 'my edit\n');
      const before = contents(project);
      refuses(() => applySkillUpdate(stale, { kitRoot: kit }), /out of date/);
      assert.deepEqual(contents(project), before);
      noLeftovers(project);
    });
    check('apply: a skill edited after staging is not replaced; staging is removed', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      refuses(() => apply(project, { onStep: (step) => { if (step === 'before-swap') write(project, '.agents/skills/alpha/SKILL.md', 'late edit\n'); } }), /changed after planning; it was not replaced/);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), { ...ALPHA_V1, 'SKILL.md': 'late edit\n' });
      noLeftovers(project);
    });
    check('apply: a changed kit source or catalog is refused with nothing changed', () => {
      const ownKit = makeKit();
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const before = contents(project);
      const planned = planSkillUpdate(project, { kitRoot: ownKit });
      write(ownKit, 'core/skills/alpha/SKILL.md', 'tampered\n');
      refuses(() => applySkillUpdate(planned, { kitRoot: ownKit }), /kit source for alpha differs from the catalog/);
      writeSkill(ownKit, 'core/skills', 'alpha', ALPHA_V2);
      write(ownKit, 'scripts/install/skill-catalog.json', catalogFor([{ 'SKILL.md': 'other v1\n' }, ALPHA_V2]));
      refuses(() => applySkillUpdate(planned, { kitRoot: ownKit }), /out of date/);
      assert.deepEqual(contents(project), before);
      noLeftovers(project);
    });
    check('apply: invalid or conflicting plans are refused', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', { 'SKILL.md': 'edited\n' });
      const before = contents(project);
      refuses(() => applySkillUpdate(plan(project), { kitRoot: kit }), /conflicts or blockers/);
      refuses(() => applySkillUpdate(null, { kitRoot: kit }), /Not a skill update plan/);
      refuses(() => applySkillUpdate({ ...plan(project), canApply: true }, { kitRoot: kit }), /out of date/);
      assert.deepEqual(contents(project), before);
    });
    check('apply: a copy failure removes everything this run created', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const before = contents(path.join(project, '.agents/skills'));
      let writes = 0;
      const fsImpl = { ...fs, writeFileSync: (...args) => { if (typeof args[0] === 'number' && ++writes === 3) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fs.writeFileSync(...args); } };
      refuses(() => apply(project, { fsImpl }), /stopped \(ENOSPC\)/);
      assert.deepEqual(contents(path.join(project, '.agents/skills')), before);
      noLeftovers(project);
    });
    check('apply: a failed first rename (EPERM) leaves the skill in place', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const before = contents(path.join(project, '.agents/skills'));
      refuses(() => apply(project, { fsImpl: failingRenames(LIVE) }), /stopped \(EPERM\)/);
      assert.deepEqual(contents(path.join(project, '.agents/skills')), before);
      noLeftovers(project);
    });
    check('apply: a failed second rename (EPERM) is rolled back to the previous version', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      assert.throws(() => apply(project, { fsImpl: failingRenames(STAGED) }), (error) => error instanceof UpdateError && /stopped \(EPERM\)/.test(error.message) && !error.recoveryRequired);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V1);
      noLeftovers(project);
    });
    check('apply: earlier skills stay updated when a later one fails; the report says so', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      assert.throws(() => apply(project, { fsImpl: failingRenames((from) => from.endsWith(`${path.sep}skills${path.sep}beta`)) }), (error) => /already updated: alpha in \.agents\/skills/.test(error.message) && error.updated.length === 1);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V1);
      noLeftovers(project);
    });
    check('apply: an impossible rollback keeps the previous version for recovery; recover restores it', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let error;
      try { apply(project, { fsImpl: failingRenames((from) => STAGED(from) || ROLLBACK(from)) }); } catch (caught) { error = caught; }
      assert.ok(error?.recoveryRequired, 'recovery must be required');
      assert.match(error.message, /previous version is kept at \.agents\/\.agent-kit-update\/[0-9a-f-]+\/old\/alpha/);
      assert.ok(!fs.existsSync(path.join(project, '.agents/skills/alpha')));
      const { operation, stage } = stagingOf(project);
      assert.equal(operation, error.operation);
      assert.deepEqual(text(path.join(stage, 'old', 'alpha')), ALPHA_V1);
      assert.deepEqual(text(path.join(stage, 'new', 'alpha')), ALPHA_V2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(project, LOCK_NAME), 'utf8')).operation, operation);
      assert.ok(plan(project).blockers.some((blocker) => /a skill update is running or was interrupted/.test(blocker)));
      refuses(() => apply(project), /holds \.agent-kit-update\.lock/);
      assert.deepEqual(recover(project).results, [{ skill: 'alpha in .agents/skills', result: 'previous version' }]);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
      apply(project);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
    });
    check('recover: a crash between the renames restores the previous version', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 1);
      assert.ok(!fs.existsSync(path.join(project, '.agents/skills/alpha')));
      assert.equal(recover(project).results[0].result, 'previous version');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });
    check('recover: a crash after the second rename completes the update', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 2);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.ok(fs.existsSync(path.join(project, LOCK_NAME)));
      assert.equal(recover(project).results[0].result, 'updated');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      noLeftovers(project);
    });
    check('recover: leftovers that no longer match the journal are refused and kept', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 1);
      const { stage } = stagingOf(project);
      write(stage, 'old/alpha/SKILL.md', 'edited after the crash\n');
      const before = contents(project);
      refuses(() => recover(project), /Cannot recover alpha in \.agents\/skills unambiguously \(live, staged old, staged new: absent,other,to\)/);
      assert.deepEqual(contents(project), before);
    });
    check('recover: a crash while staging is cleaned up, including a partly written file; skills are untouched', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'my-skill', { 'SKILL.md': 'mine\n' });
      const skillsBefore = contents(path.join(project, '.agents/skills'));
      crash(project, 'open', 2);
      const { stage } = stagingOf(project);
      const partial = fs.readdirSync(path.join(stage, 'new', 'alpha'), { recursive: true }).find((name) => name.endsWith('.md') && fs.statSync(path.join(stage, 'new', 'alpha', name)).size === 0);
      assert.ok(partial, 'the crash leaves an empty staged file');
      write(stage, `new/alpha/${partial.split(path.sep).join('/')}`, ALPHA_V2[partial.split(path.sep).join('/')].slice(0, 3));
      const { results } = recover(project);
      assert.deepEqual(results, [{ skill: `staging in .agents/${STAGING_NAME}`, result: 'removed; installed skills were not changed' }]);
      assert.deepEqual(contents(path.join(project, '.agents/skills')), skillsBefore);
      noLeftovers(project);
    });
    check('recover: staging leftovers that cannot be proven to belong to the operation are refused and kept', () => {
      const scenarios = {
        'foreign file': (stage) => write(stage, 'new/alpha/notes.md', 'mine\n'),
        'non-prefix content': (stage) => write(stage, 'new/alpha/SKILL.md', 'not the kit source\n'),
        'unexpected skill': (stage) => write(stage, 'new/beta/SKILL.md', BETA_V2['SKILL.md']),
        'non-empty old': (stage) => write(stage, 'old/alpha/SKILL.md', ALPHA_V1['SKILL.md']),
        'lock without intent': (stage, project) => { const lock = JSON.parse(fs.readFileSync(path.join(project, LOCK_NAME), 'utf8')); delete lock.entries; fs.writeFileSync(path.join(project, LOCK_NAME), JSON.stringify(lock)); },
      };
      for (const [name, tamper] of Object.entries(scenarios)) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        crash(project, 'open', 1);
        tamper(stagingOf(project).stage, project);
        const before = contents(project);
        try {
          refuses(() => recover(project), /Cannot clean up operation [0-9a-f-]+ in \.agents: .*Nothing was changed/);
          assert.deepEqual(contents(project), before);
        } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      }
      const ownKit = makeKit();
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'open', 1, ownKit);
      write(ownKit, 'core/skills/alpha/SKILL.md', 'changed kit source\n');
      const before = contents(project);
      refuses(() => recoverSkillUpdate(project, { kitRoot: ownKit }), /kit source of alpha changed since the update started/);
      assert.deepEqual(contents(project), before);
    });
    check('recover: one location journaled and another interrupted while staging are both resolved', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.cline/skills', 'alpha', ALPHA_V1);
      crash(project, 'open', 3);
      assert.ok(fs.existsSync(path.join(stagingOf(project, '.agents').stage, 'journal.json')));
      assert.ok(!fs.existsSync(path.join(stagingOf(project, '.cline').stage, 'journal.json')));
      const { results } = recover(project);
      assert.deepEqual(results.map((item) => item.result), ['previous version', 'removed; installed skills were not changed']);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      assert.deepEqual(text(path.join(project, '.cline/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });
    check('recover: unknown staging entries, foreign locks, and a missing lock are refused untouched', () => {
      const unknown = fresh('p');
      writeSkill(unknown, '.agents/skills', 'alpha', ALPHA_V1);
      write(unknown, `.agents/${STAGING_NAME}/someone-else/notes.txt`, 'keep\n');
      const unknownBefore = contents(unknown);
      assert.ok(plan(unknown).blockers.some((blocker) => /leftovers of an earlier skill update/.test(blocker)));
      refuses(() => apply(unknown), /conflicts or blockers/);
      refuses(() => recover(unknown), /No \.agent-kit-update\.lock/);
      write(unknown, LOCK_NAME, `${JSON.stringify({ format: 1, operation: '00000000-0000-4000-8000-000000000000', pid: 1, host: 'elsewhere' })}\n`);
      refuses(() => recover(unknown), /do not belong to operation 00000000-0000-4000-8000-000000000000: someone-else/);
      fs.unlinkSync(path.join(unknown, LOCK_NAME));
      assert.deepEqual(contents(unknown), unknownBefore);
      const foreign = fresh('p');
      writeSkill(foreign, '.agents/skills', 'alpha', ALPHA_V1);
      write(foreign, LOCK_NAME, 'my own notes\n');
      write(foreign, `.cline/${STAGING_NAME}`, 'a file with a conflicting name\n');
      const foreignBefore = contents(foreign);
      refuses(() => apply(foreign), /not a complete Agent Kit lock/);
      refuses(() => recover(foreign), /not a complete Agent Kit lock/);
      assert.deepEqual(contents(foreign), foreignBefore);
    });
    check('apply: a concurrent run is refused while the first holds the lock; the first completes', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      const second = plan(project);
      let refusal = null;
      apply(project, { onStep: (step) => { if (step === 'staged') try { applySkillUpdate(second, { kitRoot: kit }); } catch (error) { refusal = error; } } });
      assert.ok(refusal?.locked, 'the concurrent run must be refused by the lock');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V2);
      noLeftovers(project);
    });
    check('apply: links and junctions are never followed or written through', () => {
      const outside = fresh('outside');
      writeSkill(outside, 'skills', 'alpha', ALPHA_V1);
      const outsideBefore = contents(outside);
      const linkedSkill = fresh('p');
      link(path.join(outside, 'skills', 'alpha'), path.join(linkedSkill, '.agents', 'skills', 'alpha'));
      refuses(() => apply(linkedSkill), /conflicts or blockers/);
      const linkedStaging = fresh('p');
      writeSkill(linkedStaging, '.agents/skills', 'alpha', ALPHA_V1);
      link(outside, path.join(linkedStaging, '.agents', STAGING_NAME));
      refuses(() => apply(linkedStaging), /conflicts or blockers/);
      const linkedRoot = fresh('p');
      link(path.join(outside, 'skills'), path.join(linkedRoot, '.agents', 'skills'));
      refuses(() => apply(linkedRoot), /conflicts or blockers/);
      assert.deepEqual(contents(outside), outsideBefore);
      assert.deepEqual(text(path.join(linkedStaging, '.agents/skills/alpha')), ALPHA_V1);
    });
    check('apply: a junction swapped into the staging path after planning is refused', () => {
      const outside = fresh('outside');
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const planned = plan(project);
      link(outside, path.join(project, '.agents', STAGING_NAME));
      refuses(() => applySkillUpdate(planned, { kitRoot: kit }), /out of date/);
      assert.deepEqual(fs.readdirSync(outside), []);
    });
    // --- Forged journals and locks (B1): nothing may change anywhere, inside or outside the project. ---
    const journalOf = (project, parent = '.agents') => path.join(stagingOf(project, parent).stage, 'journal.json');
    const editJson = (file, mutate) => { const data = JSON.parse(fs.readFileSync(file, 'utf8')); mutate(data); fs.writeFileSync(file, JSON.stringify(data)); };
    const unchangedEverywhere = (fn) => { const before = contents(workspace); fn(); assert.deepEqual(contents(workspace), before, 'something changed'); };
    check('recover: a forged journal (location, skill, hashes, structure) is refused and nothing changes anywhere', () => {
      const victim = fresh('victim');
      write(victim, 'keep.txt', 'keep\n');
      const forgeries = {
        'location outside the project': (j, project) => { j.location = path.relative(project, victim).split(path.sep).join('/'); },
        'absolute location': (j) => { j.location = victim; },
        'the other location': (j) => { j.location = '.cline/skills'; },
        'skill with ..': (j) => { j.entries[0].skill = '../escape'; },
        'nested skill path': (j) => { j.entries[0].skill = 'alpha/inner'; },
        'absolute skill': (j) => { j.entries[0].skill = victim; },
        'unknown skill': (j) => { j.entries[0].skill = 'not-a-kit-skill'; },
        'from is not an object': (j) => { j.entries[0].from = 'x'; },
        'malformed digest': (j) => { j.entries[0].to['SKILL.md'] = 'XYZ'; },
        'unsafe file path': (j) => { j.entries[0].from = { '../x.md': '0'.repeat(64) }; },
        'duplicate skill': (j) => { j.entries.push(structuredClone(j.entries[0])); },
        'no entries': (j) => { j.entries = []; },
        'entries not a list': (j) => { j.entries = { 0: j.entries[0] }; },
        'another project': (j) => { j.project = victim; },
        'another format': (j) => { j.format = 2; },
      };
      for (const [name, forge] of Object.entries(forgeries)) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        crash(project, 'rename', 1);
        editJson(journalOf(project), (j) => forge(j, project));
        try {
          unchangedEverywhere(() => refuses(() => recover(project), /is not a valid journal of operation [0-9a-f-]+ for \.agents\/skills; nothing was changed/));
        } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      }
    });
    check('recover: forged lock entries are refused and nothing changes anywhere', () => {
      const forgeries = {
        'location outside': (lock) => { lock.entries[0].location = '../outside/skills'; },
        'skill ..': (lock) => { lock.entries[0].skill = '..'; },
        'bad digest': (lock) => { lock.entries[0].to = { 'SKILL.md': 'nope' }; },
        'entries not a list': (lock) => { lock.entries = {}; },
      };
      for (const [name, forge] of Object.entries(forgeries)) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        crash(project, 'open', 1);
        editJson(path.join(project, LOCK_NAME), forge);
        try {
          unchangedEverywhere(() => refuses(() => recover(project), /records entries that are not valid Agent Kit skills, locations, or hashes; nothing was changed/));
        } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      }
    });
    check('recover: a skills root replaced by a junction after the crash is never written through', () => {
      const victim = fresh('victim');
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 1);
      fs.rmdirSync(path.join(project, '.agents', 'skills'));
      link(victim, path.join(project, '.agents', 'skills'));
      unchangedEverywhere(() => refuses(() => recover(project), /Refusing to touch \.agents\/skills: \.agents\/skills is a link or junction/));
      assert.deepEqual(fs.readdirSync(victim), []);
    });

    // --- Interrupted cleanup (M1). ---
    check('recover: a crash while the previous copy was being deleted is finished', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'unlink-old', 1);
      assert.deepEqual(text(path.join(stagingOf(project).stage, 'old', 'alpha')), { 'notes/old.md': ALPHA_V1['notes/old.md'] });
      assert.deepEqual(recover(project).results, [{ skill: 'alpha in .agents/skills', result: 'updated' }]);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      noLeftovers(project);
    });
    check('recover: a crash inside recovery while it removed the staged copy is finished by a second recovery', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 1);
      crashRecovery(project, 'unlink-new', 1);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      assert.deepEqual(recover(project).results, [{ skill: 'alpha in .agents/skills', result: 'previous version' }]);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });
    check('recover: a partly deleted copy with extra or edited files is refused with guidance', () => {
      for (const [name, tamper] of [['extra file', (old) => write(old, 'mine.md', 'mine\n')], ['edited file', (old) => write(old, 'notes/old.md', 'edited\n')]]) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        crash(project, 'unlink-old', 1);
        tamper(path.join(stagingOf(project).stage, 'old', 'alpha'));
        const before = contents(project);
        try {
          refuses(() => recover(project), /Cannot recover alpha in \.agents\/skills unambiguously \(live, staged old, staged new: to,other,absent\)\. Nothing was changed\. The previous copy at \.agents\/\.agent-kit-update\/[0-9a-f-]+\/old\/alpha differs from the recorded version and may contain edits; move it out of the staging area/);
          assert.deepEqual(contents(project), before);
        } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      }
    });

    // --- Edits during the swap (L1), truncated journals (L2), and failing recovery (L3). ---
    check('apply: an edit made at the last moment is kept and reported; recovery finishes once it is moved away', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let edited = false;
      const fsImpl = { ...fs, renameSync: (from, to) => { if (!edited && LIVE(from)) { edited = true; fs.writeFileSync(path.join(from, 'SKILL.md'), 'edit at the worst moment\n'); } return fs.renameSync(from, to); } };
      let error;
      try { apply(project, { fsImpl }); } catch (caught) { error = caught; }
      assert.ok(error?.recoveryRequired);
      assert.match(error.message, /alpha in \.agents\/skills was updated, but its previous copy changed during the update and may contain edits\. It was kept at \.agents\/\.agent-kit-update\/[0-9a-f-]+\/old\/alpha\. Move that directory out/);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      const rescued = path.join(fresh('rescued'), 'alpha');
      fs.renameSync(path.join(stagingOf(project).stage, 'old', 'alpha'), rescued);
      assert.equal(fs.readFileSync(path.join(rescued, 'SKILL.md'), 'utf8'), 'edit at the worst moment\n');
      assert.deepEqual(recover(project).results, [{ skill: 'alpha in .agents/skills', result: 'updated' }]);
      noLeftovers(project);
    });
    check('recover: a journal cut off by a crash is cleaned up; unrelated journal text is refused', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'journal', 40);
      assert.deepEqual(recover(project).results, [{ skill: `staging in .agents/${STAGING_NAME}`, result: 'removed; installed skills were not changed' }]);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
      const other = fresh('p');
      writeSkill(other, '.agents/skills', 'alpha', ALPHA_V1);
      crash(other, 'journal', 40);
      fs.writeFileSync(journalOf(other), 'not a journal');
      const before = contents(other);
      refuses(() => recover(other), /journal\.json is unreadable and not a journal of operation/);
      assert.deepEqual(contents(other), before);
    });
    check('recover: a failing rename stops recovery with a clear error; a later recovery succeeds', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 1);
      refuses(() => recover(project, { fsImpl: failingRenames(ROLLBACK) }), /Recovery stopped \(EPERM\) while handling alpha in \.agents\/skills; \.agent-kit-update\.lock was kept/);
      assert.ok(fs.existsSync(path.join(project, LOCK_NAME)));
      assert.equal(recover(project).results[0].result, 'previous version');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });

    // --- Bounded retries for transient Windows errors (H1). ---
    const transientRenames = (rule, failures, code) => {
      const calls = { matched: 0 };
      return { calls, fsImpl: { ...fs, renameSync: (from, to) => { if (rule(from, to) && ++calls.matched <= failures) throw Object.assign(new Error(`${code}: busy`), { code }); return fs.renameSync(from, to); } } };
    };
    check('apply: transient EBUSY, EPERM, and EACCES renames are retried and succeed', () => {
      for (const [rule, code] of [[LIVE, 'EBUSY'], [STAGED, 'EPERM'], [LIVE, 'EACCES']]) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        const { calls, fsImpl } = transientRenames(rule, 2, code);
        assert.equal(apply(project, { fsImpl }).updated.length, 1, code);
        assert.equal(calls.matched, 3);
        assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
        noLeftovers(project);
      }
    });
    check('apply: retries are bounded, and a persistent error still leaves the previous version in place', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const { calls, fsImpl } = transientRenames(LIVE, Infinity, 'EACCES');
      refuses(() => apply(project, { fsImpl }), /stopped \(EACCES\)/);
      assert.equal(calls.matched, 1 + FAST.length);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });
    check('apply: a rename that reports an error after taking effect is not retried and is recoverable', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let attempts = 0;
      const fsImpl = { ...fs, renameSync: (from, to) => { fs.renameSync(from, to); if (LIVE(from)) { attempts++; throw Object.assign(new Error('EPERM: reported late'), { code: 'EPERM' }); } } };
      let error;
      try { apply(project, { fsImpl }); } catch (caught) { error = caught; }
      assert.equal(attempts, 1);
      assert.ok(error?.recoveryRequired);
      assert.match(error.message, /reported EPERM but took effect\. The previous version is kept at/);
      assert.equal(recover(project).results[0].result, 'previous version');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });

    // --- Lock creation (M2). ---
    check('lock: it appears only complete, without a leftover temporary file', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let seen = null;
      apply(project, { onStep: (step) => { if (step === 'staged') seen = { names: fs.readdirSync(project), lock: JSON.parse(fs.readFileSync(path.join(project, LOCK_NAME), 'utf8')) }; } });
      assert.deepEqual(seen.names.filter((name) => name.startsWith(LOCK_NAME)), [LOCK_NAME]);
      assert.deepEqual(seen.lock.entries.map((entry) => entry.skill), ['alpha']);
      noLeftovers(project);
      assert.deepEqual(fs.readdirSync(project).filter((name) => name.startsWith(LOCK_NAME)), []);
    });
    check('lock: file systems without hard links fall back to exclusive creation', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const fsImpl = { ...fs, linkSync: () => { throw Object.assign(new Error('ENOTSUP: hard links not supported'), { code: 'ENOTSUP' }); } };
      assert.equal(apply(project, { fsImpl }).updated.length, 1);
      noLeftovers(project);
      assert.deepEqual(fs.readdirSync(project).filter((name) => name.startsWith(LOCK_NAME)), []);
    });
    check('lock: an incomplete lock is never described as safe to delete', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      write(project, LOCK_NAME, '');
      assert.throws(() => apply(project), (error) => /not a complete Agent Kit lock\. It may belong to an update that is just starting/.test(error.message)
        && /remove it only after confirming that no Agent Kit update is running/.test(error.message) && !/Remove or rename it before updating/.test(error.message));
      assert.equal(fs.readFileSync(path.join(project, LOCK_NAME), 'utf8'), '');
    });
    // --- Links planted in staging or its parents (B1-bis): recovery must refuse and nothing may change anywhere. ---
    const VICTIM = { 'SKILL.md': 'victim data, not Agent Kit\n', 'notes/old.md': 'victim notes\n' };
    const crashFor = { restore: ['rename', 1], finish: ['rename', 2], discard: ['before-rename', 1] };
    check('recover: a link in place of staging/old or staging/new is refused for restore, finish, and discard', () => {
      for (const sub of ['old', 'new']) {
        for (const [decision, [mode, after]] of Object.entries(crashFor)) {
          const project = fresh('p');
          writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
          crash(project, mode, after);
          const victim = fresh('victim');
          writeSkill(victim, '.', 'alpha', VICTIM);
          const stage = stagingOf(project).stage;
          fs.renameSync(path.join(stage, sub), path.join(fresh('moved'), sub));
          link(victim, path.join(stage, sub));
          editJson(journalOf(project), (journal) => { journal.entries[0][sub === 'old' ? 'from' : 'to'] = hashes(VICTIM); });
          try {
            unchangedEverywhere(() => refuses(() => recover(project), new RegExp(`\\.agents/\\.agent-kit-update/[0-9a-f-]+/${sub} is a link or junction`)));
          } catch (error) { error.message = `${sub} link, ${decision}: ${error.message}`; throw error; }
        }
      }
    });
    check('recover: a link in place of the staged skill itself, the stage, or the .agents parent is refused', () => {
      const cases = {
        'staged old skill': (project, victim) => { const old = path.join(stagingOf(project).stage, 'old', 'alpha'); fs.renameSync(old, path.join(fresh('moved'), 'alpha')); link(path.join(victim, 'alpha'), old); },
        'stage directory': (project, victim) => { const { stage } = stagingOf(project); const moved = path.join(fresh('moved'), 'stage'); fs.renameSync(stage, moved); link(moved, stage); void victim; },
        '.agents parent': (project) => { const moved = path.join(fresh('moved'), '.agents'); fs.renameSync(path.join(project, '.agents'), moved); link(moved, path.join(project, '.agents')); },
      };
      for (const [name, plant] of Object.entries(cases)) {
        for (const mode of ['rename', 'open']) {
          const project = fresh('p');
          writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
          crash(project, mode, 1);
          const victim = fresh('victim');
          writeSkill(victim, '.', 'alpha', VICTIM);
          if (mode === 'open' && name === 'staged old skill') continue;
          plant(project, victim);
          try {
            unchangedEverywhere(() => refuses(() => recover(project), /is a link or junction|unambiguously \(live, staged old, staged new: absent,unsafe,to\)/));
          } catch (error) { error.message = `${name} (${mode}): ${error.message}`; throw error; }
        }
      }
    });
    check('apply: staging replaced by a link after it was created is never written through', () => {
      for (const sub of ['old', 'new']) {
        const project = fresh('p');
        writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
        const outside = fresh('outside');
        let outsideBefore = null;
        const onStep = (step, info) => {
          if (step !== 'staged') return;
          const stage = path.join(project, '.agents', STAGING_NAME, info.operation);
          fs.renameSync(path.join(stage, sub), path.join(outside, sub));
          link(path.join(outside, sub), path.join(stage, sub));
          outsideBefore = contents(outside);
        };
        assert.throws(() => apply(project, { onStep }), (error) => error instanceof UpdateError && /is a link or junction/.test(error.message), sub);
        assert.deepEqual(contents(outside), outsideBefore, `${sub}: nothing outside the project changed`);
        assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1, `${sub}: the installed skill is intact`);
      }
    });

    // --- Lock edge cases (L-A, L-B). ---
    check('lock: a lock that disappears between lstat and read, or between attempts, is not reported as incomplete', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let reads = 0;
      let links = 0;
      const fsImpl = {
        ...fs,
        readFileSync: (file, ...rest) => { if (String(file).endsWith(LOCK_NAME) && reads++ === 0) throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' }); return fs.readFileSync(file, ...rest); },
        lstatSync: (file, ...rest) => (String(file).endsWith(LOCK_NAME) && reads === 0 ? { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false } : fs.lstatSync(file, ...rest)),
        linkSync: (from, to) => { if (links++ === 0) throw Object.assign(new Error('EEXIST: taken'), { code: 'EEXIST' }); return fs.linkSync(from, to); },
      };
      assert.equal(apply(project, { fsImpl }).updated.length, 1);
      assert.ok(links >= 2, 'the lock was retried after the holder released it');
      noLeftovers(project);
    });
    check('lock: a temporary lock file that cannot be removed stops the update cleanly and is named', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      const before = contents(path.join(project, '.agents'));
      const stuck = { ...fs, unlinkSync: (file) => { if (String(file).endsWith('.tmp')) throw Object.assign(new Error('EPERM: held'), { code: 'EPERM' }); return fs.unlinkSync(file); } };
      refuses(() => apply(project, { fsImpl: stuck }), /Could not remove the temporary lock file \.agent-kit-update\.lock\.[0-9a-f-]+\.tmp \(EPERM\); the update did not start and nothing else was changed/);
      assert.ok(!fs.existsSync(path.join(project, LOCK_NAME)), 'no lock is left behind');
      assert.deepEqual(contents(path.join(project, '.agents')), before);
      const leftover = fs.readdirSync(project).filter((name) => name.endsWith('.tmp'));
      assert.equal(leftover.length, 1);
      fs.unlinkSync(path.join(project, leftover[0]));
      let failures = 0;
      const brief = { ...fs, unlinkSync: (file) => { if (String(file).endsWith('.tmp') && failures++ < 2) throw Object.assign(new Error('EBUSY: held'), { code: 'EBUSY' }); return fs.unlinkSync(file); } };
      assert.equal(apply(project, { fsImpl: brief }).updated.length, 1);
      assert.deepEqual(fs.readdirSync(project).filter((name) => name.startsWith(LOCK_NAME)), []);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  // Real processes racing for the same project: exactly one updates, the others are refused truthfully.
  const raceWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-skill-race-')));
  try {
    const raceKit = path.join(raceWorkspace, 'kit');
    fs.mkdirSync(path.join(raceKit, 'core', 'skills'), { recursive: true });
    for (const [name, files] of [['alpha', ALPHA_V2], ['beta', BETA_V2]]) for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(raceKit, 'core', 'skills', name, file)), { recursive: true }); fs.writeFileSync(path.join(raceKit, 'core', 'skills', name, file), content); }
    fs.mkdirSync(path.join(raceKit, 'optional'), { recursive: true });
    fs.writeFileSync(path.join(raceKit, 'optional', 'catalog.json'), '{}\n');
    fs.writeFileSync(path.join(raceKit, 'VERSION'), '2.0.0\n');
    fs.mkdirSync(path.join(raceKit, 'scripts', 'install'), { recursive: true });
    fs.writeFileSync(path.join(raceKit, 'scripts', 'install', 'skill-catalog.json'), catalogFor());
    const script = `
      import { planSkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-update.mjs')).href)};
      import { applySkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-apply.mjs')).href)};
      const [project, start] = process.argv.slice(-2);
      const kitRoot = ${JSON.stringify(raceKit)};
      const plan = planSkillUpdate(project, { kitRoot });
      while (Date.now() < Number(start)) {}
      try { console.log('updated ' + applySkillUpdate(plan, { kitRoot }).updated.length); } catch (error) { console.log('refused ' + error.message); }`;
    for (let round = 0; round < 3; round++) {
      const project = path.join(raceWorkspace, `race${round}`);
      for (const [name, files] of [['alpha', ALPHA_V1], ['beta', BETA_V1]]) for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(project, '.agents', 'skills', name, file)), { recursive: true }); fs.writeFileSync(path.join(project, '.agents', 'skills', name, file), content); }
      const start = String(Date.now() + 1500);
      const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', script, '--', project, start]);
        let out = '';
        proc.stdout.on('data', (data) => { out += data; });
        proc.stderr.on('data', (data) => { out += data; });
        proc.on('close', () => resolve(out.trim()));
      })));
      try {
        assert.equal(outputs.filter((line) => line === 'updated 2').length, 1, outputs.join(' | '));
        for (const line of outputs.filter((entry) => entry !== 'updated 2')) {
          // A process that planned before the winner finished sees the skills changed and replaces nothing.
          assert.match(line, /^refused (Another skill update holds \.agent-kit-update\.lock|The plan is out of date|(alpha|beta) in \.agents\/skills changed after planning; it was not replaced)/, line);
          assert.doesNotMatch(line, /not a complete/);
        }
        for (const [name, files] of [['alpha', ALPHA_V2], ['beta', BETA_V2]]) for (const [file, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(project, '.agents', 'skills', name, file), 'utf8'), content);
        assert.deepEqual(fs.readdirSync(project).filter((name) => name.startsWith(LOCK_NAME)), []);
        assert.ok(!fs.existsSync(path.join(project, '.agents', STAGING_NAME)));
      } catch (error) { error.message = `concurrent processes, round ${round + 1}: ${error.message}`; throw error; }
    }
    checks++;
  } finally {
    fs.rmSync(raceWorkspace, { recursive: true, force: true });
  }
  console.log(`Validated ${checks} skill update executor checks (update, no-op, several skills, Cline mirror, edits after planning, staging, or at the last moment, changed source or catalog, invalid plans, copy failure, EPERM on either rename, bounded retries, partial completion, rollback, impossible rollback, crash recovery at every step including cleanup, truncated journals, forged journals and locks, unknown or incomplete leftovers, concurrent runs in one process and four real processes, links and junctions).`);
}
