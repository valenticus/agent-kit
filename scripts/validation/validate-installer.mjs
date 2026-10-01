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

const shell = await execFileAsync('powershell', ['-NoProfile', '-Command', 'exit 0']).then(() => 'powershell', () => 'pwsh');

// skills === null selects the explicit -NoSkills switch instead of -Skills.
async function runInstall(project, tools, extra = [], skills = 'safe-change') {
  const skillArgs = skills === null ? ['-NoSkills'] : ['-Skills', skills];
  return execFileAsync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', project, '-Tools', tools.join(','), ...skillArgs, ...extra]);
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

  const visualizationProject = path.join(workspace, 'data-visualization');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(visualizationProject));
  await runInstall(visualizationProject, ['codex', 'cline', 'kilo', 'copilot'], [], 'data-visualization');
  await execFileAsync(process.execPath, [installValidator, visualizationProject]);
  const canonicalVisualization = path.join(root, 'core', 'skills', 'data-visualization');
  for (const relative of ['SKILL.md', 'references/accessibility.md', 'references/chart-selection.md', 'references/responsive-interaction.md', 'references/validation-and-anti-patterns.md', 'references/visual-composition.md', 'references/visual-encoding.md']) {
    const canonical = await readFile(path.join(canonicalVisualization, relative));
    const shared = await readFile(path.join(visualizationProject, '.agents', 'skills', 'data-visualization', relative));
    const clineMirror = await readFile(path.join(visualizationProject, '.cline', 'skills', 'data-visualization', relative));
    if (!canonical.equals(shared) || !shared.equals(clineMirror)) throw new Error(`data-visualization/${relative}: installed copies differ from canonical source`);
  }

  // Claude adapter: opt-in, reuses the single .agents/skills materialization, never overwrites, and is idempotent when re-applied.
  const claudeOnly = path.join(workspace, 'claude-only');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(claudeOnly));
  await runInstall(claudeOnly, ['claude']);
  await execFileAsync(process.execPath, [installValidator, claudeOnly]);
  for (const relative of ['CLAUDE.md', '.claude/settings.json', '.claude/agent-kit/claude-bootstrap.mjs', '.agents/skills/safe-change/SKILL.md', '.claude/skills/safe-change/SKILL.md']) {
    if (!await exists(path.join(claudeOnly, relative))) throw new Error(`claude-only: missing ${relative}`);
  }
  if (await exists(path.join(claudeOnly, '.cline')) || await exists(path.join(claudeOnly, '.github')) || await exists(path.join(claudeOnly, '.kilo'))) throw new Error('claude-only install gained other adapter output');
  if ((await readdir(path.join(claudeOnly, '.agents', 'skills'))).join() !== 'safe-change') throw new Error('claude-only: shared skills not materialized exactly once');
  let refusedClaudeRepeat = false;
  try { await runInstall(claudeOnly, ['claude']); } catch { refusedClaudeRepeat = true; }
  if (!refusedClaudeRepeat) throw new Error('claude: repeated install with skills did not preserve overwrite safety');
  await runInstall(claudeOnly, ['claude'], [], null);
  await execFileAsync(process.execPath, [installValidator, claudeOnly]);

  const claudeAll = path.join(workspace, 'claude-all');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(claudeAll));
  await runInstall(claudeAll, ['codex', 'cline', 'kilo', 'copilot', 'claude'], [], 'safe-change,debugging');
  await execFileAsync(process.execPath, [installValidator, claudeAll]);
  if ((await readdir(path.join(claudeAll, '.agents', 'skills'))).sort().join() !== 'debugging,safe-change') throw new Error('claude-all: selected skills not exposed exactly');

  for (const tools of [['codex'], ['copilot'], ['codex', 'cline', 'kilo', 'copilot']]) {
    const project = path.join(workspace, `no-claude-${tools.join('-')}`);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(project));
    await runInstall(project, tools);
    if (await exists(path.join(project, '.claude')) || await exists(path.join(project, 'CLAUDE.md')) || await exists(path.join(project, '.gitignore'))) throw new Error(`${tools}: Claude files created without opt-in`);
  }

  // -NoSkills: adds Claude to an already-installed project through the real `powershell -File` argument path.
  const noSkills = path.join(workspace, 'no-skills');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(noSkills));
  await runInstall(noSkills, ['codex']);
  await runInstall(noSkills, ['claude'], [], null);
  await execFileAsync(process.execPath, [installValidator, noSkills]);
  if (!await exists(path.join(noSkills, '.claude', 'skills', 'safe-change', 'SKILL.md'))) throw new Error('-NoSkills: Claude link does not expose existing skills');
  if ((await readdir(path.join(noSkills, '.agents', 'skills'))).join() !== 'safe-change') throw new Error('-NoSkills: skills were modified');
  await runInstall(noSkills, ['claude'], [], null);
  let ambiguous = false;
  try { await runInstall(noSkills, ['claude'], ['-Skills', 'debugging'], null); } catch { ambiguous = true; }
  if (!ambiguous) throw new Error('-NoSkills combined with -Skills was accepted');

  // Global preflight: a predictable conflict must fail before the first mutation and leave the project byte-identical.
  async function snapshot(dir) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const full = path.join(entry.parentPath, entry.name);
      result.push(`${path.relative(dir, full)}${entry.isFile() ? `:${(await readFile(full)).toString('base64')}` : ''}`);
    }
    return result.sort().join('\n');
  }
  const { mkdir, writeFile } = await import('node:fs/promises');
  const conflicts = [
    ['later skill conflict', ['codex'], 'safe-change,debugging', [], async (p) => mkdir(path.join(p, '.agents', 'skills', 'debugging'), { recursive: true })],
    ['later skill conflict in Cline destination', ['cline'], 'safe-change,debugging', [], async (p) => mkdir(path.join(p, '.cline', 'skills', 'debugging'), { recursive: true })],
    ['Cline conflict with shared destinations free', ['codex', 'cline'], 'safe-change', [], async (p) => mkdir(path.join(p, '.cline', 'skills', 'safe-change'), { recursive: true })],
    ['Kilo agent conflict', ['kilo'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.kilo', 'agents'), { recursive: true }); await writeFile(path.join(p, '.kilo', 'agents', 'project-designer.md'), 'mine'); }],
    ['Copilot instructions conflict', ['codex', 'copilot'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.github'), { recursive: true }); await writeFile(path.join(p, '.github', 'copilot-instructions.md'), 'mine'); }],
    ['Copilot auditor conflict', ['codex', 'copilot'], 'safe-change', ['-CopilotAuditor'], async (p) => { await mkdir(path.join(p, '.github', 'agents'), { recursive: true }); await writeFile(path.join(p, '.github', 'agents', 'project-auditor.agent.md'), 'mine'); }],
    ['Claude CLAUDE.md conflict', ['codex', 'claude'], 'safe-change', [], async (p) => writeFile(path.join(p, 'CLAUDE.md'), 'own rules without import\n')],
    ['Claude without canonical skills', ['codex', 'claude'], null, [], async (p) => writeFile(path.join(p, 'keep.txt'), 'x')],
    ['unknown later skill', ['codex', 'kilo'], 'safe-change,not-a-skill', [], async () => {}],
  ];
  for (const [name, tools, skills, extraArgs, seed] of conflicts) {
    const project = path.join(workspace, `preflight-${name.replaceAll(' ', '-')}`);
    await mkdir(project);
    await seed(project);
    const before = await snapshot(project);
    let failed = false;
    try { await runInstall(project, tools, extraArgs, skills); } catch { failed = true; }
    if (!failed) throw new Error(`${name}: install unexpectedly succeeded`);
    if (await snapshot(project) !== before) throw new Error(`${name}: failed install left a partial installation`);
  }

  console.log(`Validated ${combinations.length} Copilot combinations, 3 legacy tool modes, overwrite safety, shared destinations, mirrors, optional auditor behavior, opt-in data-visualization distribution, the opt-in Claude adapter, -NoSkills, and zero-mutation global preflight.`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
