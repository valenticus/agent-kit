// Agent Kit Claude Code adapter installer step. Called by install.ps1 for -Tools claude.
//   node claude-adapter.mjs preflight --project <dir>   validate only; writes nothing
//   node claude-adapter.mjs install   --project <dir>   preflight, then write
// Philosophy matches the installer: never overwrite or delete user files; refuse with an actionable message.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BootstrapError, assertCanonicalSkills, ensureSkillsLink, inspectSkillsLink } from '../../adapters/claude/claude-bootstrap.mjs';

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
  const text = existing.replace(/^﻿/, '');
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
  return { action: 'merge', content };
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
  for (const dir of [claudeDir, path.join(claudeDir, 'agent-kit')]) {
    try { if (!fs.statSync(dir).isDirectory()) refuse(`${dir} exists but is not a directory.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const link = inspectSkillsLink(project);
  if (!['missing', 'correct'].includes(link.state)) {
    refuse(`${link.link} already exists (${link.state}) and is not the Agent Kit link to .agents/skills. Resolve it manually; it is never overwritten.`);
  }
  return {
    claudeMd: planClaudeMd(readIfPresent(path.join(project, 'CLAUDE.md'), 'utf8'), template),
    bootstrap: planBootstrapFile(readIfPresent(path.join(project, BOOTSTRAP_RELATIVE)), canonicalBootstrap),
    settings: planSettings(readIfPresent(path.join(claudeDir, 'settings.json'), 'utf8')),
    gitignore: planGitignore(readIfPresent(path.join(project, '.gitignore'), 'utf8')),
    canonicalBootstrap,
  };
}

export function preflight(projectRoot) {
  plan(path.resolve(projectRoot));
}

export function install(projectRoot) {
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
  if (steps.bootstrap.action === 'create') { write(BOOTSTRAP_RELATIVE, steps.canonicalBootstrap); report.push(`created ${BOOTSTRAP_RELATIVE}`); }
  if (steps.settings.action !== 'noop') {
    const target = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.agent-kit-tmp`;
    fs.writeFileSync(temp, steps.settings.content);
    fs.renameSync(temp, target);
    report.push(`${steps.settings.action === 'create' ? 'created' : 'merged SessionStart hook into'} .claude/settings.json`);
  }
  if (steps.claudeMd.action === 'create') { write('CLAUDE.md', steps.claudeMd.content, 'wx'); report.push('created CLAUDE.md'); }
  if (steps.gitignore.action === 'create') { write('.gitignore', steps.gitignore.content, 'wx'); report.push(`created .gitignore with ${GITIGNORE_ENTRY}`); }
  if (steps.gitignore.action === 'append') { fs.appendFileSync(path.join(project, '.gitignore'), steps.gitignore.content); report.push(`added ${GITIGNORE_ENTRY} to .gitignore`); }
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
