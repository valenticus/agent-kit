import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { END_MARKER, START_MARKER, canonicalBlock, canonicalBlocks, decodeStrict, endMarker, locateBlock, normalizeEol, planUpdate, policyStatus, preflightUpdate, startMarker, update } from '../install/policy-block.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = fs.mkdtempSync(path.join(tmpdir(), 'agent-kit-policy-'));
let counter = 0;
let checks = 0;
const skipped = [];
const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
const project = (agents) => {
  const dir = path.join(workspace, `p${counter++}`);
  fs.mkdirSync(dir);
  if (agents !== undefined) fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
  return dir;
};
const read = (dir) => fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
const block = canonicalBlock();
const destructive = canonicalBlock(undefined, 'destructive-operations');
// Every shipped managed block, joined the way an update writes adjacent blocks.
const managed = canonicalBlocks().map((entry) => entry.block).join('\n\n');
const posix = process.platform !== 'win32';
const refuses = (dir) => {
  const before = fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  assert.throws(() => preflightUpdate(dir), /Git-authorship|marker/);
  assert.throws(() => update(dir), /Git-authorship|marker/);
  assert.deepEqual(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]), before, 'refusal must not mutate');
};

try {
  check('root and template each contain exactly one block, identical after EOL normalization', () => {
    const rootText = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const templateText = fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8');
    const normalizedRoot = normalizeEol(rootText);
    const found = locateBlock(normalizedRoot);
    const rootBlock = normalizedRoot.slice(found.begin, found.end);
    for (const text of [rootText, templateText]) {
      assert.equal(normalizeEol(text).split('\n').filter((line) => line.trim() === START_MARKER).length, 1);
      assert.equal(normalizeEol(text).split('\n').filter((line) => line.trim() === END_MARKER).length, 1);
    }
    assert.equal(normalizeEol(rootBlock), block);
    assert.ok(block.startsWith(START_MARKER) && block.endsWith(END_MARKER));
  });

  check('update: missing AGENTS.md -> created from the canonical template', () => {
    const dir = project();
    assert.equal(update(dir), 'create');
    assert.equal(read(dir), fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8'));
  });
  check('update: no blocks -> only the managed blocks are appended, project text preserved', () => {
    for (const [original, eol] of [['# Mine\n\nRule A\n', '\n'], ['# Mine\r\n\r\nRule A\r\n', '\r\n'], ['# Mine\n\nno trailing newline', '\n'], ['', '\n']]) {
      const dir = project(original);
      assert.equal(update(dir), 'append');
      const result = read(dir);
      assert.ok(result.startsWith(original));
      assert.equal(normalizeEol(result.slice(original.length)).trim(), managed);
      if (eol === '\r\n') assert.ok(!/(^|[^\r])\n/.test(result), 'CRLF file must stay CRLF');
      assert.equal(update(dir), 'noop', 'second run');
      assert.equal(read(dir), result);
    }
  });
  check('update: current blocks -> no-op, bytes unchanged (including CRLF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const dir = project(`# Mine${eol}${managed.replace(/\n/g, eol)}${eol}tail${eol}`);
      const before = read(dir);
      assert.equal(update(dir), 'noop');
      assert.equal(read(dir), before);
    }
  });
  check('update: stale block -> only the block replaced; text before and after preserved; idempotent', () => {
    for (const eol of ['\n', '\r\n']) {
      const stale = [START_MARKER, '## Git authorship', 'old policy text', END_MARKER].join(eol);
      const afterGit = canonicalBlocks().slice(1).map((entry) => entry.block).join('\n\n');
      const before = `# Mine${eol}project rule${eol}${eol}${stale}${eol}${eol}${afterGit.replace(/\n/g, eol)}${eol}${eol}## After${eol}keep me${eol}`;
      const dir = project(before);
      assert.equal(update(dir), 'replace');
      const result = read(dir);
      assert.ok(result.startsWith(`# Mine${eol}project rule${eol}${eol}`));
      assert.ok(result.endsWith(`${eol}${eol}## After${eol}keep me${eol}`));
      assert.ok(!result.includes('old policy text'));
      assert.ok(normalizeEol(result).includes(managed));
      if (eol === '\r\n') assert.ok(!/(^|[^\r])\n/.test(result));
      assert.equal(update(dir), 'noop');
      assert.equal(read(dir), result);
    }
  });
  check('update: malformed, duplicate, nested, reversed markers -> refusal before mutation', () => {
    const cases = {
      'start only': `# Mine\n${START_MARKER}\ntext\n`,
      'end only': `# Mine\ntext\n${END_MARKER}\n`,
      duplicate: `${block}\nmiddle\n${block}\n`,
      nested: `${START_MARKER}\n${START_MARKER}\ntext\n${END_MARKER}\n${END_MARKER}\n`,
      reversed: `${END_MARKER}\ntext\n${START_MARKER}\n`,
      'valid Git authorship, destructive-operations start only': `${block}\n\n${startMarker('destructive-operations')}\ntext\n`,
      'destructive-operations duplicated': `${block}\n\n${destructive}\n\n${destructive}\n`,
      'valid blocks, multi-agent end before start': `${block}\n\n${destructive}\n\n${endMarker('multi-agent')}\n${startMarker('multi-agent')}\n`,
    };
    for (const [name, content] of Object.entries(cases)) {
      const dir = project(content);
      try { refuses(dir); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    }
  });
  check('inline marker mentions are not treated as markers', () => {
    const dir = project(`Docs mention \`${START_MARKER}\` inline.\n`);
    assert.equal(update(dir), 'append');
  });

  // Marker strictness (L-2, L-3)
  check('markers must be the entire logical line', () => {
    for (const text of [` ${START_MARKER}\n${END_MARKER}\n`.replace(END_MARKER, `  ${END_MARKER}`), `${START_MARKER} extra\n${END_MARKER} extra\n`, `    ${START_MARKER}\n    ${END_MARKER}\n`, `\t${START_MARKER}\n`, `${START_MARKER}\u00a0\n`, `x ${END_MARKER}\n`]) {
      assert.equal(locateBlock(text), null, JSON.stringify(text));
    }
    assert.ok(locateBlock(`${START_MARKER}\r\nbody\r\n${END_MARKER}\r\n`), 'CRLF marker lines are still markers');
    assert.ok(locateBlock(`${START_MARKER}\nbody\n${END_MARKER}`), 'end marker without final newline');
    const fenced = `\`\`\`\n  ${START_MARKER}\n  ${END_MARKER}\n\`\`\`\n`;
    const dir = project(fenced);
    assert.equal(update(dir), 'append');
    assert.ok(read(dir).startsWith(fenced), 'indented/fenced examples are untouched');
  });
  check('suffixed look-alikes do not produce duplicate-block refusal and are preserved', () => {
    const original = `${START_MARKER} trailing\nprose\n`;
    const dir = project(original);
    assert.equal(update(dir), 'append');
    assert.ok(read(dir).startsWith(original));
  });

  // Encoding safety (M-3)
  check('decodeStrict accepts UTF-8 and reports a BOM; rejects UTF-16, NUL, invalid UTF-8', () => {
    assert.deepEqual(decodeStrict(Buffer.from('héllo')), { bom: false, text: 'héllo' });
    assert.deepEqual(decodeStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), { bom: true, text: 'a' });
    for (const bad of [Buffer.from([0xff, 0xfe, 0x61, 0x00]), Buffer.from([0xfe, 0xff, 0x00, 0x61]), Buffer.from('a\u0000b'), Buffer.from([0x61, 0xc3, 0x28]), Buffer.from('a', 'utf16le')]) {
      assert.throws(() => decodeStrict(bad), /UTF-16|NUL|UTF-8/);
    }
  });
  check('non-UTF-8 AGENTS.md is refused with the original bytes unchanged', () => {
    for (const bytes of [Buffer.from([0xff, 0xfe, ...Buffer.from('# Mine\n', 'utf16le')]), Buffer.from('# Mine\n', 'utf16le'), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]), Buffer.from('# a\u0000b\n')]) {
      const dir = project();
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), bytes);
      assert.throws(() => preflightUpdate(dir), /UTF-16|NUL|UTF-8/);
      assert.throws(() => update(dir), /UTF-16|NUL|UTF-8/);
      assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(bytes), 'bytes must be unchanged');
      assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md']);
    }
  });
  check('UTF-8 BOM is preserved on append, replace, and no-op; markers on the first line work', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const stale = `${START_MARKER}\nold\n${END_MARKER}\n`;
    for (const body of ['# Mine\n', stale, `${block}\n`]) {
      const dir = project();
      const original = Buffer.concat([bom, Buffer.from(body)]);
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), original);
      const action = update(dir);
      const after = fs.readFileSync(path.join(dir, 'AGENTS.md'));
      assert.ok(after.subarray(0, 3).equals(bom), `BOM kept (${action})`);
      assert.equal(after.subarray(3, 6).equals(bom), false, 'BOM not duplicated');
      if (action === 'noop') assert.ok(after.equals(original));
      assert.equal(update(dir), 'noop');
    }
    const doubled = project();
    const doubledBytes = Buffer.concat([bom, bom, Buffer.from('# Mine\n')]);
    fs.writeFileSync(path.join(doubled, 'AGENTS.md'), doubledBytes);
    update(doubled);
    assert.ok(fs.readFileSync(path.join(doubled, 'AGENTS.md')).subarray(0, doubledBytes.length).equals(doubledBytes), 'no BOM bytes silently dropped');
  });

  // Link, metadata, and cleanup safety (M-2, L-1, L-6)
  if (posix) {
    check('symlinked AGENTS.md: the real target is updated and the link is preserved', () => {
      const dir = project();
      fs.mkdirSync(path.join(dir, 'shared'));
      fs.writeFileSync(path.join(dir, 'shared', 'real.md'), '# Real\n');
      fs.symlinkSync('shared/real.md', path.join(dir, 'AGENTS.md'));
      assert.equal(update(dir), 'append');
      assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
      assert.equal(fs.readlinkSync(path.join(dir, 'AGENTS.md')), 'shared/real.md');
      const real = fs.readFileSync(path.join(dir, 'shared', 'real.md'), 'utf8');
      assert.ok(real.startsWith('# Real\n') && real.includes(START_MARKER));
      assert.equal(update(dir), 'noop');
      assert.deepEqual(fs.readdirSync(path.join(dir, 'shared')), ['real.md'], 'temp file created beside the real target and removed');
    });
    check('broken, circular, and directory-pointing links are refused with zero mutation', () => {
      const broken = project();
      fs.symlinkSync('missing.md', path.join(broken, 'AGENTS.md'));
      assert.throws(() => update(broken), /broken or circular/);
      assert.equal(fs.readlinkSync(path.join(broken, 'AGENTS.md')), 'missing.md');
      assert.deepEqual(fs.readdirSync(broken), ['AGENTS.md']);
      const loop = project();
      fs.symlinkSync('AGENTS.md', path.join(loop, 'AGENTS.md'));
      assert.throws(() => update(loop), /broken or circular/);
      const toDir = project();
      fs.mkdirSync(path.join(toDir, 'd'));
      fs.symlinkSync('d', path.join(toDir, 'AGENTS.md'));
      assert.throws(() => update(toDir), /not a regular file/);
      assert.deepEqual(fs.readdirSync(toDir).sort(), ['AGENTS.md', 'd']);
    });
    check('file mode is preserved on replace and append', () => {
      for (const body of ['# Mine\n', `${START_MARKER}\nold\n${END_MARKER}\n`]) {
        const dir = project(body);
        fs.chmodSync(path.join(dir, 'AGENTS.md'), 0o640);
        update(dir);
        assert.equal(fs.statSync(path.join(dir, 'AGENTS.md')).mode & 0o777, 0o640);
      }
    });
    check('CLI runs when invoked through a symlinked path (no silent no-op)', () => {
      const linkDir = path.join(workspace, 'linked-kit');
      fs.symlinkSync(path.join(root, 'scripts', 'install'), linkDir);
      const dir = project('# Mine\n');
      const viaDirLink = spawnSync(process.execPath, [path.join(linkDir, 'policy-block.mjs'), 'update', '--project', dir], { encoding: 'utf8' });
      assert.equal(viaDirLink.status, 0, viaDirLink.stderr);
      assert.match(viaDirLink.stdout, /Policy block: noop|Policy block: append/);
      assert.ok(read(dir).includes(START_MARKER));
      const fileLink = path.join(workspace, 'policy-link.mjs');
      fs.symlinkSync(path.join(root, 'scripts', 'install', 'policy-block.mjs'), fileLink);
      const usage = spawnSync(process.execPath, [fileLink], { encoding: 'utf8' });
      assert.equal(usage.status, 2);
      assert.match(usage.stderr, /usage/);
    });
  } else skipped.push('symlink, mode, and linked-entrypoint cases (non-POSIX host)');
  check('temp file is removed on write or rename failure and the original error surfaces', () => {
    const failing = (name) => ({ ...fs, [name]: (...args) => { if (name === 'writeFileSync') fs.writeFileSync(...args); throw new Error(`injected ${name} failure`); } });
    for (const name of ['writeFileSync', 'renameSync']) {
      const dir = project('# Mine\n');
      const before = fs.readFileSync(path.join(dir, 'AGENTS.md'));
      const impl = name === 'renameSync' ? { ...fs, renameSync: () => { throw new Error('injected renameSync failure'); } } : failing(name);
      assert.throws(() => update(dir, undefined, { fsImpl: impl }), new RegExp(`injected ${name} failure`));
      assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md'], `${name}: no leftover temp file`);
      assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(before));
    }
  });
  // validate-install policy reporting: warn on missing/stale policy, pass cleanly when current, fail on malformed markers.
  const installValidator = path.join(root, 'scripts', 'validation', 'validate-install.mjs');
  const installedProject = (agents) => {
    const dir = project(agents);
    fs.mkdirSync(path.join(dir, '.agents', 'skills', 'safe-change'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'skills', 'safe-change', 'SKILL.md'), '---\nname: safe-change\ndescription: x\n---\n');
    return dir;
  };
  const validateInstall = (dir) => spawnSync(process.execPath, [installValidator, dir], { encoding: 'utf8' });
  check('validate-install: current policy -> no warning, exit 0', () => {
    const current = validateInstall(installedProject(fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8')));
    assert.equal(current.status, 0, current.stderr);
    assert.ok(!/warning:/i.test(current.stderr), current.stderr);
    const crlf = validateInstall(installedProject(normalizeEol(fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8')).replace(/\n/g, '\r\n')));
    assert.ok(crlf.status === 0 && !/warning:/i.test(crlf.stderr), 'CRLF copy of the current policy is not stale');
  });
  check('validate-install: missing AGENTS.md / missing block / stale block warn but pass', () => {
    const missingFile = validateInstall(installedProject());
    assert.equal(missingFile.status, 0);
    assert.match(missingFile.stderr, /warning: no root AGENTS\.md/);
    const missingBlock = validateInstall(installedProject('# Mine\n'));
    assert.equal(missingBlock.status, 0);
    assert.match(missingBlock.stderr, /warning: AGENTS\.md lacks the managed Git-authorship block/);
    const stale = validateInstall(installedProject(`${START_MARKER}\nold\n${END_MARKER}\n`));
    assert.equal(stale.status, 0);
    assert.match(stale.stderr, /warning: AGENTS\.md Git-authorship block is stale/);
  });
  check('validate-install: malformed markers fail', () => {
    for (const content of [`${START_MARKER}\n`, `${block}\n${block}\n`, `${END_MARKER}\n${START_MARKER}\n`]) {
      const result = validateInstall(installedProject(content));
      assert.equal(result.status, 1, content);
      assert.match(result.stderr, /Git-authorship markers|end marker appears before/);
    }
  });
  check('AGENTS.md that is a directory -> refusal', () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, 'AGENTS.md'));
    assert.throws(() => update(dir), /not a regular file/);
  });
  check('CLI: update/preflight exit codes and no unrelated files', () => {
    const cli = path.join(root, 'scripts', 'install', 'policy-block.mjs');
    const dir = project('# Mine\n');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    assert.equal(spawnSync(process.execPath, [cli, 'preflight-update', '--project', dir]).status, 0);
    assert.equal(spawnSync(process.execPath, [cli, 'update', '--project', dir]).status, 0);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['AGENTS.md', 'other.txt']);
    const bad = project(`${START_MARKER}\n`);
    const refused = spawnSync(process.execPath, [cli, 'update', '--project', bad], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused/);
  });
  check('planUpdate is pure (no writes)', () => {
    const dir = project('# Mine\n');
    planUpdate(read(dir));
    assert.equal(read(dir), '# Mine\n');
  });

  // Placement and refusal mechanics with several named policies, independent of the shipped policy set: a disposable
  // kit root whose template holds Git authorship followed by two example policies.
  const templateText = fs.readFileSync(path.join(root, 'templates', 'project-rules', 'AGENTS.md'), 'utf8');
  const example = (policy, body) => `${startMarker(policy)}\n## ${policy}\n${body}\n${endMarker(policy)}`;
  const alpha = example('example-alpha', 'alpha rule');
  const beta = example('example-beta', 'beta rule');
  const kit = (template) => {
    const dir = path.join(workspace, `kit${counter++}`);
    fs.mkdirSync(path.join(dir, 'templates', 'project-rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'templates', 'project-rules', 'AGENTS.md'), template);
    return dir;
  };
  const multiKit = kit(`# Rules\n\n${block}\n\n${alpha}\n\n${beta}\n`);
  const crlf = (text) => normalizeEol(text).replace(/\n/g, '\r\n');
  const refusesWith = (dir, kitRoot, pattern) => {
    const before = fs.readFileSync(path.join(dir, 'AGENTS.md'));
    assert.throws(() => preflightUpdate(dir, kitRoot), pattern);
    assert.throws(() => update(dir, kitRoot), pattern);
    assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(before), 'refusal must not mutate');
    assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md'], 'refusal must not leave files');
  };
  check('managed policies are discovered from the template in order', () => {
    assert.deepEqual(canonicalBlocks().map((entry) => entry.policy), ['git-authorship', 'destructive-operations', 'multi-agent']);
    assert.deepEqual(canonicalBlocks(multiKit).map((entry) => entry.policy), ['git-authorship', 'example-alpha', 'example-beta']);
    assert.equal(canonicalBlock(multiKit), block, 'Git-authorship block is unchanged by other policies');
    assert.equal(canonicalBlock(multiKit, 'example-beta'), beta);
  });
  check('multiple: v1.8.0-shaped projects gain missing blocks after Git authorship; project text, EOL, and BOM kept; idempotent', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const [eol, prefix] of [['\n', Buffer.alloc(0)], ['\r\n', Buffer.alloc(0)], ['\n', bom], ['\r\n', bom]]) {
      const original = `# Mine${eol}rule${eol}${eol}${block.replace(/\n/g, eol)}${eol}${eol}## After${eol}keep me${eol}`;
      const dir = project();
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), Buffer.concat([prefix, Buffer.from(original)]));
      assert.equal(update(dir, multiKit), 'append');
      const bytes = fs.readFileSync(path.join(dir, 'AGENTS.md'));
      assert.equal(bytes.subarray(0, 3).equals(bom), prefix.length > 0, 'BOM kept as it was');
      const result = bytes.subarray(prefix.length).toString('utf8');
      assert.equal(result, `# Mine${eol}rule${eol}${eol}${[block, alpha, beta].join('\n\n').replace(/\n/g, eol)}${eol}${eol}## After${eol}keep me${eol}`);
      if (eol === '\r\n') assert.ok(!/(^|[^\r])\n/.test(result), 'CRLF file must stay CRLF');
      assert.equal(update(dir, multiKit), 'noop');
      assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(bytes), 'second run is byte-identical');
    }
    const fromTemplate = project(templateText);
    assert.equal(update(fromTemplate, multiKit), 'append');
    // The checkout may store the template with CRLF; the update keeps whichever EOL the file uses.
    const expected = normalizeEol(templateText).replace(block, `${block}\n\n${alpha}\n\n${beta}`);
    assert.equal(read(fromTemplate), templateText.includes('\r\n') ? crlf(expected) : expected, 'template-created project: only the new blocks are inserted');
  });
  check('multiple: no managed blocks -> all appended at the end in template order', () => {
    for (const original of ['# Mine\n', '# Mine', '']) {
      const dir = project(original);
      assert.equal(update(dir, multiKit), 'append');
      const separator = original === '' ? '' : original.endsWith('\n') ? '\n' : '\n\n';
      assert.equal(read(dir), `${original}${separator}${block}\n\n${alpha}\n\n${beta}\n`);
      assert.equal(update(dir, multiKit), 'noop');
    }
  });
  check('multiple: blocks update independently; current blocks stay byte-identical', () => {
    const staleAlpha = example('example-alpha', 'old alpha');
    const dir = project(`# Mine\n\n${block}\n\nbetween\n\n${staleAlpha}\n\n${beta}\n\ntail\n`);
    const plan = planUpdate(read(dir), multiKit);
    assert.equal(plan.action, 'replace');
    assert.deepEqual(plan.changes, [{ policy: 'example-alpha', action: 'replace' }]);
    assert.equal(update(dir, multiKit), 'replace');
    assert.equal(read(dir), `# Mine\n\n${block}\n\nbetween\n\n${alpha}\n\n${beta}\n\ntail\n`);
    assert.equal(update(dir, multiKit), 'noop');
  });
  check('multiple: stale and missing blocks in one update; missing earlier blocks go before the next present block', () => {
    const staleGit = `${START_MARKER}\nold policy text\n${END_MARKER}`;
    const mixed = project(crlf(`# Mine\n\n${staleGit}\n\n${beta}\n\ntail\n`));
    const plan = planUpdate(read(mixed), multiKit);
    assert.equal(plan.action, 'update');
    assert.deepEqual(plan.changes, [{ policy: 'git-authorship', action: 'replace' }, { policy: 'example-alpha', action: 'append' }]);
    assert.equal(update(mixed, multiKit), 'update');
    assert.equal(read(mixed), crlf(`# Mine\n\n${block}\n\n${alpha}\n\n${beta}\n\ntail\n`));
    assert.equal(update(mixed, multiKit), 'noop');
    const onlyLast = project(`# Mine\n\n${beta}\n\ntail\n`);
    assert.equal(update(onlyLast, multiKit), 'append');
    assert.equal(read(onlyLast), `# Mine\n\n${block}\n\n${alpha}\n\n${beta}\n\ntail\n`);
    const staleLast = project(`# Mine\n\n${example('example-beta', 'old beta')}\n`);
    assert.equal(update(staleLast, multiKit), 'update');
    assert.equal(read(staleLast), `# Mine\n\n${block}\n\n${alpha}\n\n${beta}\n`);
  });
  check('multiple: one malformed, duplicate, reversed, or overlapping block refuses the whole update with zero mutation', () => {
    const staleGit = `${START_MARKER}\nold policy text\n${END_MARKER}`;
    const cases = {
      'start only': [`${staleGit}\n\n${startMarker('example-alpha')}\nalpha\n`, /1 start and 0 end example-alpha markers/],
      duplicate: [`${staleGit}\n\n${beta}\n\n${beta}\n`, /example-beta markers/],
      reversed: [`${staleGit}\n\n${endMarker('example-alpha')}\n${startMarker('example-alpha')}\n`, /example-alpha end marker appears before/],
      'nested in Git authorship': [`${START_MARKER}\nold\n${alpha}\n${END_MARKER}\n`, /overlap or are nested/],
      'Git authorship nested': [`${startMarker('example-beta')}\n${block}\n${endMarker('example-beta')}\n`, /overlap or are nested/],
      interleaved: [`${START_MARKER}\n${startMarker('example-alpha')}\n${END_MARKER}\n${endMarker('example-alpha')}\n`, /overlap or are nested/],
    };
    for (const [name, [content, pattern]] of Object.entries(cases)) {
      for (const text of [content, crlf(content)]) {
        const dir = project(text);
        try { refusesWith(dir, multiKit, pattern); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      }
    }
  });
  check('multiple: markers of policies absent from the template are ordinary project text', () => {
    const foreign = `${startMarker('future-policy')}\nkeep\n`;
    const dir = project(`# Mine\n${foreign}`);
    assert.equal(update(dir, multiKit), 'append');
    assert.ok(read(dir).startsWith(`# Mine\n${foreign}`));
    assert.equal(update(dir, multiKit), 'noop');
  });
  check('policyStatus reports missing, stale, and current per policy', () => {
    const text = `${block}\n\n${example('example-alpha', 'old')}\n`;
    assert.deepEqual(policyStatus(text, multiKit).map(({ policy, state }) => [policy, state]), [['git-authorship', 'current'], ['example-alpha', 'stale'], ['example-beta', 'missing']]);
    assert.deepEqual(policyStatus(crlf(text), multiKit).map(({ state }) => state), ['current', 'stale', 'missing']);
    assert.throws(() => policyStatus(`${beta}\n${beta}\n`, multiKit), /example-beta markers/);
  });
  check('an invalid canonical template refuses every update with zero mutation', () => {
    const invalid = {
      'duplicate policy': [kit(`${templateText}\n${alpha}\n\n${alpha}\n`), /Canonical template is invalid/],
      'overlapping policies': [kit(`${templateText}\n${startMarker('example-alpha')}\n${beta}\n${endMarker('example-alpha')}\n`), /Canonical template is invalid/],
      'no Git authorship': [kit(`# Rules\n\n${alpha}\n`), /lacks the managed Git-authorship block/],
      'invalid policy name': [kit(`${templateText}\n<!-- agent-kit:Bad_Name:start -->\n<!-- agent-kit:Bad_Name:end -->\n`), /invalid managed policy name/],
    };
    for (const [name, [badKit, pattern]] of Object.entries(invalid)) {
      const dir = project(`# Mine\n\n${block}\n`);
      try { refusesWith(dir, badKit, pattern); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    }
  });
  check('older projects (v1.8.0: Git authorship only; earlier v1.9.0 work: fewer blocks) gain only the missing blocks after their managed blocks; project text, EOL, and BOM kept; idempotent', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const shipped = canonicalBlocks().map((entry) => entry.block);
    assert.equal(normalizeEol(templateText).split(managed).length, 2, 'the template keeps its managed blocks adjacent');
    // Each shorter prefix of the shipped policy list is an older project's managed set; v1.8.0 had only Git authorship.
    for (let count = 1; count < shipped.length; count++) {
      const older = shipped.slice(0, count).join('\n\n');
      const olderTemplate = normalizeEol(templateText).replace(managed, older);
      assert.ok(!olderTemplate.includes(startMarker(canonicalBlocks()[count].policy)));
      for (const text of [olderTemplate, `# Project rules\n\n${older}\n`, `# Project rules\n${older}\n\n## Mine\nkeep\n`]) {
        const expected = text.replace(older, managed);
        for (const [encode, prefix] of [[(value) => value, Buffer.alloc(0)], [crlf, Buffer.alloc(0)], [crlf, bom]]) {
          const dir = project();
          fs.writeFileSync(path.join(dir, 'AGENTS.md'), Buffer.concat([prefix, Buffer.from(encode(text))]));
          assert.equal(update(dir), 'append');
          const after = fs.readFileSync(path.join(dir, 'AGENTS.md'));
          assert.ok(after.equals(Buffer.concat([prefix, Buffer.from(encode(expected))])), 'only the missing blocks are inserted');
          assert.equal(update(dir), 'noop');
          assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(after), 'second run is byte-identical');
        }
      }
    }
  });

  console.log(`Validated ${checks} managed policy block checks (canonical parity, marker strictness, encoding/BOM, links, mode, temp cleanup, entrypoint, create/append/replace/no-op, malformed refusal, EOL, idempotency, multiple named policies with independent updates, placement, all-or-nothing refusal, and upgrades from v1.8.0 and earlier policy sets).${skipped.length ? ` Not exercised on this host: ${skipped.join('; ')}.` : ''}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
