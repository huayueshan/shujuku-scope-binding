import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const pwsh = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell/7/pwsh.exe')
  : 'pwsh';
const available = process.platform === 'win32' ? existsSync(pwsh)
  : spawnSync(pwsh, ['--version'], { stdio: 'ignore' }).status === 0;

async function fixture(t) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(path.join(runtime, 'archive-test-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(runtime) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const files = JSON.parse(await readFile(path.join(root, 'release-files.json'), 'utf8'));
  for (const file of files) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  return directory;
}

function run(directory, validate = true) {
  const script = path.join(directory, 'scripts/package-release.ps1').replaceAll("'", "''");
  return spawnSync(pwsh, ['-NoProfile', '-Command',
    `if (Get-Command set-encoding -ErrorAction SilentlyContinue) { set-encoding | Out-Null }\n& '${script}' ${validate ? '-ValidateOnly' : ''}`],
  { cwd: directory, encoding: 'utf8', timeout: 60000 });
}

async function mutate(directory, file, updater) {
  const full = path.join(directory, file);
  const object = JSON.parse(await readFile(full, 'utf8'));
  updater(object);
  await writeFile(full, JSON.stringify(object, null, 2) + '\n');
}

test('archive round trip is reproducible and validation writes no archive', { skip: !available }, async t => {
  const directory = await fixture(t);
  const first = run(directory);
  assert.equal(first.status, 0, first.stderr);
  const second = run(directory);
  assert.equal(second.status, 0, second.stderr);
  const report = result => JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(report(first), report(second));
  assert.equal(report(first).archiveWritten, false);
  assert.equal(existsSync(path.join(directory, '.runtime')), false);
});

test('unconfirmed license blocks archive output', { skip: !available }, async t => {
  const directory = await fixture(t);
  await mutate(directory, 'package.json', p => { p.license = 'UNLICENSED'; });
  const result = run(directory, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /License is missing or unconfirmed/);
  assert.equal(existsSync(path.join(directory, '.runtime')), false);
});

test('licensed candidate archive matches the validated bytes', { skip: !available }, async t => {
  const directory = await fixture(t);
  const validation = run(directory);
  assert.equal(validation.status, 0, validation.stderr);
  const result = run(directory, false);
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'dist/manifest.json'), 'utf8'));
  const suffix = manifest.status === 'candidate' ? '-candidate' : '';
  const zip = await readFile(path.join(directory, `.runtime/shujuku-scope-binding-v${pkg.version}${suffix}.zip`));
  const expected = JSON.parse(validation.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(createHash('sha256').update(zip).digest('hex'), expected.sha256);
});

test('changed artifacts fail before an archive is written', { skip: !available }, async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'dist/index.js'), '// changed\n');
  const result = run(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Artifact changed since build/);
});

test('duplicate and traversal entries are rejected', { skip: !available }, async t => {
  const directory = await fixture(t);
  const original = await readFile(path.join(directory, 'release-files.json'), 'utf8');
  await mutate(directory, 'release-files.json', files => { files.push(files[0]); });
  assert.match(run(directory).stderr, /Duplicate archive paths/);
  await writeFile(path.join(directory, 'release-files.json'), original);
  await mutate(directory, 'release-files.json', files => { files.push('../outside.json'); });
  assert.match(run(directory).stderr, /Unsafe archive path/);
});

test('stale license and missing manifest artifacts are rejected', { skip: !available }, async t => {
  const directory = await fixture(t);
  const original = await readFile(path.join(directory, 'dist/manifest.json'), 'utf8');
  await mutate(directory, 'dist/manifest.json', m => { m.license = 'LicenseRef-TestMismatch'; });
  assert.match(run(directory).stderr, /Manifest license mismatch/);
  await writeFile(path.join(directory, 'dist/manifest.json'), original);
  await mutate(directory, 'dist/manifest.json', m => { delete m.files['offline.json']; });
  assert.match(run(directory).stderr, /Unexpected manifest artifacts/);
});
