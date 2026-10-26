// Skill update executor and recovery checks. Run from validate-installer.mjs before PowerShell is required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

  const ALPHA_V1 = { 'SKILL.md': 'alpha v1\n' };
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
  const apply = (project, options = {}) => applySkillUpdate(plan(project, options.plan), { kitRoot: kit, ...options });
  // An fs whose renameSync fails (EPERM, as Windows reports for open handles) on the listed call numbers.
  const failingRenames = (...calls) => {
    let count = 0;
    return { ...fs, renameSync: (...args) => { if (calls.includes(++count)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${args[0]}'`), { code: 'EPERM' }); return fs.renameSync(...args); } };
  };
  // Runs an update in a child process that exits abruptly after the given fs call, like a crash or power loss.
  const crash = (project, mode, after) => {
    const script = `
      import fs from 'node:fs';
      import { planSkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-update.mjs')).href)};
      import { applySkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(installDir, 'skill-apply.mjs')).href)};
      let renames = 0, opens = 0;
      const fsImpl = { ...fs,
        renameSync: (...args) => { fs.renameSync(...args); if (${JSON.stringify(mode)} === 'rename' && ++renames === ${after}) process.exit(9); },
        openSync: (...args) => { const fd = fs.openSync(...args); if (${JSON.stringify(mode)} === 'open' && String(args[0]).includes(${JSON.stringify(`${path.sep}new${path.sep}`)}) && ++opens === ${after}) process.exit(9); return fd; } };
      const kitRoot = ${JSON.stringify(kit)};
      applySkillUpdate(planSkillUpdate(${JSON.stringify(project)}, { kitRoot }), { kitRoot, fsImpl });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 9, `child did not crash as planned: ${result.stderr}`);
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
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), { 'SKILL.md': 'late edit\n' });
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
      refuses(() => apply(project, { fsImpl: failingRenames(1) }), /stopped \(EPERM\)/);
      assert.deepEqual(contents(path.join(project, '.agents/skills')), before);
      noLeftovers(project);
    });
    check('apply: a failed second rename (EPERM) is rolled back to the previous version', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      assert.throws(() => apply(project, { fsImpl: failingRenames(2) }), (error) => error instanceof UpdateError && /stopped \(EPERM\)/.test(error.message) && !error.recoveryRequired);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V1);
      noLeftovers(project);
    });
    check('apply: earlier skills stay updated when a later one fails; the report says so', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      writeSkill(project, '.agents/skills', 'beta', BETA_V1);
      assert.throws(() => apply(project, { fsImpl: failingRenames(3) }), (error) => /already updated: alpha in \.agents\/skills/.test(error.message) && error.updated.length === 1);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.deepEqual(text(path.join(project, '.agents/skills/beta')), BETA_V1);
      noLeftovers(project);
    });
    check('apply: an impossible rollback keeps the previous version for recovery; recover restores it', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      let error;
      try { apply(project, { fsImpl: failingRenames(2, 3) }); } catch (caught) { error = caught; }
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
      assert.deepEqual(recoverSkillUpdate(project).results, [{ skill: 'alpha in .agents/skills', result: 'previous version' }]);
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
      assert.equal(recoverSkillUpdate(project).results[0].result, 'previous version');
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
      noLeftovers(project);
    });
    check('recover: a crash after the second rename completes the update', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'rename', 2);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V2);
      assert.ok(fs.existsSync(path.join(project, LOCK_NAME)));
      assert.equal(recoverSkillUpdate(project).results[0].result, 'updated');
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
      refuses(() => recoverSkillUpdate(project), /Cannot recover alpha in \.agents\/skills unambiguously \(live, staged old, staged new: absent,other,to\)/);
      assert.deepEqual(contents(project), before);
    });
    check('recover: a crash while staging changes nothing and asks for manual review', () => {
      const project = fresh('p');
      writeSkill(project, '.agents/skills', 'alpha', ALPHA_V1);
      crash(project, 'open', 1);
      const before = contents(project);
      refuses(() => recoverSkillUpdate(project), /stopped while staging in \.agents; installed skills were not changed/);
      assert.deepEqual(contents(project), before);
      assert.deepEqual(text(path.join(project, '.agents/skills/alpha')), ALPHA_V1);
    });
    check('recover: unknown staging entries, foreign locks, and a missing lock are refused untouched', () => {
      const unknown = fresh('p');
      writeSkill(unknown, '.agents/skills', 'alpha', ALPHA_V1);
      write(unknown, `.agents/${STAGING_NAME}/someone-else/notes.txt`, 'keep\n');
      const unknownBefore = contents(unknown);
      assert.ok(plan(unknown).blockers.some((blocker) => /leftovers of an earlier skill update/.test(blocker)));
      refuses(() => apply(unknown), /conflicts or blockers/);
      refuses(() => recoverSkillUpdate(unknown), /No \.agent-kit-update\.lock/);
      write(unknown, LOCK_NAME, `${JSON.stringify({ format: 1, operation: '00000000-0000-4000-8000-000000000000', pid: 1, host: 'elsewhere' })}\n`);
      refuses(() => recoverSkillUpdate(unknown), /do not belong to operation 00000000-0000-4000-8000-000000000000: someone-else/);
      fs.unlinkSync(path.join(unknown, LOCK_NAME));
      assert.deepEqual(contents(unknown), unknownBefore);
      const foreign = fresh('p');
      writeSkill(foreign, '.agents/skills', 'alpha', ALPHA_V1);
      write(foreign, LOCK_NAME, 'my own notes\n');
      write(foreign, `.cline/${STAGING_NAME}`, 'a file with a conflicting name\n');
      const foreignBefore = contents(foreign);
      refuses(() => apply(foreign), /was not written by an Agent Kit update/);
      refuses(() => recoverSkillUpdate(foreign), /was not written by an Agent Kit update/);
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
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`Validated ${checks} skill update executor checks (update, no-op, several skills, Cline mirror, edits after planning or staging, changed source or catalog, invalid plans, copy failure, EPERM on either rename, partial completion, rollback, impossible rollback with recovery, crash recovery before, between, and after the renames, unknown or foreign leftovers, concurrent runs, links and junctions).`);
}
