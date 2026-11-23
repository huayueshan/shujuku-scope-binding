import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const core = {};
vm.runInNewContext(source, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core, AbortController });
const copy = value => JSON.parse(JSON.stringify(value));
function harness(read) {
  let id = 0;
  const timers = new Map();
  const states = [];
  const monitor = core.createSettingsConfirmationCore({ read, changed: x => states.push(x),
    schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    unschedule: key => timers.delete(key),
  });
  return { monitor, states, timers, async fire(ms) {
    const entry = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(entry, `expected timer ${ms}`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  } };
}

test('server settings wrapper supports string and object, never treats missing namespace as saved', () => {
  const settings = { extension_settings: { __userscripts: {
    shujuku_v120__userscript_settings_v1: { profile: 'value' },
  } } };
  for (const value of [settings, JSON.stringify(settings)]) {
    assert.deepEqual(copy(core.databaseSettingsResponseCore({ settings: value })), { profile: 'value' });
  }
  for (const value of [{}, { settings: '{}' }, { settings: '{broken' }]) {
    assert.throws(() => core.databaseSettingsResponseCore(value));
  }
});

test('snapshot covers profile template and global selection, excluding other profiles', () => {
  const key = 'shujuku_v120_profile_v1____default____settings';
  const template = key.replace(/__settings$/, '__template');
  const namespace = { [key]: '{}', [template]: 'template', shujuku_v120_globalMeta_v1: '{}', other: 'private' };
  const snapshot = copy(core.databaseSettingsSnapshotCore(namespace, key));
  assert.equal(snapshot[template], 'template');
  assert.equal(snapshot.other, undefined);
  assert.equal(core.databaseSettingsSnapshotCore({}, key), null);
});

test('confirmation waits for server read; repeats and unrelated server keys do not cause more reads', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { profile: 'new', other: 'keep' }; });
  h.monitor.start({ profile: 'new' });
  assert.equal(h.monitor.getState(), 'pending');
  assert.equal(calls, 0);
  await h.fire(1800);
  assert.equal(h.monitor.getState(), 'confirmed');
  for (let i = 0; i < 100; i++) h.monitor.start({ profile: 'new' });
  assert.equal(h.timers.size, 0);
  assert.equal(calls, 1);
});

test('old server snapshot retries read only and can confirm delayed persistence', async () => {
  let calls = 0;
  const h = harness(async () => ({ profile: ++calls === 1 ? 'old' : 'new' }));
  h.monitor.start({ profile: 'new' });
  await h.fire(1800);
  assert.equal(h.monitor.getState(), 'pending');
  await h.fire(6000);
  assert.equal(h.monitor.getState(), 'confirmed');
  assert.equal(calls, 2);
  assert.equal(h.timers.size, 0);
});

test('mismatch, missing keys and network failure stop after two reads without rollback', async () => {
  for (const read of [async () => ({ profile: 'old' }), async () => ({}), async () => { throw Error('secret'); }]) {
    const h = harness(read);
    const expected = { profile: 'new' };
    h.monitor.start(expected);
    await h.fire(1800);
    await h.fire(6000);
    assert.equal(h.monitor.getState(), 'unconfirmed');
    assert.equal(h.timers.size, 0);
    assert.deepEqual(expected, { profile: 'new' });
    assert.ok(!h.states.join().includes('secret'));
  }
});

test('context switch and unload abort the request and ignore late success', async () => {
  let finish, signal;
  const h = harness(s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  h.monitor.start({ profile: 'old' });
  await h.fire(1800);
  h.monitor.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.size, 0);
  finish({ profile: 'old' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(h.monitor.getState(), 'idle');
  assert.equal(h.timers.size, 0);
});

test('new save supersedes a pending read; late old result cannot confirm new save', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  h.monitor.start({ profile: 'old' });
  await h.fire(1800);
  h.monitor.start({ profile: 'new' });
  finish({ profile: 'old' });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(h.monitor.getState(), 'pending');
  h.monitor.cancel();
});

test('hung requests are aborted and bounded even when a transport ignores abort', async () => {
  const signals = [];
  const h = harness(signal => { signals.push(signal); return new Promise(() => {}); });
  h.monitor.start({ profile: 'new' });
  await h.fire(1800); await h.fire(5000);
  await h.fire(6000); await h.fire(5000);
  assert.equal(h.monitor.getState(), 'unconfirmed');
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(h.timers.size, 0);
});

test('missing runtime snapshot cannot be confirmed; checks are read-only and lifecycle-bound', () => {
  const h = harness(async () => ({}));
  h.monitor.start(null);
  assert.equal(h.monitor.getState(), 'unconfirmable');
  assert.equal(h.timers.size, 0);
  assert.match(source, /function invalidateBindingContext\(\) \{\s*runtime.settingsConfirmation\?\.cancel/);
  assert.match(source, /function destroy\(\) \{\s*runtime.started = false;\s*runtime.settingsConfirmation\?\.cancel/);
  const adapter = source.match(/function scheduleDatabaseSettingsConfirmation\([\s\S]*?^  }/m)[0];
  assert.match(adapter, /\/api\/settings\/get/);
  assert.doesNotMatch(adapter, /settings\/save|saveSettingsDebounced|setInterval/);
});

test('production adapter reads only the current origin and parses persisted settings', async () => {
  const namespace = { profile__settings: '{"apiConfig":{}}', profile__template: 'template' };
  const calls = [];
  const context = {
    ...core, URL, AbortController,
    DB_STORAGE_CONTRACT: { settingsNamespace: 'shujuku_v120__userscript_settings_v1' },
    runtime: { started: true, databaseProfileKey: 'profile__settings' },
    host: { location: { href: 'https://example.invalid/chat' }, toastr: { warning: () => {} } },
    SillyTavern: { getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-only' }) },
    readUserscriptVariables: () => ({ shujuku_v120__userscript_settings_v1: namespace }),
    readStoredDatabaseSettings: () => ({}), refreshUiStatus: () => {},
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, json: async () => ({ settings: JSON.stringify({ extension_settings: {
        __userscripts: { shujuku_v120__userscript_settings_v1: namespace },
      } }) }) };
    },
  };
  let read;
  context.createSettingsConfirmationCore = options => {
    read = options.read;
    return { start: snapshot => assert.equal(snapshot.profile__template, 'template') };
  };
  vm.createContext(context);
  vm.runInContext(source.match(/^  function scheduleDatabaseSettingsConfirmation\([\s\S]*?^  }/m)[0], context);
  context.scheduleDatabaseSettingsConfirmation();
  const result = await read(new AbortController().signal);
  assert.deepEqual(copy(result), namespace);
  assert.equal(calls[0].url, 'https://example.invalid/api/settings/get');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test-only');
  assert.equal(calls[0].options.body, '{}');
});
