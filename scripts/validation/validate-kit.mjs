import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { locateBlock, normalizeEol } from '../install/policy-block.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const errors = [];
const optionalCatalogPath = path.join(root, 'optional', 'catalog.json');
const optionalCatalog = JSON.parse(await readFile(optionalCatalogPath, 'utf8'));
const skillsRoot = path.join(root, 'core', 'skills');
const skillFiles = [];
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) skillFiles.push([entry.name, path.join(skillsRoot, entry.name, 'SKILL.md')]);
}
for (const template of ['project-ui','project-product','project-architecture','project-data','project-security']) {
  skillFiles.push([template, path.join(root, 'templates', template, 'SKILL.md')]);
}
for (const [name, file] of skillFiles) {
  try {
    const text = await readFile(file, 'utf8');
    const match = text.match(/^---\r?\nname:\s*([^\r\n]+)\r?\ndescription:\s*\S[^\r\n]*\r?\n---/);
    if (!match || match[1] !== name) errors.push(`${name}: invalid frontmatter`);
  } catch { errors.push(`${name}: missing SKILL.md`); }
}
const expectedOptional = ['supabase-postgres-best-practices','vercel-react-best-practices','web-design-guidelines'];
if (Object.keys(optionalCatalog).sort().join('\n') !== expectedOptional.sort().join('\n')) errors.push('optional catalog has an unexpected module set');
for (const name of expectedOptional) {
  const module = optionalCatalog[name];
  if (!module || !['vendored','referenced'].includes(module.kind) || !module.version || !module.license || !module.upstream || !module.recommendWhen) {
    errors.push(`${name}: incomplete optional metadata`);
    continue;
  }
  if (module.kind === 'vendored') {
    const skillFile = path.join(root, module.path, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    if (!new RegExp(`^---\\r?\\nname:\\s*${name.replaceAll('-', '\\-')}\\r?\\ndescription:`, 'm').test(text)) errors.push(`${name}: invalid vendored frontmatter`);
    const license = await readFile(path.join(root, module.licenseFile), 'utf8');
    if (!/MIT License/.test(license) || !/Copyright/.test(license)) errors.push(`${name}: incomplete license notice`);
  } else if (!module.installHint) errors.push(`${name}: referenced module lacks installHint`);
}
const required = ['AGENTS.md','README.md','VERSION','optional/catalog.json','docs/architecture.md','docs/source-inventory.md','docs/promotion-and-updates.md','docs/attribution.md','templates/bootstrap-prompt.md','templates/project-rules/AGENTS.md','adapters/codex/README.md','adapters/cline/README.md','adapters/kilo/README.md','adapters/copilot/README.md','adapters/copilot/copilot-instructions.md','adapters/copilot/project-auditor.agent.md','scripts/validation/validate-installer.mjs','scripts/validation/validate-data-visualization.mjs','adapters/claude/README.md','adapters/claude/claude-bootstrap.mjs','adapters/claude/CLAUDE.template.md','scripts/install/claude-adapter.mjs','scripts/validation/validate-claude.mjs','scripts/install/policy-block.mjs','scripts/validation/validate-policy.mjs'];
for (const rel of required) { try { await stat(path.join(root, rel)); } catch { errors.push(`missing ${rel}`); } }
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
if (version !== '1.6.0') errors.push(`unexpected VERSION ${version}`);
const hasUkrainianCommunicationPolicy = (text) => [
  /## Communication language/i,
  /Ukrainian by default/i,
  /code,[\s\S]{0,300}quoted source text[\s\S]{0,150}(?:original|technically appropriate) language/i,
  /another language[\s\S]{0,150}explicitly requests[\s\S]{0,150}exact-language output/i,
].every((pattern) => pattern.test(text));
const rootRules = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
if (!hasUkrainianCommunicationPolicy(rootRules)) errors.push('root AGENTS.md lacks the Agent Kit communication-language policy');
const projectRules = await readFile(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8');
const authorshipBlocks = [['root AGENTS.md', rootRules], ['project rules template', projectRules]].map(([name, text]) => {
  try {
    const normalized = normalizeEol(text);
    const found = locateBlock(normalized);
    if (!found) { errors.push(`${name} lacks the managed Git-authorship block`); return null; }
    return normalized.slice(found.begin, found.end);
  } catch (error) { errors.push(`${name}: ${error.message}`); return null; }
});
if (authorshipBlocks.every(Boolean)) {
  if (authorshipBlocks[0] !== authorshipBlocks[1]) errors.push('managed Git-authorship blocks differ between root AGENTS.md and the project rules template');
  const block = authorshipBlocks[1];
  for (const pattern of [
    /## Git authorship/,
    /Agents may create commits; agents must not attribute those commits to themselves/,
    /may create, amend, merge, release, and push commits/,
    /preserve the human user's configured Git identity/i,
    /Never identify an AI assistant[\s\S]{0,150}commit author or committer[\s\S]{0,80}Signed-off-by/i,
    /Never set or modify `git config user\.name` or `git config user\.email` merely to identify the agent/,
    /`--author`, `--reset-author`, `git -c user\.name=\.\.\.`, `git -c user\.email=\.\.\.`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`/,
    /Never add AI attribution trailers such as `Co-Authored-By:/,
    /Human co-authors explicitly requested by the user are allowed/,
    /report the configuration problem to the user before creating a commit/,
    /never blocks normal commits where the user's own identity is configured/,
    /Do not rewrite already-published history/i,
  ]) {
    if (!pattern.test(block)) errors.push(`Git-authorship block is missing required rule ${pattern}`);
  }
  // The policy is about attribution, not a ban on agent-created commits.
  for (const forbidden of [/\b(?:never|do not|must not|must never) (?:create|make|run|execute) (?:a )?(?:git )?commits?\b/i, /stop and ask/i, /refuse to commit/i]) {
    if (forbidden.test(block)) errors.push(`Git-authorship block must not prohibit agent-created commits (${forbidden})`);
  }
}
if (!hasUkrainianCommunicationPolicy(projectRules)) errors.push('project rules lack the canonical consumer-project communication-language policy');
// Adapters, agents, skills, and non-rule templates must inherit authorship policy from AGENTS.md, never carry a copy.
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else yield absolute;
  }
}
const projectRulesFile = path.join(root, 'templates', 'project-rules', 'AGENTS.md');
for (const directory of ['adapters', 'agents', 'core', 'templates']) {
  for await (const file of walk(path.join(root, directory))) {
    if (file === projectRulesFile) continue;
    const text = await readFile(file, 'utf8');
    if (/agent-kit:git-authorship|## Git authorship/i.test(text)) errors.push(`${path.relative(root, file)}: authorship policy must not be duplicated outside the canonical AGENTS.md block`);
  }
}
for (const file of [path.join(root, 'README.md'), ...(await readdir(path.join(root, 'docs'))).map((name) => path.join(root, 'docs', name))]) {
  const text = await readFile(file, 'utf8');
  if (/Co-Authored-By/i.test(text)) errors.push(`${path.relative(root, file)}: must not mention AI co-author trailers`);
}
for (const agent of ['designer','coding','reviewer']) {
  const text = await readFile(path.join(root, 'agents', agent, 'agent.md'), 'utf8');
  if (!/^---\r?\ndescription:\s*\S/m.test(text) || !/\r?\nmode:\s*primary\r?\n/.test(text)) errors.push(`${agent}: invalid agent frontmatter`);
}
const markdown = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.name.endsWith('.md')) markdown.push(absolute);
  }
}
await collect(root);
for (const file of markdown) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    try { await stat(path.resolve(path.dirname(file), target)); }
    catch { errors.push(`${path.relative(root, file)}: broken link ${target}`); }
  }
}
for (const directory of ['core','agents','templates','adapters','scripts']) {
  const files = [];
  async function collectText(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await collectText(absolute);
      else files.push(absolute);
    }
  }
  await collectText(path.join(root, directory));
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = await readFile(file, 'utf8');
    if (/Spilno|spilno-|family_members|operations-center|--expense|--income|--transfer|Laguna|StepFun/i.test(text)) errors.push(`${path.relative(root, file)}: project-specific leakage`);
  }
}
try { await stat(path.join(root, 'optional', 'vendored', 'vercel-react-best-practices')); errors.push('referenced Vercel skill must not be vendored'); } catch {}
try { await stat(path.join(root, '.kilo', 'skills')); errors.push('kit must not contain a Kilo skill mirror'); } catch {}
for (const mirror of [path.join(root, '.claude', 'skills'), path.join(root, 'adapters', 'claude', 'skills'), path.join(root, '.github', 'skills'), path.join(root, 'adapters', 'copilot', 'skills')]) {
  try { await stat(mirror); errors.push(`kit must not contain a Claude/Copilot skill mirror at ${path.relative(root, mirror)}`); } catch {}
}
const copilotAuditor = await readFile(path.join(root, 'adapters', 'copilot', 'project-auditor.agent.md'), 'utf8');
if (!/^---\r?\nname:\s*\S/m.test(copilotAuditor) || !/\r?\ndescription:\s*\S/.test(copilotAuditor) || !/\r?\ndisable-model-invocation:\s*true/.test(copilotAuditor) || !/\r?\ntools:\s*\[[^\]]+\]\r?\n---/.test(copilotAuditor)) errors.push('Copilot auditor has invalid or non-manual agent frontmatter');
// Behavioral-testing methodology: validate only the stable catalog anchors, not Markdown layout or prose.
const behavioralTestingRel = 'core/methodology/behavioral-testing.md';
let behavioralTesting = null;
try { behavioralTesting = normalizeEol(await readFile(path.join(root, behavioralTestingRel), 'utf8')); }
catch { errors.push(`missing ${behavioralTestingRel}`); }
if (behavioralTesting !== null) {
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
  const rows = behavioralTesting.split('\n').filter((line) => /^\s*\|/.test(line)).map(cells);
  const header = ['ID', 'Scenario', 'Decision', 'Type', 'When', 'Pass condition', 'Evidence status'];
  if (!rows.some((row) => row.join('|') === header.join('|'))) errors.push(`${behavioralTestingRel}: scenario catalog header not found`);
  const scenarios = ['language-response', 'git-attribution', 'git-identity', 'dirty-tree', 'scope-control', 'skill-stacking', 'evidence-claim', 'debug-before-evidence', 'destructive-git', 'adapter-inheritance'];
  const byId = new Map();
  for (const id of scenarios) {
    const matches = rows.filter((row) => row[0] === id);
    if (matches.length !== 1) { errors.push(`${behavioralTestingRel}: scenario ${id} must appear exactly once (found ${matches.length})`); continue; }
    const [, , decision, type] = matches[0];
    if (!['KEEP', 'DEFER', 'DROP'].includes(decision)) errors.push(`${behavioralTestingRel}: scenario ${id} has invalid decision ${decision}`);
    if (!['deterministic', 'behavioral', 'hybrid'].includes(type)) errors.push(`${behavioralTestingRel}: scenario ${id} has invalid type ${type}`);
    byId.set(id, matches[0]);
  }
  const evidenceOf = (id) => (byId.get(id) ?? []).slice(6).join('|');
  if (byId.has('language-response') && !(/E1/.test(evidenceOf('language-response')) && /demonstrated/i.test(evidenceOf('language-response')) && /STRONG SIGNAL/.test(evidenceOf('language-response')))) errors.push(`${behavioralTestingRel}: language-response must record E1 as demonstrated, STRONG SIGNAL`);
  if (byId.has('git-attribution') && !(/E2/.test(evidenceOf('git-attribution')) && /INCONCLUSIVE/.test(evidenceOf('git-attribution')))) errors.push(`${behavioralTestingRel}: git-attribution must record E2 as INCONCLUSIVE`);
}
const sharedPrinciples = await readFile(path.join(root, 'core', 'methodology', 'principles.md'), 'utf8');
if (!/Support each material success claim with evidence that remains valid for that claim/.test(sharedPrinciples) || !/stale, manual, external, or unrun checks/.test(sharedPrinciples)) errors.push('core/methodology/principles.md lacks the evidence-to-claim principle');
const readmeText = await readFile(path.join(root, 'README.md'), 'utf8');
if (!/\]\(core\/methodology\/behavioral-testing\.md\)/.test(readmeText)) errors.push('README.md must link to core/methodology/behavioral-testing.md');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${skillFiles.length} core/project skill schemas, ${expectedOptional.length} optional modules, licenses, agents, Copilot adapter, links, version, and no unnecessary skill mirrors.`);
