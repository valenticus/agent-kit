import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = path.join(root, 'scripts', 'install', 'install.ps1');
const installValidator = path.join(root, 'scripts', 'validation', 'validate-install.mjs');
const workspace = await mkdtemp(path.join(tmpdir(), 'agent-kit-copilot-'));
const combinations = [
  ['copilot'],
  ['codex', 'copilot'],
  ['kilo', 'copilot'],
  ['cline', 'copilot'],
  ['codex', 'cline', 'kilo', 'copilot'],
];

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function runInstall(project, tools, extra = []) {
  return execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', project, '-Tools', tools.join(','), '-Skills', 'safe-change', ...extra]);
}

try {
  for (const tools of combinations) {
    const project = path.join(workspace, tools.join('-'));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(project));
    await runInstall(project, tools);
    await execFileAsync(process.execPath, [installValidator, project]);

    const sharedSkill = path.join(project, '.agents', 'skills', 'safe-change', 'SKILL.md');
    if (!await exists(sharedSkill)) throw new Error(`${tools}: missing shared skill`);
    if (!await exists(path.join(project, '.github', 'copilot-instructions.md'))) throw new Error(`${tools}: missing Copilot instructions`);
    if (await exists(path.join(project, '.github', 'skills'))) throw new Error(`${tools}: unexpected Copilot skill mirror`);
    if (await exists(path.join(project, '.kilo', 'skills'))) throw new Error(`${tools}: unexpected Kilo skill mirror`);
    if (await exists(path.join(project, '.github', 'agents', 'project-auditor.agent.md'))) throw new Error(`${tools}: auditor installed without opt-in`);

    const sharedEntries = await readdir(path.join(project, '.agents', 'skills'));
    if (sharedEntries.length !== 1 || sharedEntries[0] !== 'safe-change') throw new Error(`${tools}: shared skill destination was not materialized exactly once`);
    if (tools.includes('cline')) {
      const shared = await readFile(sharedSkill);
      const mirror = await readFile(path.join(project, '.cline', 'skills', 'safe-change', 'SKILL.md'));
      if (!shared.equals(mirror)) throw new Error(`${tools}: Cline mirror differs`);
    } else if (await exists(path.join(project, '.cline'))) throw new Error(`${tools}: unexpected Cline output`);
    if (tools.includes('kilo') !== await exists(path.join(project, '.kilo', 'agents', 'project-designer.md'))) throw new Error(`${tools}: incorrect Kilo agent output`);

    let refusedOverwrite = false;
    try { await runInstall(project, tools); } catch { refusedOverwrite = true; }
    if (!refusedOverwrite) throw new Error(`${tools}: repeated install did not preserve overwrite safety`);
  }

  for (const tool of ['codex', 'cline', 'kilo']) {
    const project = path.join(workspace, `legacy-${tool}`);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(project));
    await runInstall(project, [tool]);
    if (tool === 'cline') {
      if (!await exists(path.join(project, '.cline', 'skills', 'safe-change', 'SKILL.md'))) throw new Error('Cline-only behavior changed');
      if (await exists(path.join(project, '.agents'))) throw new Error('Cline-only install unexpectedly gained shared output');
    } else if (!await exists(path.join(project, '.agents', 'skills', 'safe-change', 'SKILL.md'))) throw new Error(`${tool}-only shared output changed`);
    if (tool === 'kilo' && !await exists(path.join(project, '.kilo', 'agents', 'project-designer.md'))) throw new Error('Kilo-only agent behavior changed');
    if (await exists(path.join(project, '.github'))) throw new Error(`${tool}-only install unexpectedly gained Copilot output`);
  }

  const auditorProject = path.join(workspace, 'copilot-auditor');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(auditorProject));
  await runInstall(auditorProject, ['copilot'], ['-CopilotAuditor']);
  if (!await exists(path.join(auditorProject, '.github', 'agents', 'project-auditor.agent.md'))) throw new Error('opt-in Copilot auditor was not installed');

  const invalidAuditorProject = path.join(workspace, 'invalid-auditor');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(invalidAuditorProject));
  let rejectedInvalidAuditor = false;
  try { await runInstall(invalidAuditorProject, ['codex'], ['-CopilotAuditor']); } catch { rejectedInvalidAuditor = true; }
  if (!rejectedInvalidAuditor) throw new Error('Copilot auditor accepted without the Copilot tool');

  console.log(`Validated ${combinations.length} Copilot combinations, 3 legacy tool modes, overwrite safety, shared destinations, mirrors, and optional auditor behavior.`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
