import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import './build-scope-binding-userscript.mjs';
import { createOnlineLoader } from './scope-binding-online-loader.mjs';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const json = async file => JSON.parse(await read(file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pkg = await json('package.json');
const compatibility = await json('compatibility.json');
const current = compatibility.releases.find(r => r.patchVersion === pkg.version);
const offline = await json('酒馆助手脚本-数据库三层绑定补丁.json');
const source = await read('patches/shujuku-scope-binding-patch.js');
const header = `/*\n${await read('NOTICE')}*/\n`;
assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0');
assert.ok(source.startsWith(header), 'Source must retain the license URL and required notice.');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(offline.content, source);
assert.equal(current?.sourceSha256, sha256(source), 'Compatibility evidence must match this source.');
assert.equal(source.match(/const PATCH_VERSION = '([^']+)'/)?.[1], pkg.version);
assert.deepEqual(offline.data, {});

const base = 'https://cdn.jsdelivr.net/gh/huayueshan/shujuku-scope-binding';
const files = new Map([
  ['index.js', source],
  ['offline.json', `${JSON.stringify(offline, null, 2)}\n`],
]);
const channels = [
  { file: 'online-fixed.json', channel: 'fixed', ref: `v${pkg.version}` },
  { file: 'online-latest.json', channel: 'release' },
  { file: 'online-dev.json', channel: 'dev' },
];
for (const { file, channel, ref } of channels) {
  const loader = structuredClone(offline);
  loader.content = channel === 'fixed'
    ? `${header}import '${base}@${ref}/dist/index.js';\n`
    : createOnlineLoader(channel, await read('NOTICE'));
  loader.info = `${channel === 'fixed' ? `固定在线版 v${pkg.version}` : channel === 'dev' ? 'dev 最新测试版（仅供测试）' : '最新正式在线版（版本查询缓存10分钟，受 CDN 收录延迟影响）'}。${offline.info}`;
  files.set(file, `${JSON.stringify(loader, null, 2)}\n`);
}
const manifest = {
  schemaVersion: 1,
  version: pkg.version,
  status: current.status,
  repository: 'huayueshan/shujuku-scope-binding',
  license: pkg.license,
  licenseSha256: sha256(await read('LICENSE')),
  noticeSha256: sha256(await read('NOTICE')),
  sourceSha256: sha256(source),
  files: Object.fromEntries([...files].map(([file, content]) => [file, { sha256: sha256(content), bytes: Buffer.byteLength(content) }])),
};
await mkdir(new URL('dist/', root), { recursive: true });
for (const [file, content] of files) await writeFile(new URL(`dist/${file}`, root), content);
await writeFile(new URL('dist/manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${pkg.version}: offline, fixed, latest, private dev and manifest. No upload performed. Website unchanged.`);
