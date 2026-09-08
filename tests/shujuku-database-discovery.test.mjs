import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const core = {};
vm.runInNewContext(source, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core, console });

function realm(name) {
  const context = vm.createContext({});
  const owner = vm.runInContext('({ Object, Function })', context);
  const api = vm.runInContext('({ getUpdateConfigParams() { throw Error("must not execute"); }, setUpdateConfigParams() { throw Error("must not execute"); } })', context);
  return { api, frame: { id: name, isConnected: true, contentWindow: owner }, context };
}

test('discovers the API owner regardless of frame name or UUID', () => {
  const database = realm('renamed-with-arbitrary-id');
  const other = realm('looks-like-database');
  assert.equal(core.findDatabaseFrameCore([other.frame, database.frame], database.api), database.frame);
  database.frame.id = '';
  assert.equal(core.findDatabaseFrameCore([database.frame], database.api), database.frame);
});

test('uses the current API owner when multiple database instances exist', () => {
  const previous = realm('previous');
  const current = realm('current');
  assert.equal(core.findDatabaseFrameCore([previous.frame, current.frame], current.api), current.frame);
  assert.equal(core.findDatabaseFrameCore([previous.frame, current.frame], previous.api), previous.frame);
});

test('does not read unrelated source or execute API methods', () => {
  const database = realm('offline');
  const quoted = realm('quoted-loader');
  Object.defineProperty(quoted.frame, 'contentDocument', { get() { throw Error('must not inspect source'); } });
  assert.equal(core.findDatabaseFrameCore([quoted.frame, database.frame], database.api), database.frame);
});

test('skips inaccessible and disconnected frames', () => {
  const database = realm('active');
  const crossOrigin = { get contentWindow() { throw Error('SecurityError'); } };
  assert.equal(core.findDatabaseFrameCore([crossOrigin, database.frame], database.api), database.frame);
  database.frame.isConnected = false;
  assert.equal(core.findDatabaseFrameCore([database.frame], database.api), null);
});

test('fails closed for missing API, host wrappers and ambiguous owners', () => {
  const database = realm('database');
  const foreign = realm('wrapper');
  assert.equal(core.findDatabaseFrameCore([database.frame], null), null);
  assert.equal(core.findDatabaseFrameCore([database.frame], {}), null);
  database.api.setUpdateConfigParams = foreign.api.setUpdateConfigParams;
  assert.equal(core.findDatabaseFrameCore([database.frame, foreign.frame], database.api), null);
  database.api.setUpdateConfigParams = vm.runInContext('(function () {})', database.context);
  assert.equal(core.findDatabaseFrameCore([database.frame, { ...database.frame }], database.api), null);
});

test('a hot-reloaded frame cannot be paired with an old API object', () => {
  const old = realm('same-id');
  const fresh = realm('same-id');
  assert.equal(core.findDatabaseFrameCore([fresh.frame], old.api), null);
  assert.equal(core.findDatabaseFrameCore([fresh.frame], fresh.api), fresh.frame);
});

test('supports async setters from the database realm', () => {
  const database = realm('async');
  database.api.setUpdateConfigParams = vm.runInContext('(async function () {})', database.context);
  assert.equal(core.findDatabaseFrameCore([database.frame], database.api), database.frame);
});

test('production discovery is wired to the live API and all frames without ID filters', () => {
  const fn = source.match(/function findDatabaseFrame\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.match(fn, /findDatabaseFrameCore\(doc.querySelectorAll\('iframe'\), getDatabaseApi\(\)\)/);
  assert.doesNotMatch(source, /DB_STORAGE_CONTRACT\.script(?:Id|Name)/);
});

test('reads remote tags and reliable offline version headers without network access', () => {
  for (const version of ['spv8.4', 'spv8.9.2', 'spv9.1', 'spv9.1.6', 'spv9.2.3']) {
    assert.equal(core.readDatabaseSourceTagCore(`import 'https://cdn.example/gh/AlbusKen/shujuku@${version}/index.js'`), version);
    const header = version.startsWith('spv8.') ? '// @version 2.0.0' : `// @version ${version.slice(3)}`;
    assert.equal(core.readDatabaseSourceTagCore(header), version.startsWith('spv8.') ? '' : version);
  }
  assert.equal(core.readDatabaseSourceTagCore(''), '');
  assert.equal(core.readDatabaseSourceTagCore('// @version 2.0.0'), '');
});
