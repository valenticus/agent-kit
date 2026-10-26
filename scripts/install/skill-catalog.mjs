// Catalog of every released content version of the skills Agent Kit distributes (core and vendored optional).
//   node skill-catalog.mjs generate   rebuild scripts/install/skill-catalog.json from release tags and the working tree
//   node skill-catalog.mjs check      rebuild in memory and fail if the committed catalog differs
// Both commands are maintainer tools and need the full Git history with release tags. Ordinary validation only reads
// the committed catalog. A content hash is SHA-256 of the file after CRLF -> LF normalization, so CRLF checkouts match.
// A matching hash proves that installed content is identical to a released version, not where that content came from.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CATALOG_RELATIVE = 'scripts/install/skill-catalog.json';
export const FORMAT = 1;
export const HASH = 'sha256-lf';
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const DIGEST = /^[0-9a-f]{64}$/;

export class CatalogError extends Error {}

export function normalizedHash(buffer) {
  // latin1 maps every byte to one code unit, so only CR LF byte pairs change.
  return createHash('sha256').update(Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');
}

export function compareReleases(a, b) {
  const [x, y] = [RELEASE.exec(a), RELEASE.exec(b)];
  for (let index = 1; index <= 3; index++) if (Number(x[index]) !== Number(y[index])) return Number(x[index]) - Number(y[index]);
  return 0;
}

// Relative, forward-slash, no empty, '.', or '..' segments, no drive or control characters.
export function isSafeRelativePath(value) {
  return typeof value === 'string' && value !== '' && !/[\\:\0-\x1f]/.test(value) && !value.startsWith('/')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameFiles = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
};

// Skills distributed from this kit checkout: core directories and vendored optional modules.
export function distributedSkills(root = kitRoot) {
  const skills = new Map();
  for (const entry of fs.readdirSync(path.join(root, 'core', 'skills'), { withFileTypes: true })) {
    if (entry.isDirectory()) skills.set(entry.name, { kind: 'core', dir: path.join(root, 'core', 'skills', entry.name) });
  }
  const optional = JSON.parse(fs.readFileSync(path.join(root, 'optional', 'catalog.json'), 'utf8'));
  for (const [name, module] of Object.entries(optional)) {
    if (module.kind !== 'vendored') continue;
    if (skills.has(name)) throw new CatalogError(`${name} is both a core skill and a vendored module.`);
    skills.set(name, { kind: 'vendored', dir: path.join(root, module.path) });
  }
  return skills;
}

// Hashes of every regular file under dir, keyed by relative forward-slash path. Links and special files are refused.
export function directoryFiles(dir, fsImpl = fs) {
  const files = {};
  const walk = (current, prefix) => {
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true }).map((item) => item.name).sort(byCodeUnit)) {
      const absolute = path.join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = fsImpl.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) files[relative] = normalizedHash(fsImpl.readFileSync(absolute));
      else throw new CatalogError(`${absolute} is a link or special file.`);
    }
  };
  walk(dir, '');
  return files;
}

// snapshots: [{ release, skills: { name: { kind, files } } }]. Returns the catalog object in canonical order.
export function buildCatalog(snapshots) {
  const ordered = [...snapshots].sort((a, b) => compareReleases(a.release, b.release));
  const releases = ordered.map((snapshot) => snapshot.release);
  if (new Set(releases).size !== releases.length) throw new CatalogError('A release appears in more than one snapshot.');
  const skills = {};
  for (const { release, skills: present } of ordered) {
    for (const [name, { kind, files }] of Object.entries(present)) {
      const entry = skills[name] ??= { kind, versions: [] };
      if (entry.kind !== kind) throw new CatalogError(`${name} changes kind between releases.`);
      const sorted = Object.fromEntries(Object.keys(files).sort(byCodeUnit).map((key) => [key, files[key]]));
      const known = entry.versions.find((version) => sameFiles(version.files, sorted));
      if (known) known.releases.push(release);
      else entry.versions.push({ releases: [release], files: sorted });
    }
  }
  return { format: FORMAT, hash: HASH, releases, skills: Object.fromEntries(Object.keys(skills).sort(byCodeUnit).map((name) => [name, skills[name]])) };
}

