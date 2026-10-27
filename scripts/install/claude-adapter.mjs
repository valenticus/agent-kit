// Agent Kit Claude Code adapter installer step. Called by install.ps1 for -Tools claude.
//   node claude-adapter.mjs preflight --project <dir>   validate only; writes nothing
//   node claude-adapter.mjs install   --project <dir>   preflight, then write
// Philosophy matches the installer: never overwrite or delete user files; refuse with an actionable message.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BootstrapError, assertCanonicalSkills, ensureSkillsLink, inspectSkillsLink } from '../../adapters/claude/claude-bootstrap.mjs';
import { ProjectPathError, inspectProjectPath } from './project-path.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BOOTSTRAP_RELATIVE = '.claude/agent-kit/claude-bootstrap.mjs';
export const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${BOOTSTRAP_RELATIVE}"`;
export const GITIGNORE_ENTRY = '/.claude/skills';
const GITIGNORE_COMMENT = '# Agent Kit: generated Claude Code skills link (never commit)';
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const BRIDGE_LINE = '@AGENTS.md';

// Single definition of "this is the Agent Kit hook": exact structure, type, and command. Shared with validate-install.
export const isAgentKitHook = (hook) => isPlainObject(hook) && hook.type === 'command' && hook.command === HOOK_COMMAND;

export class AdapterRefusal extends Error {}
const refuse = (message) => { throw new AdapterRefusal(message); };

