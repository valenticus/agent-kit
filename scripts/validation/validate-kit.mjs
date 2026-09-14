import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
const required = ['AGENTS.md','README.md','VERSION','optional/catalog.json','docs/architecture.md','docs/source-inventory.md','docs/promotion-and-updates.md','docs/attribution.md','templates/bootstrap-prompt.md','templates/project-rules/AGENTS.md','adapters/codex/README.md','adapters/cline/README.md','adapters/kilo/README.md','adapters/copilot/README.md','adapters/copilot/copilot-instructions.md','adapters/copilot/project-auditor.agent.md','scripts/validation/validate-installer.mjs','scripts/validation/validate-data-visualization.mjs'];
for (const rel of required) { try { await stat(path.join(root, rel)); } catch { errors.push(`missing ${rel}`); } }
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
if (version !== '1.3.0') errors.push(`unexpected VERSION ${version}`);
const hasUkrainianCommunicationPolicy = (text) => [
  /## Communication language/i,
  /Ukrainian by default/i,
  /code,[\s\S]{0,300}quoted source text[\s\S]{0,150}(?:original|technically appropriate) language/i,
  /another language[\s\S]{0,150}explicitly requests[\s\S]{0,150}exact-language output/i,
].every((pattern) => pattern.test(text));
const rootRules = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
if (!hasUkrainianCommunicationPolicy(rootRules)) errors.push('root AGENTS.md lacks the Agent Kit communication-language policy');
const projectRules = await readFile(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8');
if (!hasUkrainianCommunicationPolicy(projectRules)) errors.push('project rules lack the canonical consumer-project communication-language policy');
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
for (const mirror of [path.join(root, '.github', 'skills'), path.join(root, 'adapters', 'copilot', 'skills')]) {
  try { await stat(mirror); errors.push(`kit must not contain a Copilot skill mirror at ${path.relative(root, mirror)}`); } catch {}
}
const copilotAuditor = await readFile(path.join(root, 'adapters', 'copilot', 'project-auditor.agent.md'), 'utf8');
if (!/^---\r?\nname:\s*\S/m.test(copilotAuditor) || !/\r?\ndescription:\s*\S/.test(copilotAuditor) || !/\r?\ndisable-model-invocation:\s*true/.test(copilotAuditor) || !/\r?\ntools:\s*\[[^\]]+\]\r?\n---/.test(copilotAuditor)) errors.push('Copilot auditor has invalid or non-manual agent frontmatter');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${skillFiles.length} core/project skill schemas, ${expectedOptional.length} optional modules, licenses, agents, Copilot adapter, links, version, and no unnecessary skill mirrors.`);
