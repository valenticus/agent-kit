// Containment check for installer reads and writes: a path inside a project must never lead outside it through a
// symbolic link or junction. Used by the Claude adapter and the policy updater before anything is written.
import fs from 'node:fs';
import path from 'node:path';

export class ProjectPathError extends Error {}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function lstatOrNull(fsImpl, file) {
  try { return fsImpl.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Inspects <project>/<relative> component by component from the real project root, without following links.
// Every existing parent must be a real directory, never a link or junction. The last component may be absent
// ({ exists: false }); if it is a link, it is accepted only with `allowInternalLink` and only when it fully resolves to
// an existing path inside the project (broken, circular, and outside links are refused). `type` ('file' or 'dir') is
// checked on the existing, resolved last component. Returns { path, real, exists }, where `real` is what a write
// through `path` would change.
export function inspectProjectPath(project, relative, { type, allowInternalLink = false, fsImpl = fs } = {}) {
  // The native form expands Windows short (8.3) names the same way for the root and for link targets.
  const realpath = (file) => (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(file);
  const root = realpath(project);
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const shown = parts.slice(0, index + 1).join('/');
    const stat = lstatOrNull(fsImpl, current);
    if (!stat) return { path: path.join(root, ...parts), real: path.join(root, ...parts), exists: false };
    const last = index === parts.length - 1;
    let real = current;
    if (stat.isSymbolicLink()) {
      if (!last || !allowInternalLink) throw new ProjectPathError(`${shown} is a symbolic link or junction; refusing to write through it. Replace it with a real ${last && type === 'file' ? 'file' : 'directory'} inside the project.`);
      try { real = realpath(current); } catch (error) {
        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw new ProjectPathError(`${shown} is a broken or circular link; refusing to modify it.`);
        throw error;
      }
      if (!inside(root, real)) throw new ProjectPathError(`${shown} is a link that leads outside the project (${real}); refusing to modify it.`);
    }
    const resolved = real === current ? stat : fsImpl.statSync(real);
    const wanted = last ? type : 'dir';
    if (wanted === 'dir' && !resolved.isDirectory()) throw new ProjectPathError(`${shown} exists but is not a directory.`);
    if (wanted === 'file' && !resolved.isFile()) throw new ProjectPathError(`${shown} is not a regular file.`);
    if (last) return { path: current, real, exists: true };
  }
  throw new ProjectPathError(`Empty path ${JSON.stringify(relative)}.`);
}
