import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillRoot = path.join(root, 'core', 'skills', 'data-visualization');
const expectedReferences = [
  'accessibility.md',
  'chart-selection.md',
  'responsive-interaction.md',
  'validation-and-anti-patterns.md',
  'visual-composition.md',
  'visual-encoding.md',
];
const errors = [];

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

if (!await exists(skillRoot)) errors.push('missing canonical core/skills/data-visualization');
else {
  const entrypoint = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  if (!/^---\r?\nname:\s*data-visualization\r?\ndescription:\s*\S[^\r\n]*\r?\n---/.test(entrypoint)) errors.push('invalid data-visualization frontmatter');
  const actualReferences = (await readdir(path.join(skillRoot, 'references'))).sort();
  if (actualReferences.join('\n') !== expectedReferences.join('\n')) errors.push('data-visualization reference set is incomplete or unexpected');
  for (const reference of expectedReferences) {
    if (!entrypoint.includes(`references/${reference}`)) errors.push(`SKILL.md does not route to ${reference}`);
    const content = await readFile(path.join(skillRoot, 'references', reference), 'utf8');
    if (!content.trim()) errors.push(`${reference} is empty`);
  }

  const allText = [entrypoint];
  for (const reference of expectedReferences) allText.push(await readFile(path.join(skillRoot, 'references', reference), 'utf8'));
  const combined = allText.join('\n');
  const requiredConcepts = [
    /Reader question:/,
    /PRIMARY/,
    /zero baseline/i,
    /partial period/i,
    /missing/i,
    /uncertainty/i,
    /keyboard/i,
    /iPhone-sized/i,
    /accessible table/i,
    /correlation/i,
  ];
  for (const pattern of requiredConcepts) if (!pattern.test(combined)) errors.push(`missing required concept ${pattern}`);
  if (/Lieflat/i.test(combined)) errors.push('external research name leaked into skill content');
  if (/Recharts|Chart\.js|ECharts|\bD3\b|React|Vue|design token file|palette file/i.test(combined)) errors.push('framework or product implementation coupling found in skill content');
}

const installer = await readFile(path.join(root, 'scripts', 'install', 'install.ps1'), 'utf8');
const defaultSkills = installer.match(/\[string\[\]\]\$Skills\s*=\s*@\(([^)]*)\)/)?.[1] ?? '';
if (/data-visualization/.test(defaultSkills)) errors.push('data-visualization must remain opt-in, not a default installer skill');
const catalog = JSON.parse(await readFile(path.join(root, 'optional', 'catalog.json'), 'utf8'));
if (catalog['data-visualization']) errors.push('original data-visualization skill must not be classified as a third-party optional module');

for (const forbidden of [path.join(root, '.kilo', 'skills', 'data-visualization'), path.join(root, '.github', 'skills', 'data-visualization')]) {
  if (await exists(forbidden)) errors.push(`unexpected repository mirror ${path.relative(root, forbidden)}`);
}

if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Validated canonical opt-in data-visualization skill, six routed references, required contracts, framework neutrality, and no repository mirrors.');
