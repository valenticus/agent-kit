import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(process.argv[2] ?? '.');
const agents = path.join(project, '.agents', 'skills');
const cline = path.join(project, '.cline', 'skills');
let checked = 0;
async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}
try {
  if (!await exists(agents)) throw new Error('missing shared .agents/skills materialization');
  if (await exists(cline)) {
    for (const entry of await readdir(cline, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentRoot = path.join(agents, entry.name);
      const clineRoot = path.join(cline, entry.name);
      const agentFiles = await filesUnder(agentRoot);
      const clineFiles = await filesUnder(clineRoot);
      if (agentFiles.join('\n') !== clineFiles.join('\n')) throw new Error(`${entry.name}: shared/Cline file sets differ`);
      for (const relative of agentFiles) {
        const a = await readFile(path.join(agentRoot, relative));
        const c = await readFile(path.join(clineRoot, relative));
        if (!a.equals(c)) throw new Error(`${entry.name}/${relative}: shared/Cline mirrors differ`);
      }
      checked++;
    }
  }
  if (await exists(path.join(project, '.kilo', 'skills'))) throw new Error('unexpected .kilo/skills third mirror');
  if (await exists(path.join(project, '.github', 'skills'))) throw new Error('unexpected .github/skills Copilot mirror');
  const kiloAgentPath = path.join(project, '.kilo', 'agents', 'project-designer.md');
  if (await exists(kiloAgentPath)) {
    const kiloAgent = await readFile(kiloAgentPath, 'utf8');
    if (!/^---\r?\ndescription:/m.test(kiloAgent) || !/\r?\nmode:\s*primary\r?\n/.test(kiloAgent)) throw new Error('invalid Kilo designer agent frontmatter');
  }
  const claudeLink = path.join(project, '.claude', 'skills');
  const bootstrapPath = path.join(project, '.claude', 'agent-kit', 'claude-bootstrap.mjs');
  const claudeSettingsPath = path.join(project, '.claude', 'settings.json');
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  let claudeLinkStat = null;
  try { claudeLinkStat = await lstat(claudeLink); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (claudeLinkStat) {
    if (!claudeLinkStat.isSymbolicLink()) throw new Error('.claude/skills must be a generated link to .agents/skills, not a real directory or file');
    if (await realpath(claudeLink).catch(() => null) !== await realpath(agents)) throw new Error('.claude/skills does not resolve to .agents/skills');
  }
  if (await exists(bootstrapPath)) {
    const kitBootstrap = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters', 'claude', 'claude-bootstrap.mjs');
    if (!(await readFile(bootstrapPath)).equals(await readFile(kitBootstrap))) throw new Error('.claude/agent-kit/claude-bootstrap.mjs differs from the Agent Kit bootstrap');
    const claudeMd = await exists(claudeMdPath) ? await readFile(claudeMdPath, 'utf8') : '';
    if (!claudeMd.split(/\r?\n/).some((line) => line.trim() === '@AGENTS.md')) throw new Error('invalid Claude bridge: CLAUDE.md must import @AGENTS.md');
    let settings;
    try { settings = JSON.parse((await readFile(claudeSettingsPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('.claude/settings.json is missing or invalid JSON'); }
    const hooks = (settings?.hooks?.SessionStart ?? []).flatMap((group) => group?.hooks ?? []).filter((hook) => typeof hook?.command === 'string' && hook.command.includes('.claude/agent-kit/claude-bootstrap.mjs'));
    if (hooks.length !== 1) throw new Error(`expected exactly one Agent Kit SessionStart hook, found ${hooks.length}`);
    const gitignore = await exists(path.join(project, '.gitignore')) ? await readFile(path.join(project, '.gitignore'), 'utf8') : '';
    if (!gitignore.split(/\r?\n/).some((line) => ['/.claude/skills', '.claude/skills'].includes(line.trim()))) throw new Error('generated .claude/skills is not git-ignored');
  } else if (claudeLinkStat) throw new Error('.claude/skills exists without the Agent Kit Claude adapter bootstrap');
  const copilotInstructionsPath = path.join(project, '.github', 'copilot-instructions.md');
  if (await exists(copilotInstructionsPath)) {
    const instructions = await readFile(copilotInstructionsPath, 'utf8');
    if (!/AGENTS\.md/.test(instructions) || !/\.agents\/skills/.test(instructions)) throw new Error('invalid Copilot instruction bridge');
  }
  console.log(`Validated shared skills, ${checked} complete Cline mirrors, present native adapters (including the Claude adapter), and no unnecessary skill mirrors.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
