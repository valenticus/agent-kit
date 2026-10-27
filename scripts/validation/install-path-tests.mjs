// Installer containment checks through the real install.ps1: links in a project never lead an ordinary install, the
// Claude adapter, or -UpdatePolicies outside it. Every refusal must leave the whole fixture space (project and the
// "outside" directory beside it) unchanged. Run from validate-installer.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = path.join(root, 'scripts', 'install', 'install.ps1');
const posix = process.platform !== 'win32';

export async function testInstallPaths({ shell, failsWith }) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-install-paths-')));
  let checks = 0;
  const skipped = [];
  const check = async (name, fn) => { try { await fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
  // Contents and modification times of every file and directory, plus link targets, without following links.
  const snapshot = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const stat = fs.lstatSync(file);
        const rel = path.relative(dir, file);
        if (stat.isSymbolicLink()) out.push(`${rel}|link:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) { out.push(`${rel}/|${stat.mtimeMs}`); walk(file); }
        else out.push(`${rel}|${stat.mtimeMs}|${fs.readFileSync(file, 'utf8')}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };
  const run = (project, ...args) => execFileAsync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', project, ...args]);
  // Directory links are junctions on Windows (no privilege needed), so those cases run on both CI hosts.
  const dirLink = (target, at) => fs.symlinkSync(posix ? target : path.resolve(path.dirname(at), target), at, posix ? 'dir' : 'junction');
  let count = 0;
  const space = () => {
    const dir = path.join(workspace, `space${count++}`);
    fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outside', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside', '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n');
    fs.writeFileSync(path.join(dir, 'outside', 'notes.txt'), 'outside notes\n');
    return dir;
  };
  const refusedUnchanged = (name, setUp, args, pattern) => check(`install paths: ${name}`, async () => {
    const dir = space();
    const project = path.join(dir, 'proj');
    setUp(project);
    const before = snapshot(dir);
    await failsWith(run(project, ...args), pattern, name);
    assert.equal(snapshot(dir), before, 'nothing may change inside or outside the project');
  });

  try {
    const reparse = 'is a symbolic link, junction, or other reparse point';
    await refusedUnchanged('external .agents', (p) => dirLink('../outside', path.join(p, '.agents')), ['-Tools', 'codex', '-Skills', 'safe-change'], new RegExp(`\\.agents ${reparse}`));
    await refusedUnchanged('external .agents/skills', (p) => { fs.mkdirSync(path.join(p, '.agents')); dirLink('../../outside', path.join(p, '.agents', 'skills')); }, ['-Tools', 'codex', '-Skills', 'safe-change'], new RegExp(`skills ${reparse}`));
    await refusedUnchanged('internal .agents link (installs never write through links)', (p) => { fs.mkdirSync(path.join(p, 'real-agents')); dirLink('real-agents', path.join(p, '.agents')); }, ['-Tools', 'codex', '-Skills', 'safe-change'], new RegExp(`\\.agents ${reparse}`));
    await refusedUnchanged('external .cline', (p) => dirLink('../outside', path.join(p, '.cline')), ['-Tools', 'cline', '-Skills', 'safe-change'], new RegExp(`\\.cline ${reparse}`));
    await refusedUnchanged('external .github', (p) => dirLink('../outside', path.join(p, '.github')), ['-Tools', 'copilot', '-Skills', 'safe-change'], new RegExp(`\\.github ${reparse}`));
    await refusedUnchanged('external .github/agents', (p) => { fs.mkdirSync(path.join(p, '.github')); dirLink('../../outside', path.join(p, '.github', 'agents')); }, ['-Tools', 'copilot', '-CopilotAuditor', '-NoSkills'], new RegExp(`agents ${reparse}`));
    await refusedUnchanged('external .kilo', (p) => dirLink('../outside', path.join(p, '.kilo')), ['-Tools', 'kilo', '-Skills', 'safe-change'], new RegExp(`\\.kilo ${reparse}`));
    // The adapter preflight runs before any skill is copied, so a refusal leaves no partial install.
    await refusedUnchanged('external .claude (no partial install)', (p) => dirLink('../outside/.claude', path.join(p, '.claude')), ['-Tools', 'codex,claude', '-Skills', 'safe-change'], /\.claude is a symbolic link or junction/);
    if (posix) {
      await refusedUnchanged('external .claude/settings.json', (p) => { fs.mkdirSync(path.join(p, '.claude')); fs.symlinkSync('../../outside/.claude/settings.json', path.join(p, '.claude', 'settings.json')); }, ['-Tools', 'claude', '-Skills', 'safe-change'], /settings\.json is a symbolic link or junction/);
      await refusedUnchanged('external .gitignore', (p) => fs.symlinkSync('../outside/notes.txt', path.join(p, '.gitignore')), ['-Tools', 'claude', '-Skills', 'safe-change'], /\.gitignore is a link that leads outside the project/);
      await refusedUnchanged('broken CLAUDE.md link', (p) => fs.symlinkSync('missing.md', path.join(p, 'CLAUDE.md')), ['-Tools', 'claude', '-Skills', 'safe-change'], /CLAUDE\.md is a broken or circular link/);
      await refusedUnchanged('broken AGENTS.md link', (p) => fs.symlinkSync('missing.md', path.join(p, 'AGENTS.md')), ['-Tools', 'codex', '-Skills', 'safe-change'], /AGENTS\.md is a broken or circular link/);
      await refusedUnchanged('-UpdatePolicies with an external AGENTS.md', (p) => fs.symlinkSync('../outside/notes.txt', path.join(p, 'AGENTS.md')), ['-UpdatePolicies'], /AGENTS\.md is a link that leads outside the project/);
    } else skipped.push('file symlink cases (need symlink privilege on Windows)');

    // Also covers every project path handed to node (PowerShell on macOS and Linux globs unquoted native arguments).
    await check('install paths: wildcard characters in -ProjectRoot are literal in every mode', async () => {
      const dir = space();
      const bracketed = path.join(dir, 'app[1]');
      const sibling = path.join(dir, 'app1');
      fs.mkdirSync(bracketed);
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, '.agent-kit-update.lock'), 'not ours\n');
      const siblingBefore = snapshot(sibling);
      await run(bracketed, '-Tools', 'codex,claude', '-Skills', 'safe-change');
      for (const rel of ['.agents/skills/safe-change/SKILL.md', 'CLAUDE.md', '.claude/settings.json', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(bracketed, rel)), `installed ${rel} into the named directory`);
      assert.match((await run(bracketed, '-UpdatePolicies')).stdout, /Policy block: noop AGENTS\.md/);
      assert.match((await run(bracketed, '-UpdateSkills', '-DryRun')).stdout, /Current 1, update 0, conflict 0\./);
      await failsWith(run(bracketed, '-RecoverSkillUpdate'), /No \.agent-kit-update\.lock: there is no interrupted update to recover/, 'recover');
      assert.equal(snapshot(sibling), siblingBefore, 'the wildcard match was not touched');
    });
    await check('install paths: reruns are idempotent or refused without changes', async () => {
      const dir = space();
      const project = path.join(dir, 'proj');
      await run(project, '-Tools', 'codex,claude', '-Skills', 'safe-change');
      const installed = snapshot(dir);
      const { stdout } = await run(project, '-Tools', 'claude', '-NoSkills');
      assert.match(stdout, /unchanged \.claude\/skills link/);
      assert.equal(snapshot(dir), installed, 'completing an existing adapter writes nothing');
      await run(project, '-UpdatePolicies');
      assert.equal(snapshot(dir), installed, 'current policies are a no-op');
      await failsWith(run(project, '-Tools', 'codex,claude', '-Skills', 'safe-change'), /Refusing to overwrite/, 'repeated install');
      assert.equal(snapshot(dir), installed, 'a repeated install is refused before writing');
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`Validated ${checks} installer containment checks (external and internal links for .agents, .cline, .github, .kilo, .claude, settings, .gitignore, CLAUDE.md, and AGENTS.md, broken links, -UpdatePolicies, literal -ProjectRoot, idempotent reruns).${skipped.length ? ` Not exercised on this host: ${skipped.join('; ')}.` : ''}`);
}