function readIfPresent(file, encoding) {
  try { return fs.readFileSync(file, encoding); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}


export function planClaudeMd(existing, template) {
  if (existing === null) return { action: 'create', content: template };
  if (existing.split(/\r?\n/).some((line) => line.trim() === BRIDGE_LINE)) return { action: 'noop' };
  return refuse(`CLAUDE.md already exists without an "${BRIDGE_LINE}" import. Add "${BRIDGE_LINE}" to it manually (or merge your rules into AGENTS.md); it is never overwritten.`);
}

export function planBootstrapFile(existing, canonical) {
  if (existing === null) return { action: 'create' };
  if (existing.equals(canonical)) return { action: 'noop' };
  return refuse(`${BOOTSTRAP_RELATIVE} already exists and differs from the Agent Kit bootstrap. Review and replace it manually; it is never overwritten.`);
}

export function planSettings(existing) {
  const manual = `Add a SessionStart command hook "${HOOK_COMMAND}" to .claude/settings.json manually.`;
  const entry = { hooks: [{ type: 'command', command: HOOK_COMMAND }] };
  if (existing === null) return { action: 'create', content: `${JSON.stringify({ hooks: { SessionStart: [entry] } }, null, 2)}\n` };
  const bom = existing.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = existing.slice(bom.length);
  let data;
  try { data = JSON.parse(text); } catch (error) { return refuse(`.claude/settings.json is not strict JSON (${error.message}); refusing to rewrite it. ${manual}`); }
  if (!isPlainObject(data)) return refuse(`.claude/settings.json is not a JSON object. ${manual}`);
  if (data.hooks !== undefined && !isPlainObject(data.hooks)) return refuse(`.claude/settings.json "hooks" is not an object. ${manual}`);
  const sessionStart = data.hooks?.SessionStart;
  if (sessionStart !== undefined && !Array.isArray(sessionStart)) return refuse(`.claude/settings.json "hooks.SessionStart" is not an array. ${manual}`);
  const present = (sessionStart ?? []).some((group) => isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.some(isAgentKitHook));
  if (present) return { action: 'noop' };
  data.hooks = { ...(data.hooks ?? {}), SessionStart: [...(sessionStart ?? []), entry] };
  const indent = /^(\t+|[ ]+)"/m.exec(text)?.[1] ?? '  ';
  let content = `${JSON.stringify(data, null, indent)}\n`;
  if (text.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
  return { action: 'merge', content: `${bom}${content}` };
}

export function planGitignore(existing) {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  if (existing !== null && existing.split(/\r?\n/).some((line) => ['/.claude/skills', '.claude/skills'].includes(line.trim()))) return { action: 'noop' };
  // No trailing slash: a symlink/junction is not a directory to Git, so ".claude/skills/" would not match it.
  const addition = `${GITIGNORE_COMMENT}${eol}${GITIGNORE_ENTRY}${eol}`;
  if (existing === null || existing === '') return { action: existing === null ? 'create' : 'append', content: addition };
  return { action: 'append', content: `${existing.endsWith('\n') ? '' : eol}${addition}` };
}

function plan(project) {
  const canonicalBootstrap = fs.readFileSync(path.join(kitRoot, 'adapters', 'claude', 'claude-bootstrap.mjs'));
  const template = fs.readFileSync(path.join(kitRoot, 'adapters', 'claude', 'CLAUDE.template.md'), 'utf8');
  const claudeDir = path.join(project, '.claude');
  // Nothing the adapter reads or writes may lead outside the project: .claude, its files, and the canonical skills
  // must be real directories and files. CLAUDE.md and .gitignore may be links that stay inside the project.
  const at = (relative, options) => {
    try { return inspectProjectPath(project, relative, options); } catch (error) {
      if (error instanceof ProjectPathError) refuse(error.message);
      throw error;
    }
  };
  for (const dir of ['.claude', '.claude/agent-kit', '.agents', '.agents/skills']) at(dir, { type: 'dir' });
  for (const file of [BOOTSTRAP_RELATIVE, '.claude/settings.json']) at(file, { type: 'file' });
  at('CLAUDE.md', { type: 'file', allowInternalLink: true });
  const gitignore = at('.gitignore', { type: 'file', allowInternalLink: true });
  const link = inspectSkillsLink(project);
  if (!['missing', 'correct'].includes(link.state)) {
    refuse(`${link.link} already exists (${link.state}) and is not the Agent Kit link to .agents/skills. Resolve it manually; it is never overwritten.`);
  }
  const gitignoreText = readIfPresent(path.join(project, '.gitignore'), 'utf8');
  return {
    claudeMd: planClaudeMd(readIfPresent(path.join(project, 'CLAUDE.md'), 'utf8'), template),
    bootstrap: planBootstrapFile(readIfPresent(path.join(project, BOOTSTRAP_RELATIVE)), canonicalBootstrap),
    settings: planSettings(readIfPresent(path.join(claudeDir, 'settings.json'), 'utf8')),
    gitignore: { ...planGitignore(gitignoreText), file: gitignore.real, existing: gitignoreText },
    canonicalBootstrap,
  };
}

export function preflight(projectRoot) {
  plan(path.resolve(projectRoot));
}

// Replaces a file through a uniquely named temp file beside it. The temp file is created exclusively (never
// replacing another file) and removed only if this call created it, so a failure leaves the original untouched. The
// target gets a new inode, so a hard link to it (possibly outside the project) keeps its old content. With `mode`,
// the original permission bits are kept.
function replaceFile(target, content, fsImpl, mode) {
  const temp = `${target}.agent-kit-${process.pid}-${Date.now()}.tmp`;
  let created = false;
  try {
    const fd = fsImpl.openSync(temp, 'wx');
    created = true;
    try { fsImpl.writeFileSync(fd, content); } finally { fsImpl.closeSync(fd); }
    if (mode !== undefined) fsImpl.chmodSync(temp, mode);
    fsImpl.renameSync(temp, target);
    created = false;
  } finally {
    if (created) try { fsImpl.unlinkSync(temp); } catch { /* already gone */ }
  }
}

export function install(projectRoot, { fsImpl = fs } = {}) {
  const project = path.resolve(projectRoot);
  const steps = plan(project);
  // Check the canonical skills before writing anything so a broken adapter is never created.
  assertCanonicalSkills(project);
  const report = [];
  const write = (relative, content, flag = 'w') => {
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag });
  };
  // .gitignore first, so that if it cannot be replaced safely nothing else has been written yet. It is never appended
  // in place: every existing byte is kept, the Agent Kit lines follow, and the result replaces the real file by rename,
  // so a hard link to a file outside the project is not changed.
  if (steps.gitignore.action === 'append') {
    const file = steps.gitignore.file;
    const existing = fs.readFileSync(file);
    if (existing.toString('utf8') !== steps.gitignore.existing) refuse('.gitignore changed while Agent Kit was installing; it was left unchanged. Run the installer again.');
    try { replaceFile(file, Buffer.concat([existing, Buffer.from(steps.gitignore.content, 'utf8')]), fsImpl, fs.statSync(file).mode & 0o7777); } catch (error) {
      refuse(`Could not replace .gitignore safely (${error.code ?? error.message}); it was left unchanged and nothing else was written. Add "${GITIGNORE_ENTRY}" to it manually, or fix its permissions, and run the installer again.`);
    }
    report.push(`added ${GITIGNORE_ENTRY} to .gitignore`);
  }
  if (steps.gitignore.action === 'create') { write('.gitignore', steps.gitignore.content, 'wx'); report.push(`created .gitignore with ${GITIGNORE_ENTRY}`); }
  if (steps.bootstrap.action === 'create') { write(BOOTSTRAP_RELATIVE, steps.canonicalBootstrap); report.push(`created ${BOOTSTRAP_RELATIVE}`); }
  if (steps.settings.action !== 'noop') {
    const target = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    replaceFile(target, steps.settings.content, fsImpl);
    report.push(`${steps.settings.action === 'create' ? 'created' : 'merged SessionStart hook into'} .claude/settings.json`);
  }
  if (steps.claudeMd.action === 'create') { write('CLAUDE.md', steps.claudeMd.content, 'wx'); report.push('created CLAUDE.md'); }
  const linked = ensureSkillsLink(project);
  report.push(`${linked.status} .claude/skills link`);
  return report;
}

function main(argv) {
  const [command] = argv;
  const flag = argv.indexOf('--project');
  const project = flag >= 0 ? argv[flag + 1] : undefined;
  if (!['preflight', 'install'].includes(command) || !project) { console.error('usage: claude-adapter.mjs <preflight|install> --project <dir>'); return 2; }
  try {
    if (command === 'preflight') preflight(project);
    else for (const line of install(project)) console.log(`Claude adapter: ${line}`);
    return 0;
  } catch (error) {
    if (error instanceof AdapterRefusal || error instanceof BootstrapError) { console.error(`Claude adapter refused: ${error.message}`); return 1; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
