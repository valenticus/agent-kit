// Maintainer-only structural checks. Never invokes the skill or target code.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const relative = 'optional/vendored/security-audit';
const directory = path.join(root, relative);
const commit = 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8';
const expectedFiles = ['LICENSE', 'SKILL.md', 'UPSTREAM.md', 'agents/openai.yaml', 'references/report-format.md', 'references/source-review.md'].sort();
async function filesUnder(current, prefix = '') {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    assert.ok(!(await lstat(file)).isSymbolicLink(), `unexpected package link: ${file}`);
    if (entry.isDirectory()) files.push(...await filesUnder(file, `${prefix}${entry.name}/`));
    else {
      assert.ok(entry.isFile(), `unexpected special file: ${file}`);
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files.sort();
}
assert.deepEqual(await filesUnder(directory), expectedFiles, 'text-only package file set changed; review new executable/configuration surfaces');
const catalog = JSON.parse(await readFile(path.join(root, 'optional/catalog.json'), 'utf8'));
const module = catalog['security-audit'];
assert.equal(module.kind, 'vendored');
assert.equal(module.path, relative);
assert.equal(module.version, '1.0.0');
assert.equal(module.license, 'MIT');
assert.equal(module.licenseFile, `${relative}/LICENSE`);
assert.equal(module.upstream, 'https://github.com/cloudflare/security-audit-skill');
assert.equal(module.upstreamCommit, commit);
const upstream = await readFile(path.join(directory, 'UPSTREAM.md'), 'utf8');
assert.ok(upstream.includes(commit) && upstream.includes(`Adaptation version: \`${module.version}\``), 'provenance disagrees with catalog');
const license = await readFile(path.join(directory, 'LICENSE'), 'utf8');
// Pin the exact complete upstream MIT notice, permitting checkout EOL differences.
const normalizedLicense = license.replaceAll('\r\n', '\n');
assert.equal(createHash('sha256').update(normalizedLicense).digest('hex'), 'e598e694aa506650c7192d5ea3be0e50aca0d356ea00551c53429f0b01eb6391');
const skill = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: security-audit\r?\ndescription: [^\r\n]+\r?\n---/);
assert.equal((await readFile(path.join(directory, 'agents/openai.yaml'), 'utf8')).replaceAll('\r\n', '\n'), 'policy:\n  allow_implicit_invocation: false\n', 'implicit invocation must stay disabled, without tools or hooks');
for (const relativeFile of expectedFiles.filter((file) => file.endsWith('.md'))) {
  const file = path.join(directory, relativeFile);
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const destination = match[1].split('#')[0];
    if (!destination || /^(https?:|mailto:)/.test(destination)) continue;
    const resolved = path.resolve(path.dirname(file), destination);
    const contained = path.relative(directory, resolved);
    assert.ok(contained && !contained.startsWith(`..${path.sep}`) && !path.isAbsolute(contained), 'reference leaves package');
    assert.ok((await lstat(resolved)).isFile(), `missing reference: ${relativeFile}: ${destination}`);
  }
}
const installer = await readFile(path.join(root, 'scripts/install/install.ps1'), 'utf8');
const defaultSkills = installer.match(/\[string\[\]\]\$Skills\s*=\s*@\(([^)]*)\)/)?.[1];
assert.ok(defaultSkills, 'cannot identify default skill selection');
assert.deepEqual([...defaultSkills.matchAll(/'([^']+)'/g)].map((match) => match[1]), ['safe-change', 'debugging', 'final-audit', 'product-ux', 'mobile-design', 'design-critique', 'security', 'ui'], 'default selection must stay unchanged');
assert.match(installer, /\[string\[\]\]\$OptionalSkills\s*=\s*@\(\)/, 'optional selection must default to empty');
console.log('Validated security-audit package, pinned MIT/provenance, explicit-only Codex policy, local references, and unchanged installer defaults. Instruction compliance, host isolation, and agent behavior are not proven.');

if (process.argv.includes('--fixtures')) {
  // Portable packaging/mirror checks, explicitly NOT a replacement for install.ps1 tests.
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-kit-security-audit-'));
  const execute = promisify(execFile);
  try {
    const shared = path.join(workspace, '.agents/skills/security-audit');
    const mirror = path.join(workspace, '.cline/skills/security-audit');
    await mkdir(path.dirname(shared), { recursive: true });
    await mkdir(path.dirname(mirror), { recursive: true });
    await cp(directory, shared, { recursive: true, errorOnExist: true, force: false });
    await cp(directory, mirror, { recursive: true, errorOnExist: true, force: false });
    await cp(path.join(root, 'templates/project-rules/AGENTS.md'), path.join(workspace, 'AGENTS.md'));
    for (const destination of [shared, mirror]) {
      assert.deepEqual(await filesUnder(destination), expectedFiles);
      for (const file of expectedFiles) assert.ok((await readFile(path.join(directory, file))).equals(await readFile(path.join(destination, file))), `fixture copy differs: ${file}`);
    }
    const validate = () => execute(process.execPath, [path.join(root, 'scripts/validation/validate-install.mjs'), workspace]);
    await validate();
    // Prove the recursive mirror validator catches policy metadata drift too.
    await writeFile(path.join(mirror, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    await assert.rejects(validate(), (error) => /security-audit.*openai.yaml.*mirrors differ/.test(error.stderr));
    console.log('Validated disposable package copying and complete Cline mirror parity, including rejection of invocation-policy drift. PowerShell installer and native discovery were not exercised by these fixtures.');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
