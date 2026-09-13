import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
  const copilotInstructionsPath = path.join(project, '.github', 'copilot-instructions.md');
  if (await exists(copilotInstructionsPath)) {
    const instructions = await readFile(copilotInstructionsPath, 'utf8');
    if (!/AGENTS\.md/.test(instructions) || !/\.agents\/skills/.test(instructions)) throw new Error('invalid Copilot instruction bridge');
  }
  console.log(`Validated shared skills, ${checked} complete Cline mirrors, present native adapters, and no unnecessary skill mirrors.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
