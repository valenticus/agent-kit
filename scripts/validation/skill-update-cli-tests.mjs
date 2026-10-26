// End-to-end -UpdateSkills / -DryRun / -RecoverSkillUpdate checks through the real install.ps1. Most run against a
// disposable copy of this kit whose catalog adds an older synthetic release, so CI needs no Git history.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildCatalog, currentVersion, directoryFiles, distributedSkills, normalizedHash, serializeCatalog } from '../install/skill-catalog.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = { 'safe-change': 'old safe-change\n', debugging: 'old debugging\n' };

export async function testSkillUpdateCli({ shell, failsWith }) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-update-cli-')));
  let checks = 0;
  const check = async (name, fn) => { try { await fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
  // Contents and modification times of every file, plus link targets, without following links.
  const snapshot = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const stat = fs.lstatSync(file);
        const rel = path.relative(dir, file);
        if (stat.isSymbolicLink()) out.push(`${rel}|link:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) { out.push(`${rel}/`); walk(file); }
        else out.push(`${rel}|${stat.mtimeMs}|${normalizedHash(fs.readFileSync(file))}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };
  const read = (file) => fs.readFileSync(file, 'utf8');
  const leftovers = (project) => ['.agent-kit-update.lock', '.agents/.agent-kit-update', '.cline/.agent-kit-update'].filter((rel) => fs.existsSync(path.join(project, rel)));

  // Disposable kit: this checkout plus a catalog with an older release 0.9.0 of safe-change and debugging.
  const kit = path.join(workspace, 'kit');
  for (const dir of ['adapters', 'agents', 'core', 'optional', 'scripts', 'templates']) fs.cpSync(path.join(root, dir), path.join(kit, dir), { recursive: true });
  fs.copyFileSync(path.join(root, 'VERSION'), path.join(kit, 'VERSION'));
  const current = {};
  for (const [name, { kind, dir }] of distributedSkills(kit)) current[name] = { kind, files: directoryFiles(dir) };
  const older = Object.fromEntries(Object.entries(OLD).map(([name, text]) => [name, { kind: 'core', files: { 'SKILL.md': normalizedHash(Buffer.from(text)) } }]));
  fs.writeFileSync(path.join(kit, 'scripts', 'install', 'skill-catalog.json'), serializeCatalog(buildCatalog([{ release: '0.9.0', skills: older }, { release: currentVersion(kit), skills: current }])));
  const source = (skill) => read(path.join(kit, 'core', 'skills', skill, 'SKILL.md'));
  const ps = (installer, project, ...args) => execFileAsync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', project, ...args]);
  const run = (project, ...args) => ps(path.join(kit, 'scripts', 'install', 'install.ps1'), project, ...args);
  const downgrade = (project, skill, locations = ['.agents', '.cline']) => { for (const location of locations) fs.writeFileSync(path.join(project, location, 'skills', skill, 'SKILL.md'), OLD[skill]); };
  const setUp = async (name) => {
    const project = path.join(workspace, name);
    fs.mkdirSync(project);
    await run(project, '-Tools', 'codex,cline,claude', '-Skills', 'safe-change,debugging');
    downgrade(project, 'safe-change');
    downgrade(project, 'debugging');
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'my-skill'));
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: mine\n---\n');
    fs.appendFileSync(path.join(project, 'AGENTS.md'), '\n## Mine\nkeep\n');
    const settings = JSON.parse(read(path.join(project, '.claude', 'settings.json')));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), `${JSON.stringify({ model: 'mine', ...settings }, null, 2)}\n`);
    return project;
  };
  const userFiles = (project) => ['AGENTS.md', 'CLAUDE.md', '.gitignore', '.claude/settings.json', '.claude/agent-kit/claude-bootstrap.mjs', '.agents/skills/my-skill/SKILL.md'].map((rel) => `${rel}|${read(path.join(project, rel))}`).join('\n');
  const crash = (project, renamesBeforeExit) => {
    const script = `
      import fs from 'node:fs';
      import { planSkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(kit, 'scripts', 'install', 'skill-update.mjs')).href)};
      import { applySkillUpdate } from ${JSON.stringify(pathToFileURL(path.join(kit, 'scripts', 'install', 'skill-apply.mjs')).href)};
      let renames = 0;
      const fsImpl = { ...fs, renameSync: (...args) => { fs.renameSync(...args); if (++renames === ${renamesBeforeExit}) process.exit(9); } };
      applySkillUpdate(planSkillUpdate(${JSON.stringify(project)}), { fsImpl });`;
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).status, 9, 'child did not crash as planned');
  };

  try {
    const main = await setUp('update with spaces');
    await check('cli: -DryRun shows the plan and writes nothing', async () => {
      const before = snapshot(main);
      const { stdout } = await run(main, '-UpdateSkills', '-DryRun');
      for (const line of [/UPDATE {4}debugging in \.agents\/skills: 0\.9\.0 -> /, /UPDATE {4}debugging in \.cline\/skills/, /UPDATE {4}safe-change in \.agents\/skills/, /SKIPPED {3}my-skill in \.agents\/skills/, /read-only; nothing was written/]) assert.match(stdout, line);
      assert.equal(snapshot(main), before);
    });
    await check('cli: older skills are updated in the shared copy and the Cline mirror; user files and Claude link are kept', async () => {
      const before = userFiles(main);
      const { stdout } = await run(main, '-UpdateSkills');
      for (const skill of ['debugging', 'safe-change']) {
        for (const location of ['.agents', '.cline']) {
          assert.match(stdout, new RegExp(`Updated ${skill} in \\${location}/skills: 0\\.9\\.0 -> `));
          assert.equal(read(path.join(main, location, 'skills', skill, 'SKILL.md')), source(skill));
        }
      }
      assert.equal(userFiles(main), before);
      assert.ok(fs.lstatSync(path.join(main, '.claude', 'skills')).isSymbolicLink(), '.claude/skills must stay a link (junction on Windows)');
      assert.equal(read(path.join(main, '.claude', 'skills', 'debugging', 'SKILL.md')), source('debugging'));
      assert.deepEqual(leftovers(main), []);
      await execFileAsync(process.execPath, [path.join(kit, 'scripts', 'validation', 'validate-install.mjs'), main]);
    });
    await check('cli: a second run changes nothing', async () => {
      const before = snapshot(main);
      assert.match((await run(main, '-UpdateSkills')).stdout, /All selected Agent Kit skills are current; nothing was changed/);
      assert.equal(snapshot(main), before);
    });
    await check('cli: absent selected skills are reported, never added', async () => {
      const before = snapshot(main);
      const { stdout } = await run(main, '-UpdateSkills', '-Skills', 'handoff', '-OptionalSkills', 'web-design-guidelines');
      assert.match(stdout, /Not installed, so not added: handoff/);
      assert.match(stdout, /Not installed, so not added: web-design-guidelines/);
      assert.equal(snapshot(main), before);
    });
    await check('cli: invalid or incompatible arguments are refused before any change', async () => {
      const before = snapshot(main);
      for (const [args, pattern] of [
        [['-DryRun'], /-DryRun requires -UpdateSkills/],
        [['-UpdateSkills', '-Tools', 'codex'], /-UpdateSkills is a standalone operation and cannot be combined with -Tools/],
        [['-UpdateSkills', '-NoSkills'], /cannot be combined with -NoSkills/],
        [['-UpdateSkills', '-UpdatePolicies'], /cannot be combined with -UpdatePolicies/],
        [['-UpdateSkills', '-CopilotAuditor'], /cannot be combined with -CopilotAuditor/],
        [['-RecoverSkillUpdate', '-Skills', 'ui'], /-RecoverSkillUpdate is a standalone operation and cannot be combined with -Skills/],
        [['-RecoverSkillUpdate', '-UpdateSkills'], /cannot be combined with -UpdateSkills/],
        [['-RecoverSkillUpdate', '-DryRun'], /-DryRun requires -UpdateSkills/],
        [['-UpdateSkills', '-Skills', 'nope'], /Unknown core skill: nope/],
        [['-UpdateSkills', '-Skills', 'web-design-guidelines'], /Unknown core skill: web-design-guidelines \(optional modules are selected with -OptionalSkills\)/],
        [['-UpdateSkills', '-OptionalSkills', 'debugging'], /Unknown optional skill: debugging \(core skills are selected with -Skills\)/],
        [['-UpdateSkills', '-OptionalSkills', 'vercel-react-best-practices'], /vercel-react-best-practices is a referenced optional module; Agent Kit does not install or update it/],
        [['-UpdateSkills', '-Skills', '..'], /Invalid skill name: \.\./],
        [['-RecoverSkillUpdate'], /No \.agent-kit-update\.lock: there is no interrupted update to recover/],
      ]) await failsWith(run(main, ...args), pattern, args.join(' '));
      assert.equal(snapshot(main), before);
    });
    await check('cli: a user edit blocks the whole plan; -Skills narrows around it', async () => {
      const project = await setUp('conflict');
      fs.writeFileSync(path.join(project, '.agents', 'skills', 'safe-change', 'SKILL.md'), 'my edit\n');
      const before = snapshot(project);
      await failsWith(run(project, '-UpdateSkills'), /CONFLICT safe-change in \.agents\/skills .*Skill update refused: resolve the conflicts/, 'conflict');
      assert.equal(snapshot(project), before, 'a conflict anywhere in the plan blocks every update');
      await run(project, '-UpdateSkills', '-Skills', 'debugging');
      assert.equal(read(path.join(project, '.agents', 'skills', 'debugging', 'SKILL.md')), source('debugging'));
      assert.equal(read(path.join(project, '.agents', 'skills', 'safe-change', 'SKILL.md')), 'my edit\n');
      assert.equal(read(path.join(project, '.cline', 'skills', 'safe-change', 'SKILL.md')), OLD['safe-change']);
    });
    await check('cli: an interrupted update blocks -UpdateSkills until -RecoverSkillUpdate restores it', async () => {
      const project = await setUp('interrupted');
      crash(project, 1);
      await failsWith(run(project, '-UpdateSkills'), /holds \.agent-kit-update\.lock .*-RecoverSkillUpdate/, 'interrupted update');
      const { stdout } = await run(project, '-RecoverSkillUpdate');
      assert.match(stdout, /Recovered debugging in \.agents\/skills: previous version/);
      assert.equal(read(path.join(project, '.agents', 'skills', 'debugging', 'SKILL.md')), OLD.debugging);
      assert.deepEqual(leftovers(project), []);
      await run(project, '-UpdateSkills');
      assert.equal(read(path.join(project, '.agents', 'skills', 'debugging', 'SKILL.md')), source('debugging'));
    });
    await check('cli: unknown staging is refused by -UpdateSkills and -RecoverSkillUpdate and kept', async () => {
      const project = await setUp('unknown-staging');
      fs.mkdirSync(path.join(project, '.agents', '.agent-kit-update', 'someone-else'), { recursive: true });
      fs.writeFileSync(path.join(project, '.agents', '.agent-kit-update', 'someone-else', 'notes.txt'), 'keep\n');
      const before = snapshot(project);
      await failsWith(run(project, '-UpdateSkills'), /BLOCKED \.agents\/\.agent-kit-update exists: leftovers of an earlier skill update/, 'unknown staging');
      await failsWith(run(project, '-RecoverSkillUpdate'), /No \.agent-kit-update\.lock/, 'recover without a lock');
      assert.equal(snapshot(project), before);
    });
    const validateInstall = (project) => execFileAsync(process.execPath, [path.join(kit, 'scripts', 'validation', 'validate-install.mjs'), project]);
    await check('cli: an ordinary install is refused while an update is interrupted, and validate-install reports it', async () => {
      const project = await setUp('install-blocked');
      crash(project, 1);
      const before = snapshot(project);
      await failsWith(run(project, '-Tools', 'codex', '-Skills', 'handoff'), /An Agent Kit skill update is running or was interrupted \(\.agent-kit-update\.lock exists\)\. Run install\.ps1 -ProjectRoot <project> -RecoverSkillUpdate first; nothing was changed/, 'install during an interrupted update');
      await failsWith(validateInstall(project), /an Agent Kit skill update is running or was interrupted \(\.agent-kit-update\.lock, \.agents\/\.agent-kit-update, \.cline\/\.agent-kit-update\); run install\.ps1 -RecoverSkillUpdate/, 'validate-install with leftovers');
      assert.equal(snapshot(project), before);
      await run(project, '-RecoverSkillUpdate');
      await validateInstall(project);
      await run(project, '-Tools', 'codex', '-Skills', 'handoff');
      assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'handoff', 'SKILL.md')));
    });
    await check('validate-install: CRLF and LF copies of a mirrored skill are equal; real differences still fail', async () => {
      const project = path.join(workspace, 'crlf mirror');
      fs.mkdirSync(project);
      await run(project, '-Tools', 'codex,cline', '-Skills', 'safe-change');
      const mirror = path.join(project, '.cline', 'skills', 'safe-change', 'SKILL.md');
      fs.writeFileSync(mirror, read(mirror).replace(/\r?\n/g, '\r\n'));
      await validateInstall(project);
      fs.appendFileSync(mirror, 'drift\r\n');
      await failsWith(validateInstall(project), /safe-change\/SKILL\.md: shared\/Cline mirrors differ/, 'real mirror difference');
    });
    await check('cli: a project without installed Agent Kit skills is told so', async () => {
      const project = path.join(workspace, 'no skills');
      fs.mkdirSync(project);
      assert.match((await run(project, '-UpdateSkills')).stdout, /No Agent Kit skills are installed in \.agents\/skills or \.cline\/skills; nothing was changed/);
      const { stdout } = await run(project, '-UpdateSkills', '-Skills', 'handoff');
      assert.match(stdout, /No selected Agent Kit skills are installed/);
      assert.match(stdout, /Not installed, so not added: handoff/);
      assert.deepEqual(fs.readdirSync(project), []);
    });
    await check('cli with the real kit: a fresh install is current and -DryRun writes nothing', async () => {
      const project = path.join(workspace, 'real kit');
      fs.mkdirSync(project);
      await ps(path.join(root, 'scripts', 'install', 'install.ps1'), project, '-Tools', 'codex,cline', '-Skills', 'safe-change,handoff');
      const before = snapshot(project);
      const { stdout } = await ps(path.join(root, 'scripts', 'install', 'install.ps1'), project, '-UpdateSkills', '-DryRun');
      assert.match(stdout, /Current 4, update 0, conflict 0\./);
      assert.equal(snapshot(project), before);
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`Validated ${checks} -UpdateSkills / -DryRun / -RecoverSkillUpdate checks through install.ps1 (dry run, shared and Cline updates, user files and Claude link kept, no-op rerun, absent skills, argument refusals, conflict blocking and narrowing, interrupted update and recovery, unknown staging, real kit, paths with spaces).`);
}