export const serializeCatalog = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;

export function loadCatalog(root = kitRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, CATALOG_RELATIVE), 'utf8'));
}

export const currentVersion = (root = kitRoot) => fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

// Structural and consistency problems of a catalog against this kit checkout; an empty list means valid.
export function catalogErrors(catalog, root = kitRoot, version = currentVersion(root)) {
  const errors = [];
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const sortedReleases = (list) => Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === 'string' && RELEASE.test(item))
    && list.every((item, index) => index === 0 || compareReleases(list[index - 1], item) < 0);
  if (!isObject(catalog)) return ['catalog is not a JSON object'];
  if (catalog.format !== FORMAT) errors.push(`format must be ${FORMAT}`);
  if (catalog.hash !== HASH) errors.push(`hash must be "${HASH}"`);
  if (!sortedReleases(catalog.releases)) errors.push('releases must be a non-empty, strictly increasing list of MAJOR.MINOR.PATCH');
  else if (catalog.releases.at(-1) !== version) errors.push(`releases must end with the current VERSION ${version}`);
  if (!isObject(catalog.skills)) return [...errors, 'skills must be an object'];
  const names = Object.keys(catalog.skills);
  if (names.join('\n') !== [...names].sort(byCodeUnit).join('\n')) errors.push('skills must be sorted by name');
  const distributed = distributedSkills(root);
  for (const name of names) if (!distributed.has(name)) errors.push(`${name}: not a skill this kit distributes`);
  for (const [name, { kind, dir }] of distributed) {
    const entry = catalog.skills[name];
    if (!isObject(entry)) { errors.push(`${name}: missing from the catalog`); continue; }
    if (entry.kind !== kind) errors.push(`${name}: kind must be "${kind}"`);
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) { errors.push(`${name}: versions must be a non-empty list`); continue; }
    const seenReleases = new Map();
    entry.versions.forEach((candidate, index) => {
      const label = `${name} version ${index + 1}`;
      if (!isObject(candidate) || !sortedReleases(candidate.releases) || !isObject(candidate.files) || Object.keys(candidate.files).length === 0) {
        errors.push(`${label}: needs sorted releases and a non-empty files object`);
        return;
      }
      for (const release of candidate.releases) {
        if (Array.isArray(catalog.releases) && !catalog.releases.includes(release)) errors.push(`${label}: unknown release ${release}`);
        if (seenReleases.has(release)) errors.push(`${name}: release ${release} is ambiguous (versions ${seenReleases.get(release)} and ${index + 1})`);
        seenReleases.set(release, index + 1);
      }
      const files = Object.keys(candidate.files);
      if (files.join('\n') !== [...files].sort(byCodeUnit).join('\n')) errors.push(`${label}: files must be sorted by path`);
      for (const file of files) {
        if (!isSafeRelativePath(file)) errors.push(`${label}: unsafe path ${JSON.stringify(file)}`);
        if (typeof candidate.files[file] !== 'string' || !DIGEST.test(candidate.files[file])) errors.push(`${label}: ${file} needs a lowercase SHA-256 hex digest`);
      }
      entry.versions.slice(0, index).forEach((earlier, earlierIndex) => {
        if (isObject(earlier?.files) && sameFiles(earlier.files, candidate.files)) errors.push(`${name}: versions ${earlierIndex + 1} and ${index + 1} have identical content`);
      });
      if (index > 0 && sortedReleases(entry.versions[index - 1]?.releases) && compareReleases(entry.versions[index - 1].releases[0], candidate.releases[0]) >= 0) {
        errors.push(`${name}: versions must be ordered by first release`);
      }
    });
    const current = entry.versions.find((candidate) => Array.isArray(candidate?.releases) && candidate.releases.includes(version));
    if (!current) errors.push(`${name}: no version lists the current VERSION ${version}`);
    else {
      let files;
      try { files = directoryFiles(dir); } catch (error) { errors.push(`${name}: ${error.message}`); continue; }
      if (!isObject(current.files) || !sameFiles(files, current.files)) errors.push(`${name}: the working tree differs from the catalog entry for ${version}; regenerate the catalog`);
    }
  }
  return errors;
}

