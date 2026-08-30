import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const project = path.resolve(process.argv[2] ?? '.');
const agents = path.join(project, '.agents', 'skills');
const cline = path.join(project, '.cline', 'skills');
let checked = 0;
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
  for (const entry of await readdir(cline, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentRoot = path.join(agents, entry.name);
    const clineRoot = path.join(cline, entry.name);
    const agentFiles = await filesUnder(agentRoot);
    const clineFiles = await filesUnder(clineRoot);
    if (agentFiles.join('\n') !== clineFiles.join('\n')) throw new Error(`${entry.name}: Codex/Cline file sets differ`);
    for (const relative of agentFiles) {
      const a = await readFile(path.join(agentRoot, relative));
      const c = await readFile(path.join(clineRoot, relative));
      if (!a.equals(c)) throw new Error(`${entry.name}/${relative}: Codex/Cline mirrors differ`);
    }
    checked++;
  }
  try { await stat(path.join(project, '.kilo', 'skills')); throw new Error('unexpected .kilo/skills third mirror'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const kiloAgent = await readFile(path.join(project, '.kilo', 'agents', 'project-designer.md'), 'utf8');
  if (!/^---\r?\ndescription:/m.test(kiloAgent) || !/\r?\nmode:\s*primary\r?\n/.test(kiloAgent)) throw new Error('invalid Kilo designer agent frontmatter');
  console.log(`Validated ${checked} complete Codex/Cline skill mirrors, Kilo agent compatibility, and no Kilo skill mirror.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
