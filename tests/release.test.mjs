import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { createOnlineLoader } from '../scripts/scope-binding-online-loader.mjs';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const json = async file => JSON.parse(await read(file));
const sha = s => createHash('sha256').update(s).digest('hex');

test('the approved noncommercial license and required notice accompany all channels', async () => {
  const pkg = await json('package.json');
  const manifest = await json('dist/manifest.json');
  const license = await read('LICENSE');
  const notice = await read('NOTICE');
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0');
  assert.equal(manifest.license, pkg.license);
  assert.equal(sha(license), 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5');
  assert.equal(manifest.licenseSha256, sha(license));
  assert.equal(manifest.noticeSha256, sha(notice));
  assert.match(notice, /^Required Notice: Copyright \(c\) 2026 huayueshan$/m);
  for (const file of ['offline.json', 'online-fixed.json', 'online-latest.json']) {
    assert.ok((await json(`dist/${file}`)).content.startsWith(`/*\n${notice}*/\n`));
  }
});

test('release manifest hashes and sizes match every generated artifact', async () => {
  const manifest = await json('dist/manifest.json');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['index.js', 'offline.json', 'online-dev.json', 'online-fixed.json', 'online-latest.json']);
  for (const [file, expected] of Object.entries(manifest.files)) {
    const text = await read(`dist/${file}`);
    assert.equal(sha(text), expected.sha256, file);
    assert.equal(Buffer.byteLength(text), expected.bytes, file);
  }
  assert.equal(manifest.sourceSha256, sha(await read('patches/shujuku-scope-binding-patch.js')));
});

test('three channels share an upgrade identity and contain no exported user state', async () => {
  const offline = await json('dist/offline.json');
  const pkg = await json('package.json');
  for (const [file, ref] of [['online-fixed.json', `v${pkg.version}`], ['online-latest.json', 'release'], ['online-dev.json', 'dev']]) {
    const loader = await json(`dist/${file}`);
    assert.deepEqual({ ...loader, content: offline.content, info: offline.info }, offline);
    const expected = ref.startsWith('v')
      ? `/*\n${await read('NOTICE')}*/\nimport 'https://cdn.jsdelivr.net/gh/huayueshan/shujuku-scope-binding@${ref}/dist/index.js';\n`
      : createOnlineLoader(ref, await read('NOTICE'));
    assert.equal(loader.content, expected);
  }
  assert.deepEqual(offline.data, {});
  assert.deepEqual(offline.button.buttons, []);
  assert.equal(offline.content, await read('dist/index.js'));
});

test('offline payload executes its shared logic in isolation', async () => {
  const core = {};
  vm.runInNewContext((await json('dist/offline.json')).content, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core });
  assert.equal(typeof core.findDatabaseFrameCore, 'function');
  assert.deepEqual([...core.uniqueNames(['A', 'A', '', 'B'])], ['A', 'B']);
});

test('both online payloads import and execute the exact packaged module without network', async () => {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run release tests with --experimental-vm-modules.');
  for (const file of ['online-fixed.json', 'online-latest.json', 'online-dev.json']) {
    const core = {};
    const pkg = await json('package.json');
    const version = file === 'online-dev.json' ? `${pkg.version}-dev.1` : pkg.version;
    const source = await read('dist/index.js');
    let blob;
    const seen = [];
    const context = vm.createContext({
      __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core,
      crypto: webcrypto, TextEncoder, Uint8Array, Blob, AbortSignal,
      localStorage: { getItem: () => null, setItem: () => {} },
      URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL: () => {} },
      toastr: { error: () => {} },
      fetch: async url => {
        if (url.startsWith('https://data.jsdelivr.com/')) return { ok: true, json: async () => ({ versions: [pkg.version, `${pkg.version}-dev.1`] }) };
        assert.ok(url.startsWith(`https://cdn.jsdelivr.net/gh/huayueshan/shujuku-scope-binding@${version}/dist/`));
        return { ok: true, json: async () => ({ version, files: { 'index.js': { sha256: sha(source) } } }), text: async () => source };
      },
    });
    const loader = await json(`dist/${file}`);
    const entry = new vm.SourceTextModule(loader.content, { context,
      importModuleDynamically: async url => {
        seen.push(url);
        assert.equal(url, 'blob:test');
        const module = new vm.SourceTextModule(await blob.text(), { context });
        await module.link(() => {});
        await module.evaluate();
        return module;
      },
    });
    await entry.link(async specifier => {
      seen.push(specifier);
      assert.ok(loader.content.includes(`'${specifier}'`));
      return new vm.SourceTextModule(await read('dist/index.js'), { context });
    });
    await entry.evaluate();
    assert.equal(seen.length, 1);
    assert.equal(typeof core.findDatabaseFrameCore, 'function');
    assert.deepEqual([...core.uniqueNames(['A', 'A', 'B'])], ['A', 'B']);
  }
});