// --- Maintainer generation from Git history -------------------------------------------------------------------------

const git = (root, args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });

function tagSnapshot(root, tag, release, blobHashes) {
  const listing = git(root, ['ls-tree', '-r', '-z', '--full-tree', `${tag}^{commit}`, '--', 'core/skills', 'optional/vendored']);
  const skills = {};
  for (const record of listing.split('\0').filter(Boolean)) {
    const [meta, file] = record.split('\t');
    const [mode, type, oid] = meta.split(' ');
    const parts = file.split('/');
    if (parts.length < 4) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new CatalogError(`${tag}:${file} is not a regular file (mode ${mode}).`);
    const kind = parts[0] === 'core' ? 'core' : 'vendored';
    const skill = skills[parts[2]] ??= { kind, files: {} };
    if (!blobHashes.has(oid)) blobHashes.set(oid, normalizedHash(git(root, ['cat-file', 'blob', oid], 'buffer')));
    skill.files[parts.slice(3).join('/')] = blobHashes.get(oid);
  }
  return { release, skills };
}

export function generateCatalog(root = kitRoot) {
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new CatalogError('The repository is shallow; fetch the full history and tags first.');
  const version = currentVersion(root);
  if (!RELEASE.test(version)) throw new CatalogError(`VERSION ${version} is not MAJOR.MINOR.PATCH.`);
  const tags = git(root, ['tag', '--list', 'v*']).split('\n').filter((tag) => RELEASE.test(tag.slice(1)));
  const used = tags.map((tag) => tag.slice(1)).filter((release) => compareReleases(release, version) <= 0).sort(compareReleases);
  const ignored = tags.filter((tag) => compareReleases(tag.slice(1), version) > 0);
  if (used.length === 0) throw new CatalogError('No release tags were found; fetch tags first.');
  const blobHashes = new Map();
  const snapshots = used.map((release) => tagSnapshot(root, `v${release}`, release, blobHashes));
  const tree = { release: version, skills: {} };
  for (const [name, { kind, dir }] of distributedSkills(root)) tree.skills[name] = { kind, files: directoryFiles(dir) };
  const tagged = snapshots.find((snapshot) => snapshot.release === version);
  if (tagged) {
    const names = new Set([...Object.keys(tagged.skills), ...Object.keys(tree.skills)]);
    for (const name of names) {
      if (!tagged.skills[name] || !tree.skills[name] || !sameFiles(tagged.skills[name].files, tree.skills[name].files)) {
        throw new CatalogError(`${name} differs from release tag v${version}; bump VERSION before changing distributed skills.`);
      }
    }
  } else snapshots.push(tree);
  return { catalog: buildCatalog(snapshots), tags: used.map((release) => `v${release}`), ignored, workingTreeRelease: tagged ? null : version };
}

function main(argv) {
  const [command] = argv;
  if (!['generate', 'check'].includes(command)) { console.error('usage: skill-catalog.mjs <generate|check>'); return 2; }
  try {
    const { catalog, tags, ignored, workingTreeRelease } = generateCatalog();
    const text = serializeCatalog(catalog);
    const target = path.join(kitRoot, CATALOG_RELATIVE);
    const summary = `${Object.keys(catalog.skills).length} skills from tags ${tags.join(', ')}${workingTreeRelease ? ` and the working tree as ${workingTreeRelease}` : ''}${ignored.length ? `; ignored newer tags ${ignored.join(', ')}` : ''}`;
    if (command === 'check') {
      const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
      if (committed !== text) { console.error(`Skill catalog is out of date (${summary}); run: node ${CATALOG_RELATIVE.replace('.json', '.mjs')} generate`); return 1; }
      console.log(`Skill catalog is current: ${summary}.`);
      return 0;
    }
    fs.writeFileSync(target, text);
    console.log(`Wrote ${CATALOG_RELATIVE}: ${summary}.`);
    return 0;
  } catch (error) {
    if (error instanceof CatalogError) { console.error(`Skill catalog refused: ${error.message}`); return 1; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
