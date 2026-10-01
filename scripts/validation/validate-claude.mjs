import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureSkillsLink, inspectSkillsLink, POSIX_LINK_TARGET } from '../../adapters/claude/claude-bootstrap.mjs';
import { BOOTSTRAP_RELATIVE, HOOK_COMMAND, install, planSettings } from '../install/claude-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-claude-'));
const posix = process.platform !== 'win32';
let counter = 0;
let checks = 0;
const skipped = [];

function project({ skills = true, git = false } = {}) {
  const dir = path.join(workspace, `p${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (skills) {
    fs.mkdirSync(path.join(dir, '.agents', 'skills', 'safe-change'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'skills', 'safe-change', 'SKILL.md'), '---\nname: safe-change\ndescription: x\n---\n');
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, content) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); };
const settingsOf = (dir) => JSON.parse(read(dir, '.claude/settings.json'));
const hookCount = (settings) => JSON.stringify(settings).split(BOOTSTRAP_RELATIVE).length - 1;
const refuses = (fn, pattern) => assert.throws(fn, (error) => pattern.test(error.message));
const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };

try {
  // A. canonical ownership
  check('canonical ownership', () => {
    assert.ok(fs.existsSync(path.join(root, 'core', 'skills', 'safe-change', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills')), 'kit must not contain a .claude/skills tree');
    assert.ok(!fs.existsSync(path.join(root, 'adapters', 'claude', 'skills')), 'Claude adapter must not own a skill tree');
  });

  // B. CLAUDE.md bridge
  check('CLAUDE.md template is a bare import', () => {
    assert.equal(fs.readFileSync(path.join(root, 'adapters', 'claude', 'CLAUDE.template.md'), 'utf8').trim(), '@AGENTS.md');
  });
  check('CLAUDE.md create / preserve', () => {
    const dir = project();
    install(dir);
    assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    const other = project();
    write(other, 'CLAUDE.md', 'Existing Claude rules\n@AGENTS.md\n');
    install(other);
    assert.equal(read(other, 'CLAUDE.md'), 'Existing Claude rules\n@AGENTS.md\n');
    const conflicting = project();
    write(conflicting, 'CLAUDE.md', 'Own rules without import\n');
    refuses(() => install(conflicting), /CLAUDE\.md/);
    assert.equal(read(conflicting, 'CLAUDE.md'), 'Own rules without import\n');
    assert.ok(!fs.existsSync(path.join(conflicting, '.claude')), 'refusal must happen before any write');
  });

  // C. bootstrap behavior (real filesystem links on POSIX)
  if (posix) {
    check('bootstrap missing -> relative symlink', () => {
      const dir = project();
      assert.equal(ensureSkillsLink(dir).status, 'created');
      assert.equal(fs.readlinkSync(path.join(dir, '.claude', 'skills')), POSIX_LINK_TARGET);
      assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'safe-change', 'SKILL.md')));
    });
    check('bootstrap correct link -> no-op', () => {
      const dir = project();
      ensureSkillsLink(dir);
      assert.equal(ensureSkillsLink(dir).status, 'unchanged');
    });
    check('bootstrap wrong / broken link -> refusal', () => {
      const dir = project();
      fs.mkdirSync(path.join(dir, 'elsewhere'));
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.symlinkSync('../elsewhere', path.join(dir, '.claude', 'skills'), 'dir');
      refuses(() => ensureSkillsLink(dir), /does not resolve/);
      assert.equal(fs.readlinkSync(path.join(dir, '.claude', 'skills')), '../elsewhere');
      const broken = project();
      fs.mkdirSync(path.join(broken, '.claude'));
      fs.symlinkSync('../nowhere', path.join(broken, '.claude', 'skills'), 'dir');
      refuses(() => ensureSkillsLink(broken), /does not resolve/);
    });
    check('bootstrap real directory -> refusal, content kept', () => {
      const dir = project();
      write(dir, '.claude/skills/own/SKILL.md', 'mine');
      refuses(() => ensureSkillsLink(dir), /real directory/);
      assert.equal(read(dir, '.claude/skills/own/SKILL.md'), 'mine');
    });
    check('bootstrap ordinary file -> refusal, content kept', () => {
      const dir = project();
      write(dir, '.claude/skills', 'mine');
      refuses(() => ensureSkillsLink(dir), /ordinary file/);
      assert.equal(read(dir, '.claude/skills'), 'mine');
    });
  } else skipped.push('real symlink bootstrap cases (non-POSIX host)');
  check('bootstrap missing canonical -> safe failure, nothing created', () => {
    const dir = project({ skills: false });
    refuses(() => ensureSkillsLink(dir), /Canonical skills directory/);
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  });

  // D. platform abstraction: Windows junction branch exercised with an injected fs (not a real junction)
  check('win32 branch requests an absolute junction (mocked fs)', () => {
    const dir = project();
    const calls = [];
    const state = { linked: false };
    const mock = {
      ...fs,
      lstatSync: (file) => (state.linked && file.endsWith(path.join('.claude', 'skills')) ? { isSymbolicLink: () => true, isDirectory: () => true } : fs.lstatSync(file)),
      realpathSync: (file) => (state.linked && file.endsWith(path.join('.claude', 'skills')) ? path.join(dir, '.agents', 'skills') : fs.realpathSync(file)),
      symlinkSync: (...args) => { calls.push(args); state.linked = true; },
    };
    assert.equal(ensureSkillsLink(dir, { fsImpl: mock, platform: 'win32' }).status, 'created');
    assert.deepEqual(calls, [[path.join(dir, '.agents', 'skills'), path.join(dir, '.claude', 'skills'), 'junction']]);
  });
  check('failure to link never falls back to copying (mocked fs)', () => {
    const dir = project();
    const mock = { ...fs, symlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
    refuses(() => ensureSkillsLink(dir, { fsImpl: mock, platform: 'win32' }), /No fallback copy/);
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills')));
  });
  if (process.platform !== 'win32') skipped.push('real Windows junction creation (requires a Windows host; confirmed manually in research)');

  // E. settings integration
  check('settings: none -> created with one hook', () => {
    const dir = project();
    install(dir);
    const settings = settingsOf(dir);
    assert.equal(hookCount(settings), 1);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, HOOK_COMMAND);
    assert.equal(read(dir, BOOTSTRAP_RELATIVE), fs.readFileSync(path.join(root, 'adapters', 'claude', 'claude-bootstrap.mjs'), 'utf8'));
  });
  check('settings: unrelated settings and hooks preserved, no duplicates', () => {
    const dir = project();
    const original = { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    write(dir, '.claude/settings.json', `${JSON.stringify(original, null, 4)}\n`);
    install(dir);
    const merged = settingsOf(dir);
    assert.equal(merged.model, 'x');
    assert.deepEqual(merged.permissions, original.permissions);
    assert.deepEqual(merged.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(merged.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    assert.equal(merged.hooks.SessionStart.length, 2);
    assert.ok(read(dir, '.claude/settings.json').includes('\n    "model"'), 'indentation preserved');
    const before = read(dir, '.claude/settings.json');
    install(dir);
    install(dir);
    assert.equal(read(dir, '.claude/settings.json'), before);
    assert.equal(hookCount(settingsOf(dir)), 1);
  });
  check('settings: malformed / unsafe -> refusal, file untouched', () => {
    for (const bad of ['{ "hooks": ', '// comment\n{}', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', 'null']) {
      const dir = project();
      write(dir, '.claude/settings.json', bad);
      refuses(() => install(dir), /settings\.json/);
      assert.equal(read(dir, '.claude/settings.json'), bad);
      assert.ok(!fs.existsSync(path.join(dir, BOOTSTRAP_RELATIVE)), 'refusal must happen before any write');
    }
    assert.throws(() => planSettings('{"a":1,}'));
  });

  // F. .gitignore (real git)
  if (posix) {
    check('gitignore: generated link ignored, settings and bridge not ignored, nothing staged from the link', () => {
      const dir = project({ git: true });
      write(dir, '.gitignore', 'node_modules\n');
      install(dir);
      const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: dir }).status === 0;
      assert.ok(ignored('.claude/skills'));
      assert.ok(!ignored('.claude/settings.json'));
      assert.ok(!ignored('.claude/agent-kit/claude-bootstrap.mjs'));
      assert.ok(!ignored('CLAUDE.md'));
      assert.ok(!ignored('.agents/skills/safe-change/SKILL.md'));
      execFileSync('git', ['add', '-A'], { cwd: dir });
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
      assert.ok(staged.every((file) => !file.startsWith('.claude/skills')), `staged: ${staged}`);
      assert.ok(staged.includes('.claude/settings.json') && staged.includes('.agents/skills/safe-change/SKILL.md'));
      assert.equal(read(dir, '.gitignore').split('\n').filter((line) => line === '/.claude/skills').length, 1);
    });
    check('gitignore: trailing-slash rule does not cover a symlink, so the entry is still added', () => {
      const dir = project({ git: true });
      write(dir, '.gitignore', '.claude/skills/');
      install(dir);
      assert.equal(spawnSync('git', ['check-ignore', '-q', '.claude/skills'], { cwd: dir }).status, 0);
    });
    check('gitignore: CRLF preserved and install idempotent', () => {
      const dir = project();
      write(dir, '.gitignore', 'a\r\nb');
      install(dir);
      const once = read(dir, '.gitignore');
      assert.ok(/^a\r\nb\r\n# Agent Kit.*\r\n\/\.claude\/skills\r\n$/.test(once), JSON.stringify(once));
      install(dir);
      assert.equal(read(dir, '.gitignore'), once);
    });
  } else skipped.push('git ignore checks needing symlinks (non-POSIX host)');

  // G. adapter install: idempotency, conflicts, missing canonical, CLI exit codes
  check('install: idempotent second run', () => {
    const dir = project();
    install(dir);
    const second = install(dir);
    assert.ok(second.every((line) => !/^created|^merged|^added/.test(line) || /link/.test(line)), second.join('; '));
  });
  check('install: existing wrong bootstrap file -> refusal', () => {
    const dir = project();
    write(dir, BOOTSTRAP_RELATIVE, '// mine');
    refuses(() => install(dir), /never overwritten/);
    assert.equal(read(dir, BOOTSTRAP_RELATIVE), '// mine');
  });
  check('install: missing canonical skills -> refusal before any write', () => {
    const dir = project({ skills: false });
    refuses(() => install(dir), /Canonical skills directory/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
  if (posix) {
    check('install: real directory at .claude/skills -> refusal before any write', () => {
      const dir = project();
      write(dir, '.claude/skills/own/SKILL.md', 'mine');
      refuses(() => install(dir), /never overwritten/);
      assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')));
    });
    check('installed bootstrap runs as a hook (silent success, creates link, safe refusal exit 2)', () => {
      const dir = project();
      install(dir);
      fs.unlinkSync(path.join(dir, '.claude', 'skills'));
      const run = () => spawnSync(process.execPath, [path.join(dir, BOOTSTRAP_RELATIVE)], { cwd: tmpdir(), encoding: 'utf8' });
      const ok = run();
      assert.equal(ok.status, 0);
      assert.equal(ok.stdout + ok.stderr, '');
      assert.equal(fs.readlinkSync(path.join(dir, '.claude', 'skills')), POSIX_LINK_TARGET);
      fs.unlinkSync(path.join(dir, '.claude', 'skills'));
      write(dir, '.claude/skills', 'file');
      const refused = run();
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /ordinary file/);
      const kitCopy = spawnSync(process.execPath, [path.join(root, 'adapters', 'claude', 'claude-bootstrap.mjs')], { encoding: 'utf8' });
      assert.equal(kitCopy.status, 2, 'kit copy must not act on its own repository without --project');
    });
  }
  check('inspect reports states without mutating', () => {
    const dir = project();
    assert.equal(inspectSkillsLink(dir).state, 'missing');
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  });

  console.log(`Validated ${checks} Claude adapter checks (ownership, bridge, bootstrap, settings merge, gitignore, adapter install).${skipped.length ? ` Not exercised on this host: ${skipped.join('; ')}.` : ''}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
