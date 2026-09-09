import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const source = await read('patches/shujuku-scope-binding-patch.js');
const notice = `/*\n${await read('NOTICE')}*/\n`;
assert.match(pkg.version, /^\d+\.\d+\.\d+-dev\.\d+$/);
assert.equal(source.match(/const PATCH_VERSION = '([^']+)'/)?.[1], pkg.version);
assert.ok(source.startsWith(notice));
const sha256 = createHash('sha256').update(source).digest('hex');
const manifest = {
  schemaVersion: 1,
  version: pkg.version,
  status: 'development',
  repository: 'huayueshan/shujuku-scope-binding',
  license: pkg.license,
  sourceSha256: sha256,
  files: { 'index.js': { sha256, bytes: Buffer.byteLength(source) } },
};
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/index.js', root), source);
await writeFile(new URL('dist/manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built dev ${pkg.version}: JavaScript and manifest only. No installer JSON or release created.`);
