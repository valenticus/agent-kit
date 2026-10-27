import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { testInstallPaths } from './install-path-tests.mjs';
import { testSkillApply } from './skill-apply-tests.mjs';
import { testSkillUpdateCli } from './skill-update-cli-tests.mjs';
import { testSkillCatalogAndPlanner } from './skill-update-tests.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = path.join(root, 'scripts', 'install', 'install.ps1');
const installValidator = path.join(root, 'scripts', 'validation', 'validate-install.mjs');
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

function normalizeErrorOutput(output) {
  // PowerShell's wrapped error lines can carry a presentation gutter after ANSI styling.
  return stripVTControlCharacters(output).replace(/^\s*\|\s?/gm, '').replace(/\s+/g, ' ').trim();
}

function errorDiagnostic(output) {
  const limit = 4096;
  if (output.length <= limit) return output;
  return `${output.slice(0, limit / 2)} ... [${output.length - limit} characters omitted] ... ${output.slice(-limit / 2)}`;
}

// Asserts the specific refusal reason, not merely a non-zero exit or shortened message.
async function failsWith(promise, pattern, label) {
  try { await promise; } catch (error) {
    const output = normalizeErrorOutput(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`);
    if (!pattern.test(output)) throw new Error(`${label}: expected ${pattern}; received: ${errorDiagnostic(output)}`);
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

async function testErrorOutput() {
  const expected = /standalone operation and cannot be combined with -Tools/;
  const refusal = 'standalone operation and cannot be combined with -Tools';
  const rejected = (stderr) => Promise.reject(Object.assign(new Error('command failed'), { stderr }));
  assert.equal(normalizeErrorOutput('\u001b[31mhello\u001b[0m\r\n\t world'), 'hello world');
  await failsWith(rejected(refusal), expected, 'plain refusal');
  await failsWith(rejected('\u001b[31;1m| standalone operation and\u001b[0m\r\n\u001b[31m| cannot be combined\n| with -Tools\u001b[0m'), expected, 'formatted refusal');
  await assert.rejects(failsWith(rejected(refusal.replace('-Tools', '-Skills')), expected, 'wrong reason'), /expected .*received:/);
  await assert.rejects(failsWith(rejected('standalone operation and cannot be combined with …'), expected, 'truncated refusal'), /expected .*received:/);
  await assert.rejects(failsWith(Promise.resolve(), expected, 'success'), /unexpectedly succeeded/);
  const diagnostic = errorDiagnostic('a'.repeat(5000) + ' decisive error at tail');
  assert.ok(diagnostic.length < 4200 && diagnostic.includes('characters omitted') && diagnostic.endsWith('decisive error at tail'));
  console.log('Validated PowerShell error normalization, strict refusal matching, and bounded diagnostics.');
}

await testErrorOutput();
if (process.argv.includes('--test-error-output')) process.exit(0);
await testSkillCatalogAndPlanner();
await testSkillApply();

let shell;
for (const executable of ['pwsh', 'powershell']) {
  try {
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    shell = executable;
    console.log(`PowerShell executable: ${shell}; version: ${stdout.trim()}`);
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (!shell) {
  console.error('BLOCKED: installer validation requires pwsh (PowerShell 7) or powershell (Windows PowerShell); neither executable was found.');
  process.exit(1);
}
// Pin the executable found on PATH to its absolute path, so the node-free PATH used below can never hide PowerShell
// (MacPorts, for example, installs node and pwsh in the same directory).
function resolveOnPath(name) {
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE').split(';').filter(Boolean)] : [''];
  for (const dir of (process.env[Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'] ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}
shell = resolveOnPath(shell) ?? shell;
console.log(`PowerShell path: ${shell}`);
await testSkillUpdateCli({ shell, failsWith });
await testInstallPaths({ shell, failsWith });
const workspace = await mkdtemp(path.join(tmpdir(), 'agent-kit-copilot-'));

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
    if (await exists(path.join(project, '.agents', 'skills', 'security-audit'))) throw new Error('security-audit installed without explicit optional selection');
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

  // Opt-in handoff skill: explicit -Skills handoff for all five tools; byte-identical shared copy, Cline mirror, and Claude
  // link exposure. The default selection check below keeps it out of default installs.
  const handoffProject = path.join(workspace, 'handoff');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(handoffProject));
  await runInstall(handoffProject, ['codex', 'cline', 'kilo', 'copilot', 'claude'], [], 'handoff');
  await execFileAsync(process.execPath, [installValidator, handoffProject]);
  const canonicalHandoff = await readFile(path.join(root, 'core', 'skills', 'handoff', 'SKILL.md'));
  for (const relative of ['.agents/skills/handoff/SKILL.md', '.cline/skills/handoff/SKILL.md', '.claude/skills/handoff/SKILL.md']) {
    if (!canonicalHandoff.equals(await readFile(path.join(handoffProject, relative)))) throw new Error(`handoff: ${relative} differs from the canonical skill`);
  }
  if ((await readdir(path.join(handoffProject, '.agents', 'skills'))).join() !== 'handoff') throw new Error('handoff: explicit selection installed other skills');

  // validate-install must notice a Cline mirror that lacks a kit skill present in .agents/skills (here: handoff added
  // without -Tools cline), and accept project-owned skills that the kit does not distribute.
  const partialMirror = path.join(workspace, 'partial-cline-mirror');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(partialMirror));
  await runInstall(partialMirror, ['codex', 'cline']);
  await runInstall(partialMirror, ['codex'], [], 'handoff');
  const partialBefore = await snapshot(partialMirror);
  await failsWith(execFileAsync(process.execPath, [installValidator, partialMirror]), /\.cline\/skills lacks Agent Kit skills present in \.agents\/skills: handoff/, 'partial Cline mirror');
  if (await snapshot(partialMirror) !== partialBefore) throw new Error('validate-install modified the project');
  await runInstall(partialMirror, ['cline'], [], 'handoff');
  const { mkdir: makeDir, writeFile: writeText } = await import('node:fs/promises');
  await makeDir(path.join(partialMirror, '.agents', 'skills', 'project-only'));
  await writeText(path.join(partialMirror, '.agents', 'skills', 'project-only', 'SKILL.md'), '---\nname: project-only\ndescription: x\n---\n');
  await execFileAsync(process.execPath, [installValidator, partialMirror]);

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
  // Real PowerShell installer checks; no model sessions or target execution.
  const defaultProject = path.join(workspace, 'default-selection');
  await mkdir(defaultProject);
  await execFileAsync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', defaultProject, '-Tools', 'codex']);
  const defaultNames = ['safe-change', 'debugging', 'final-audit', 'product-ux', 'mobile-design', 'design-critique', 'security', 'ui'].sort();
  if ((await readdir(path.join(defaultProject, '.agents', 'skills'))).sort().join() !== defaultNames.join()) throw new Error('default installation changed');
  for (const name of defaultNames) {
    const source = await readFile(path.join(root, 'core', 'skills', name, 'SKILL.md'));
    if (!source.equals(await readFile(path.join(defaultProject, '.agents', 'skills', name, 'SKILL.md')))) throw new Error(`${name}: default skill content changed`);
  }
  async function packageFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...await packageFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`));
      else files.push(`${prefix}${entry.name}`);
    }
    return files.sort();
  }
  const auditSource = path.join(root, 'optional', 'vendored', 'security-audit');
  const auditFiles = await packageFiles(auditSource);
  for (const tools of [['codex'], ['cline'], ['kilo'], ['copilot'], ['claude'], ['codex', 'cline', 'kilo', 'copilot', 'claude']]) {
    const project = path.join(workspace, `security-audit-${tools.join('-')}`);
    await mkdir(project);
    await writeFile(path.join(project, 'AGENTS.md'), '# Existing project rules\n');
    await runInstall(project, tools, ['-OptionalSkills', 'security-audit']);
    if (await readFile(path.join(project, 'AGENTS.md'), 'utf8') !== '# Existing project rules\n') throw new Error('optional install changed project instructions');
    const destinations = tools.includes('cline') ? ['.cline/skills/security-audit'] : [];
    if (tools.some((tool) => tool !== 'cline')) destinations.push('.agents/skills/security-audit');
    if (tools.includes('claude')) destinations.push('.claude/skills/security-audit');
    for (const destination of destinations) {
      const installed = path.join(project, destination);
      if ((await packageFiles(installed)).join('\n') !== auditFiles.join('\n')) throw new Error(`${destination}: incomplete optional package`);
      for (const file of auditFiles) {
        if (!(await readFile(path.join(auditSource, file))).equals(await readFile(path.join(installed, file)))) throw new Error(`${destination}/${file}: optional copy differs`);
      }
    }
    if (tools.includes('cline') && tools.length === 1 && await exists(path.join(project, '.agents'))) throw new Error('Cline-only optional install gained a shared copy');
    if (tools.some((tool) => tool !== 'cline')) await execFileAsync(process.execPath, [installValidator, project]);
    const before = await snapshot(project);
    let refused = false;
    try { await runInstall(project, tools, ['-OptionalSkills', 'security-audit']); }
    catch (error) {
      if (!/Refusing to overwrite/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) throw error;
      refused = true;
    }
    if (!refused || await snapshot(project) !== before) throw new Error('optional reinstall overwrote files or left partial changes');
    for (const unexpected of ['.kilo/skills', '.github/skills', 'REPORT.md', 'findings.json', 'coverage-ledger.json']) {
      if (await exists(path.join(project, unexpected))) throw new Error(`optional installation created ${unexpected}`);
    }
  }
  const conflicts = [
    ['optional shared conflict', ['codex', 'cline'], 'safe-change', ['-OptionalSkills', 'security-audit'], async (p) => { await mkdir(path.join(p, '.agents', 'skills', 'security-audit'), { recursive: true }); await writeFile(path.join(p, '.agents', 'skills', 'security-audit', 'keep.txt'), 'mine'); }],
    ['optional mirror conflict', ['codex', 'cline'], 'safe-change', ['-OptionalSkills', 'security-audit'], async (p) => { await mkdir(path.join(p, '.cline', 'skills', 'security-audit'), { recursive: true }); await writeFile(path.join(p, '.cline', 'skills', 'security-audit', 'keep.txt'), 'mine'); }],
    ['later skill conflict', ['codex'], 'safe-change,debugging', [], async (p) => mkdir(path.join(p, '.agents', 'skills', 'debugging'), { recursive: true })],
    ['later skill conflict in Cline destination', ['cline'], 'safe-change,debugging', [], async (p) => mkdir(path.join(p, '.cline', 'skills', 'debugging'), { recursive: true })],
    ['Cline conflict with shared destinations free', ['codex', 'cline'], 'safe-change', [], async (p) => mkdir(path.join(p, '.cline', 'skills', 'safe-change'), { recursive: true })],
    ['Kilo agent conflict', ['kilo'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.kilo', 'agents'), { recursive: true }); await writeFile(path.join(p, '.kilo', 'agents', 'project-designer.md'), 'mine'); }],
    ['Copilot instructions conflict', ['codex', 'copilot'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.github'), { recursive: true }); await writeFile(path.join(p, '.github', 'copilot-instructions.md'), 'mine'); }],
    ['Copilot auditor conflict', ['codex', 'copilot'], 'safe-change', ['-CopilotAuditor'], async (p) => { await mkdir(path.join(p, '.github', 'agents'), { recursive: true }); await writeFile(path.join(p, '.github', 'agents', 'project-auditor.agent.md'), 'mine'); }],
    ['Claude CLAUDE.md conflict', ['codex', 'claude'], 'safe-change', [], async (p) => writeFile(path.join(p, 'CLAUDE.md'), 'own rules without import\n')],
    ['Claude without canonical skills', ['codex', 'claude'], null, [], async (p) => writeFile(path.join(p, 'keep.txt'), 'x')],
    ['ordinary file at .cline', ['codex', 'cline'], 'safe-change', [], async (p) => writeFile(path.join(p, '.cline'), 'mine')],
    ['ordinary file at .cline/skills', ['codex', 'cline'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.cline')); await writeFile(path.join(p, '.cline', 'skills'), 'mine'); }],
    ['ordinary file at .agents', ['codex', 'cline'], 'safe-change', [], async (p) => writeFile(path.join(p, '.agents'), 'mine')],
    ['ordinary file at .agents/skills', ['kilo'], 'safe-change', [], async (p) => { await mkdir(path.join(p, '.agents')); await writeFile(path.join(p, '.agents', 'skills'), 'mine'); }],
    ['ordinary file at .github', ['codex', 'copilot'], 'safe-change', [], async (p) => writeFile(path.join(p, '.github'), 'mine')],
    ['ordinary file at .github/agents', ['codex', 'copilot'], 'safe-change', ['-CopilotAuditor'], async (p) => { await mkdir(path.join(p, '.github')); await writeFile(path.join(p, '.github', 'agents'), 'mine'); }],
    ['ordinary file at .kilo', ['codex', 'kilo'], 'safe-change', [], async (p) => writeFile(path.join(p, '.kilo'), 'mine')],
    ['ordinary file at .claude', ['codex', 'claude'], 'safe-change', [], async (p) => writeFile(path.join(p, '.claude'), 'mine')],
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

  // Git-authorship policy: new installs get AGENTS.md; existing AGENTS.md is untouched; -UpdatePolicies is explicit, standalone, and zero-mutation on malformed markers.
  const canonicalTemplate = await readFile(path.join(root, 'templates', 'project-rules', 'AGENTS.md'));
  const freshAgents = path.join(workspace, 'policy-fresh');
  await mkdir(freshAgents);
  await runInstall(freshAgents, ['codex']);
  if (!(await readFile(path.join(freshAgents, 'AGENTS.md'))).equals(canonicalTemplate)) throw new Error('new install did not create AGENTS.md from the canonical template');
  const ownAgents = path.join(workspace, 'policy-own');
  await mkdir(ownAgents);
  await writeFile(path.join(ownAgents, 'AGENTS.md'), '# Project rules\n');
  await runInstall(ownAgents, ['codex']);
  if (await readFile(path.join(ownAgents, 'AGENTS.md'), 'utf8') !== '# Project rules\n') throw new Error('normal install modified an existing AGENTS.md');
  const shellArgs = (project, extraArgs) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-ProjectRoot', project, ...extraArgs];
  const runUpdate = (project, extraArgs = [], options = {}) => execFileAsync(shell, shellArgs(project, ['-UpdatePolicies', ...extraArgs]), options);
  // PATH without any directory that provides node, to prove which install paths genuinely need Node.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const nodeFree = { env: { ...process.env, [pathKey]: (process.env[pathKey] ?? '').split(path.delimiter).filter((dir) => dir && !['node.exe', 'node'].some((name) => existsSync(path.join(dir, name)))).join(path.delimiter) } };
  const nodeFreeShell = async (project, extraArgs) => execFileAsync(shell, shellArgs(project, extraArgs), nodeFree);

  await runUpdate(ownAgents);
  const upgraded = await readFile(path.join(ownAgents, 'AGENTS.md'), 'utf8');
  if (!upgraded.startsWith('# Project rules\n') || !upgraded.includes('<!-- agent-kit:git-authorship:start -->')) throw new Error('-UpdatePolicies did not append the managed block');
  await runUpdate(ownAgents);
  if (await readFile(path.join(ownAgents, 'AGENTS.md'), 'utf8') !== upgraded) throw new Error('-UpdatePolicies is not idempotent');
  const ownBefore = await snapshot(ownAgents);
  for (const [combined, name] of [[['-Tools', 'codex'], 'Tools'], [['-NoSkills'], 'NoSkills'], [['-Skills', 'safe-change'], 'Skills'], [['-OptionalSkills', 'web-design-guidelines'], 'OptionalSkills'], [['-CopilotAuditor'], 'CopilotAuditor']]) {
    await failsWith(runUpdate(ownAgents, combined), new RegExp(`standalone operation and cannot be combined with -${name}`), `-UpdatePolicies with ${name}`);
  }
  if (await snapshot(ownAgents) !== ownBefore) throw new Error('rejected -UpdatePolicies combinations mutated the project');

  // -UpdatePolicies with no AGENTS.md creates it from the canonical template.
  const absentAgents = path.join(workspace, 'policy-absent');
  await mkdir(absentAgents);
  await runUpdate(absentAgents);
  if (!(await readFile(path.join(absentAgents, 'AGENTS.md'))).equals(canonicalTemplate)) throw new Error('-UpdatePolicies without AGENTS.md did not create it from the template');

  // Project path containing spaces: normal install and -UpdatePolicies.
  const spaced = path.join(workspace, 'project with spaces');
  await mkdir(spaced);
  await runInstall(spaced, ['codex']);
  if (!(await readFile(path.join(spaced, 'AGENTS.md'))).equals(canonicalTemplate)) throw new Error('spaces: AGENTS.md was not created');
  await writeFile(path.join(spaced, 'AGENTS.md'), '# Spaced project\n');
  await runUpdate(spaced);
  if (!(await readFile(path.join(spaced, 'AGENTS.md'), 'utf8')).includes('<!-- agent-kit:git-authorship:start -->')) throw new Error('spaces: -UpdatePolicies did not update');

  // Node availability: creating AGENTS.md must not need Node; Claude and -UpdatePolicies do, and fail with zero mutation.
  const noNodeProject = path.join(workspace, 'policy-no-node');
  await mkdir(noNodeProject);
  await nodeFreeShell(noNodeProject, ['-Tools', 'codex', '-Skills', 'safe-change']);
  if (!(await readFile(path.join(noNodeProject, 'AGENTS.md'))).equals(canonicalTemplate)) throw new Error('without Node: normal install did not create AGENTS.md');
  const noNodeClaude = path.join(workspace, 'policy-no-node-claude');
  await mkdir(noNodeClaude);
  const noNodeClaudeBefore = await snapshot(noNodeClaude);
  await failsWith(nodeFreeShell(noNodeClaude, ['-Tools', 'claude', '-Skills', 'safe-change']), /requires Node\.js/, 'claude without Node');
  if (await snapshot(noNodeClaude) !== noNodeClaudeBefore) throw new Error('claude without Node mutated the project');
  const noNodeUpdate = path.join(workspace, 'policy-no-node-update');
  await mkdir(noNodeUpdate);
  await writeFile(path.join(noNodeUpdate, 'AGENTS.md'), '# Mine\n');
  await failsWith(nodeFreeShell(noNodeUpdate, ['-UpdatePolicies']), /requires Node\.js/, '-UpdatePolicies without Node');
  if (await readFile(path.join(noNodeUpdate, 'AGENTS.md'), 'utf8') !== '# Mine\n') throw new Error('-UpdatePolicies without Node mutated AGENTS.md');

  // A fresh, correct installation must not trigger validate-install policy warnings.
  const freshValidation = await execFileAsync(process.execPath, [installValidator, freshAgents]);
  if (/warning:/i.test(freshValidation.stderr)) throw new Error(`fresh install produced a policy warning: ${freshValidation.stderr}`);

  const malformedAgents = path.join(workspace, 'policy-malformed');
  await mkdir(malformedAgents);
  await writeFile(path.join(malformedAgents, 'AGENTS.md'), '# Mine\n<!-- agent-kit:git-authorship:start -->\n');
  const malformedBefore = await snapshot(malformedAgents);
  await failsWith(runUpdate(malformedAgents), /Policy update refused/, 'malformed markers');
  if (await snapshot(malformedAgents) !== malformedBefore) throw new Error('-UpdatePolicies mutated a project with malformed markers');

  // A v1.8.0 AGENTS.md (Git authorship only) with project sections, CRLF, and a BOM gains only the newer managed blocks
  // right after Git authorship, in template order and idempotently; a stale block is replaced in the same single write.
  const templateText = canonicalTemplate.toString('utf8').replace(/\r\n/g, '\n');
  const managedBlocks = [...templateText.matchAll(/^<!-- agent-kit:([a-z0-9-]+):start -->$[\s\S]*?^<!-- agent-kit:\1:end -->$/gm)].map((match) => match[0]);
  if (managedBlocks.length < 3) throw new Error('expected Git-authorship, destructive-operations, and multi-agent template blocks');
  const block = managedBlocks[0];
  const legacyText = (policy) => `# Project rules\r\n\r\n## Mine\r\nkeep\r\n\r\n${policy.replace(/\n/g, '\r\n')}\r\n\r\n## After\r\nkeep too\r\n`;
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const legacy = path.join(workspace, 'policy-legacy');
  await mkdir(legacy);
  const upgradedBytes = Buffer.concat([bom, Buffer.from(legacyText(managedBlocks.join('\n\n')))]);
  await writeFile(path.join(legacy, 'AGENTS.md'), Buffer.concat([bom, Buffer.from(legacyText(block))]));
  await runUpdate(legacy);
  if (!(await readFile(path.join(legacy, 'AGENTS.md'))).equals(upgradedBytes)) throw new Error('-UpdatePolicies did not add only the newer managed blocks to a v1.8.0 AGENTS.md');
  await runUpdate(legacy);
  if (!(await readFile(path.join(legacy, 'AGENTS.md'))).equals(upgradedBytes)) throw new Error('-UpdatePolicies is not idempotent for a v1.8.0 AGENTS.md');
  await writeFile(path.join(legacy, 'AGENTS.md'), Buffer.concat([bom, Buffer.from(legacyText('<!-- agent-kit:git-authorship:start -->\nold\n<!-- agent-kit:git-authorship:end -->'))]));
  await runUpdate(legacy);
  if (!(await readFile(path.join(legacy, 'AGENTS.md'))).equals(upgradedBytes)) throw new Error('-UpdatePolicies did not replace the stale block and add the missing one');
  const halfBefore = Buffer.concat([bom, Buffer.from(legacyText(`${block}\n\n<!-- agent-kit:destructive-operations:start -->`))]);
  await writeFile(path.join(legacy, 'AGENTS.md'), halfBefore);
  await failsWith(runUpdate(legacy), /Policy update refused/, 'malformed destructive-operations markers');
  if (!(await readFile(path.join(legacy, 'AGENTS.md'))).equals(halfBefore)) throw new Error('-UpdatePolicies partially wrote a file with a malformed destructive-operations block');
  const duplicateMultiAgent = Buffer.concat([bom, Buffer.from(legacyText(`${managedBlocks[0]}\n\n${managedBlocks[1]}\n\n<!-- agent-kit:multi-agent:start -->\n<!-- agent-kit:multi-agent:start -->`))]);
  await writeFile(path.join(legacy, 'AGENTS.md'), duplicateMultiAgent);
  await failsWith(runUpdate(legacy), /Policy update refused/, 'duplicate multi-agent markers');
  if (!(await readFile(path.join(legacy, 'AGENTS.md'))).equals(duplicateMultiAgent)) throw new Error('-UpdatePolicies partially wrote a file with duplicate multi-agent markers');

  // Valid pre-existing directory ancestors must keep working.
  const validAncestors = path.join(workspace, 'valid-ancestors');
  await mkdir(path.join(validAncestors, '.cline', 'skills'), { recursive: true });
  await mkdir(path.join(validAncestors, '.agents', 'skills'), { recursive: true });
  await mkdir(path.join(validAncestors, '.github'), { recursive: true });
  await runInstall(validAncestors, ['codex', 'cline', 'copilot']);
  if (!await exists(path.join(validAncestors, '.cline', 'skills', 'safe-change', 'SKILL.md'))) throw new Error('valid existing ancestor directories were rejected');

  console.log(`Validated ${combinations.length} Copilot combinations, 3 legacy tool modes, overwrite safety, shared destinations, mirrors, optional auditor behavior, opt-in data-visualization and handoff distribution, security-audit opt-in distribution for all five tools and unchanged defaults, the opt-in Claude adapter, -NoSkills, and zero-mutation global preflight including non-directory ancestors.`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
