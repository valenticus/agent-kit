import { lstatSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { isAgentKitHook } = await import(pathToFileURL(path.join(kitRoot, 'scripts', 'install', 'claude-adapter.mjs')).href);
const { normalizeEol, policyLabel, policyStatus } = await import(pathToFileURL(path.join(kitRoot, 'scripts', 'install', 'policy-block.mjs')).href);
const { normalizedHash } = await import(pathToFileURL(path.join(kitRoot, 'scripts', 'install', 'skill-catalog.mjs')).href);
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
  const leftovers = ['.agent-kit-update.lock', '.agents/.agent-kit-update', '.cline/.agent-kit-update'].filter((rel) => { try { lstatSync(path.join(project, rel)); return true; } catch { return false; } });
  if (leftovers.length) throw new Error(`an Agent Kit skill update is running or was interrupted (${leftovers.join(', ')}); run install.ps1 -RecoverSkillUpdate`);
  if (await exists(cline)) {
    for (const entry of await readdir(cline, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentRoot = path.join(agents, entry.name);
      const clineRoot = path.join(cline, entry.name);
      const agentFiles = await filesUnder(agentRoot);
      const clineFiles = await filesUnder(clineRoot);
      if (agentFiles.join('\n') !== clineFiles.join('\n')) throw new Error(`${entry.name}: shared/Cline file sets differ`);
      // Same identity as the skill catalog: content after CRLF -> LF, so autocrlf checkouts do not count as differences.
      for (const relative of agentFiles) {
        const a = await readFile(path.join(agentRoot, relative));
        const c = await readFile(path.join(clineRoot, relative));
        if (normalizedHash(a) !== normalizedHash(c)) throw new Error(`${entry.name}/${relative}: shared/Cline mirrors differ`);
      }
      checked++;
    }
    // Every skill the kit distributes (core or vendored optional) that is in .agents/skills must also be mirrored for
    // Cline. Project-owned skills and referenced modules are installed outside the kit and are not required here.
    const catalog = JSON.parse(await readFile(path.join(kitRoot, 'optional', 'catalog.json'), 'utf8'));
    const distributed = new Set([
      ...(await readdir(path.join(kitRoot, 'core', 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      ...Object.entries(catalog).filter(([, module]) => module.kind === 'vendored').map(([name]) => name),
    ]);
    const missing = [];
    for (const entry of await readdir(agents, { withFileTypes: true })) {
      if (entry.isDirectory() && distributed.has(entry.name) && !await exists(path.join(cline, entry.name))) missing.push(entry.name);
    }
    if (missing.length) throw new Error(`.cline/skills lacks Agent Kit skills present in .agents/skills: ${missing.sort().join(', ')}; install them with -Tools cline`);
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
    const kitBootstrap = path.join(kitRoot, 'adapters', 'claude', 'claude-bootstrap.mjs');
    if (!(await readFile(bootstrapPath)).equals(await readFile(kitBootstrap))) throw new Error('.claude/agent-kit/claude-bootstrap.mjs differs from the Agent Kit bootstrap');
    const claudeMd = await exists(claudeMdPath) ? await readFile(claudeMdPath, 'utf8') : '';
    if (!claudeMd.split(/\r?\n/).some((line) => line.trim() === '@AGENTS.md')) throw new Error('invalid Claude bridge: CLAUDE.md must import @AGENTS.md');
    let settings;
    try { settings = JSON.parse((await readFile(claudeSettingsPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('.claude/settings.json is missing or invalid JSON'); }
    const hooks = (settings?.hooks?.SessionStart ?? []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).filter(isAgentKitHook);
    if (hooks.length !== 1) throw new Error(`expected exactly one Agent Kit SessionStart hook, found ${hooks.length}`);
    const gitignore = await exists(path.join(project, '.gitignore')) ? await readFile(path.join(project, '.gitignore'), 'utf8') : '';
    if (!gitignore.split(/\r?\n/).some((line) => ['/.claude/skills', '.claude/skills'].includes(line.trim()))) throw new Error('generated .claude/skills is not git-ignored');
  } else if (claudeLinkStat) throw new Error('.claude/skills exists without the Agent Kit Claude adapter bootstrap');
  const agentsMdPath = path.join(project, 'AGENTS.md');
  if (!await exists(agentsMdPath)) console.warn('warning: no root AGENTS.md; run install.ps1 -UpdatePolicies to add the canonical managed policies');
  else {
    const agentsMd = normalizeEol(await readFile(agentsMdPath, 'utf8'));
    for (const { policy, state } of policyStatus(agentsMd, kitRoot)) { // throws on malformed or overlapping markers
      if (state === 'missing') console.warn(`warning: AGENTS.md lacks the managed ${policyLabel(policy)} block; run install.ps1 -UpdatePolicies`);
      else if (state === 'stale') console.warn(`warning: AGENTS.md ${policyLabel(policy)} block is stale; run install.ps1 -UpdatePolicies`);
    }
  }
  const copilotInstructionsPath = path.join(project, '.github', 'copilot-instructions.md');
  if (await exists(copilotInstructionsPath)) {
    const instructions = await readFile(copilotInstructionsPath, 'utf8');
    if (!/AGENTS\.md/.test(instructions) || !/\.agents\/skills/.test(instructions)) throw new Error('invalid Copilot instruction bridge');
  }
  console.log(`Validated shared skills, ${checked} complete Cline mirrors, present native adapters (including the Claude adapter), and no unnecessary skill mirrors.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
