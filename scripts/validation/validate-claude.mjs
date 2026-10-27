import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureSkillsLink, inspectSkillsLink, POSIX_LINK_TARGET } from '../../adapters/claude/claude-bootstrap.mjs';
import { BOOTSTRAP_RELATIVE, HOOK_COMMAND, install, isAgentKitHook, planSettings } from '../install/claude-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Canonical path: on macOS the default temp directory is reached through the /var -> /private/var link, and the mocked
// junction below reports the link target in canonical form.
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-claude-')));
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
// EOL-independent but strict: the bridge is exactly one "@AGENTS.md" line, nothing else.
const isBridgeOnly = (text) => text.replace(/\r?\n$/, '') === '@AGENTS.md';
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
    assert.ok(isBridgeOnly(fs.readFileSync(path.join(root, 'adapters', 'claude', 'CLAUDE.template.md'), 'utf8')));
    for (const good of ['@AGENTS.md', '@AGENTS.md\n', '@AGENTS.md\r\n']) assert.ok(isBridgeOnly(good), JSON.stringify(good));
    for (const bad of ['@AGENTS.md\nExtra rule\n', '# Title\n@AGENTS.md\n', '@AGENTS.md extra\n', '\n@AGENTS.md\n', '@AGENTS.md\n\n', '']) assert.ok(!isBridgeOnly(bad), JSON.stringify(bad));
  });
  check('CLAUDE.md create / preserve', () => {
    const dir = project();
    install(dir);
    assert.ok(isBridgeOnly(read(dir, 'CLAUDE.md')));
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
  // Windows-native junction coverage (real junctions in disposable directories; runs only on a Windows host).
  if (process.platform === 'win32') {
    const winProject = () => {
      const dir = project();
      const spaced = path.join(workspace, `with space ${counter++}`);
      fs.renameSync(dir, spaced);
      return spaced;
    };
    check('win32 real junction: create (path with spaces), no-op, state inspection', () => {
      const dir = winProject();
      assert.equal(ensureSkillsLink(dir).status, 'created');
      const link = path.join(dir, '.claude', 'skills');
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.equal(inspectSkillsLink(dir).state, 'correct');
      assert.ok(fs.existsSync(path.join(link, 'safe-change', 'SKILL.md')));
      assert.equal(ensureSkillsLink(dir).status, 'unchanged');
    });
    check('win32 real junction: wrong and broken junctions refused', () => {
      const dir = winProject();
      fs.mkdirSync(path.join(dir, 'elsewhere'));
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, '.claude', 'skills'), 'junction');
      refuses(() => ensureSkillsLink(dir), /does not resolve/);
      const broken = winProject();
      fs.mkdirSync(path.join(broken, 'gone'));
      fs.mkdirSync(path.join(broken, '.claude'));
      fs.symlinkSync(path.join(broken, 'gone'), path.join(broken, '.claude', 'skills'), 'junction');
      fs.rmdirSync(path.join(broken, 'gone'));
      refuses(() => ensureSkillsLink(broken), /does not resolve/);
    });
    check('win32: real directory, ordinary file, missing canonical refused', () => {
      const dir = winProject();
      write(dir, '.claude/skills/own/SKILL.md', 'mine');
      refuses(() => ensureSkillsLink(dir), /real directory/);
      const file = winProject();
      write(file, '.claude/skills', 'mine');
      refuses(() => ensureSkillsLink(file), /ordinary file/);
      refuses(() => ensureSkillsLink(project({ skills: false })), /Canonical skills directory/);
    });
    check('win32: installer step creates a junction and git ignores it', () => {
      const dir = winProject();
      execFileSync('git', ['init', '-q'], { cwd: dir });
      install(dir);
      execFileSync('git', ['add', '-A'], { cwd: dir });
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
      assert.ok(staged.every((file) => !file.startsWith('.claude/skills')), `staged: ${staged}`);
    });
  } else skipped.push('real Windows junction cases (run only on a Windows host)');

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
  check('settings: exact hook identity (substring/embedded/wrong-type are not the Agent Kit hook)', () => {
    const exact = { type: 'command', command: HOOK_COMMAND };
    assert.ok(isAgentKitHook(exact));
    for (const notHook of [
      { type: 'command', command: `echo ${BOOTSTRAP_RELATIVE}` },
      { type: 'command', command: `${HOOK_COMMAND} && echo extra` },
      { type: 'command', command: `echo hi; ${HOOK_COMMAND}` },
      { type: 'prompt', command: HOOK_COMMAND },
      { command: HOOK_COMMAND },
      null, 'string', [],
    ]) assert.ok(!isAgentKitHook(notHook), JSON.stringify(notHook));
    for (const impostor of [{ type: 'command', command: `echo ${BOOTSTRAP_RELATIVE}` }, { type: 'command', command: `${HOOK_COMMAND} && echo extra` }, { type: 'prompt', command: HOOK_COMMAND }]) {
      const dir = project();
      write(dir, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [impostor] }] } }));
      install(dir);
      const groups = settingsOf(dir).hooks.SessionStart;
      assert.equal(groups.length, 2, 'real hook must be added next to the impostor');
      assert.deepEqual(groups[0].hooks[0], impostor);
      assert.deepEqual(groups[1].hooks[0], exact);
      install(dir);
      assert.equal(settingsOf(dir).hooks.SessionStart.length, 2, 'exact hook must not duplicate');
    }
    const dir = project();
    write(dir, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [exact] }] } }));
    install(dir);
    assert.equal(settingsOf(dir).hooks.SessionStart.length, 1);
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
  check('settings: a UTF-8 BOM, CRLF, indentation, and keys survive the merge; idempotent', () => {
    const dir = project();
    const original = `﻿${JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'] } }, null, 4).replace(/\n/g, '\r\n')}\r\n`;
    write(dir, '.claude/settings.json', original);
    install(dir);
    const merged = read(dir, '.claude/settings.json');
    assert.ok(merged.startsWith('﻿') && !merged.startsWith('﻿﻿'), 'single BOM kept');
    assert.ok(!/(^|[^\r])\n/.test(merged), 'CRLF kept');
    assert.ok(merged.includes('\r\n    "model"'), 'indentation kept');
    const parsed = JSON.parse(merged.slice(1));
    assert.equal(parsed.model, 'x');
    assert.deepEqual(parsed.permissions, { allow: ['Bash(ls)'] });
    assert.equal(hookCount(parsed), 1);
    install(dir);
    assert.equal(read(dir, '.claude/settings.json'), merged, 'second install is byte-identical');
    assert.ok(!planSettings(`{\n  "a": 1\n}\n`).content.startsWith('﻿'), 'no BOM is added to a file without one');
  });
  check('settings: a failed write or rename keeps the original, removes only its own temp file, and never touches other files', () => {
    // The bootstrap copy is written before settings.json; only settings temp files are checked here.
    const settingsDir = (dir) => fs.readdirSync(path.join(dir, '.claude')).filter((name) => name.startsWith('settings.json')).sort();
    for (const failing of ['writeFileSync', 'renameSync']) {
      const dir = project();
      const original = '{\n  "model": "x"\n}\n';
      write(dir, '.claude/settings.json', original);
      write(dir, '.claude/settings.json.agent-kit-tmp', 'not ours');
      const fsImpl = { ...fs, [failing]: (...args) => { if (failing === 'writeFileSync' && typeof args[0] !== 'number') return fs.writeFileSync(...args); throw new Error(`injected ${failing} failure`); } };
      assert.throws(() => install(dir, { fsImpl }), new RegExp(`injected ${failing} failure`));
      assert.equal(read(dir, '.claude/settings.json'), original, `${failing}: original unchanged`);
      assert.equal(read(dir, '.claude/settings.json.agent-kit-tmp'), 'not ours', `${failing}: unrelated file untouched`);
      assert.deepEqual(settingsDir(dir), ['settings.json', 'settings.json.agent-kit-tmp'], `${failing}: no leftover temp file`);
    }
    const dir = project();
    write(dir, '.claude/settings.json', '{}\n');
    let unlinked = 0;
    const exists = { ...fs, openSync: () => { throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }); }, unlinkSync: () => { unlinked++; } };
    assert.throws(() => install(dir, { fsImpl: exists }), /EEXIST/);
    assert.equal(unlinked, 0, 'a temp file this call did not create is never removed');
    assert.equal(read(dir, '.claude/settings.json'), '{}\n');
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
  // H. links never lead the adapter outside the project. Each case is a project beside an "outside" directory; a
  // refusal must leave both byte-for-byte unchanged (contents, modification times, link targets).
  const snapshot = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) out.push(`${path.relative(dir, file)}|link:${fs.readlinkSync(file)}`);
        else if (stat.isDirectory()) { out.push(`${path.relative(dir, file)}/|${stat.mtimeMs}`); walk(file); }
        else out.push(`${path.relative(dir, file)}|${stat.mtimeMs}|${fs.readFileSync(file, 'utf8')}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };
  // Directory links are junctions on Windows (no privilege needed), so these cases also run there.
  const dirLink = (target, at) => fs.symlinkSync(posix ? target : path.resolve(path.dirname(at), target), at, posix ? 'dir' : 'junction');
  const contained = (name, setUp, pattern) => check(`links: ${name}`, () => {
    const space = path.join(workspace, `space${counter++}`);
    const dir = path.join(space, 'proj');
    fs.mkdirSync(path.join(dir, '.agents', 'skills', 'safe-change'), { recursive: true });
    write(dir, '.agents/skills/safe-change/SKILL.md', 'skill\n');
    write(space, 'outside/.claude/settings.json', '{\n  "theme": "dark"\n}\n');
    write(space, 'outside/notes.txt', 'outside notes\n');
    write(space, 'outside/CLAUDE.md', 'outside rules\n');
    setUp(dir);
    const before = snapshot(space);
    refuses(() => install(dir), pattern);
    assert.equal(snapshot(space), before, 'nothing may change inside or outside the project');
  });
  contained('external .claude directory', (dir) => dirLink('../outside/.claude', path.join(dir, '.claude')), /\.claude is a symbolic link or junction/);
  contained('external .claude/agent-kit directory', (dir) => { fs.mkdirSync(path.join(dir, '.claude')); dirLink('../../outside', path.join(dir, '.claude', 'agent-kit')); }, /\.claude\/agent-kit is a symbolic link or junction/);
  contained('internal .claude directory link (links are never written through)', (dir) => { fs.mkdirSync(path.join(dir, 'config')); dirLink('config', path.join(dir, '.claude')); }, /\.claude is a symbolic link or junction/);
  contained('external .agents directory', (dir) => { fs.rmSync(path.join(dir, '.agents'), { recursive: true }); fs.cpSync(path.join(dir, '..', 'outside'), path.join(dir, '..', 'outside-agents'), { recursive: true }); fs.mkdirSync(path.join(dir, '..', 'outside-agents', 'skills')); dirLink('../outside-agents', path.join(dir, '.agents')); }, /\.agents is a symbolic link or junction/);
  if (posix) {
    contained('external .claude/settings.json', (dir) => { fs.mkdirSync(path.join(dir, '.claude')); fs.symlinkSync('../../outside/.claude/settings.json', path.join(dir, '.claude', 'settings.json')); }, /settings\.json is a symbolic link or junction/);
    contained('external .gitignore', (dir) => fs.symlinkSync('../outside/notes.txt', path.join(dir, '.gitignore')), /\.gitignore is a link that leads outside the project/);
    contained('.gitignore reaching outside through a linked directory', (dir) => { dirLink('../outside', path.join(dir, 'shared')); fs.symlinkSync('shared/notes.txt', path.join(dir, '.gitignore')); }, /\.gitignore is a link that leads outside the project/);
    contained('external CLAUDE.md', (dir) => fs.symlinkSync('../outside/CLAUDE.md', path.join(dir, 'CLAUDE.md')), /CLAUDE\.md is a link that leads outside the project/);
    contained('broken CLAUDE.md link', (dir) => fs.symlinkSync('missing.md', path.join(dir, 'CLAUDE.md')), /CLAUDE\.md is a broken or circular link/);
    contained('broken .gitignore link', (dir) => fs.symlinkSync('missing', path.join(dir, '.gitignore')), /\.gitignore is a broken or circular link/);
    check('links: internal .gitignore and CLAUDE.md links are kept and used; second run is a no-op', () => {
      const dir = project();
      write(dir, 'config/gitignore', 'node_modules\n');
      write(dir, 'config/CLAUDE.md', '@AGENTS.md\n');
      fs.symlinkSync('config/gitignore', path.join(dir, '.gitignore'));
      fs.symlinkSync('config/CLAUDE.md', path.join(dir, 'CLAUDE.md'));
      install(dir);
      assert.equal(fs.readlinkSync(path.join(dir, '.gitignore')), 'config/gitignore');
      assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'config/CLAUDE.md');
      assert.match(read(dir, 'config/gitignore'), /^node_modules\n# Agent Kit: .*\n\/\.claude\/skills\n$/);
      const before = snapshot(dir);
      install(dir);
      assert.equal(snapshot(dir), before);
    });
  } else skipped.push('file symlink containment cases (need symlink privilege on Windows)');

  check('inspect reports states without mutating', () => {
    const dir = project();
    assert.equal(inspectSkillsLink(dir).state, 'missing');
    assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  });

  console.log(`Validated ${checks} Claude adapter checks (ownership, bridge, bootstrap, settings merge, gitignore, adapter install, link containment).${skipped.length ? ` Not exercised on this host: ${skipped.join('; ')}.` : ''}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
