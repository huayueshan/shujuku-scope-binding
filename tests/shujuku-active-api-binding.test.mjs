import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const core = {};
vm.runInNewContext(source, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core, setTimeout });
const copy = value => JSON.parse(JSON.stringify(value));
const preset = (name, model, apiMode = 'custom') => ({ name, apiMode, tavernProfile: apiMode === 'tavern' ? 'Test profile' : '',
  apiConfig: { model, apiKey: 'TEST-SECRET', url: 'https://example.invalid', customApiFormat: 'openai_compat',
    requestHeaders: 'X-Test: secret', temperature: 0.5, sendViaTavern: true, futureOption: { keep: true } } });
function settings() {
  const presets = [preset('A', 'old'), preset('B', 'new'), preset('C', 'chat', 'tavern')];
  return { apiPresets: presets, defaultApiPresetName: 'B', apiPresetBindingsByChat: {},
    apiMode: presets[0].apiMode, apiConfig: copy(presets[0].apiConfig), tavernProfile: presets[0].tavernProfile,
    tableApiPreset: 'Table override', plotSettings: { tasks: [{ apiPresetName: 'Task override' }] },
    unrelated: { keep: true } };
}
function harness() {
  const e = {
    ...core, live: settings(), stored: null, writes: 0,
    identity: { chatKey: '', characterKey: '', characterStable: false }, character: {},
    runtime: { contextEpoch: 0, settingsRef: null },
    clone: copy, stableStringify: value => JSON.stringify(value),
    getIdentity: () => e.identity, getCharacterBindings: () => e.character,
    readState: () => ({ enabled: !e.disabled }),
    captureDatabaseSettings: async () => copy(e.stored),
    readStoredDatabaseSettings: () => copy(e.stored),
    scheduleDatabaseSettingsConfirmation: () => {},
    mutateDatabaseSettingsViaSave: async fn => {
      if (e.beforeSave) e.beforeSave();
      fn(e.live);
      e.writes++;
      if (e.failSave) throw new Error('secret native details');
      e.stored = copy(e.live);
    },
  };
  e.stored = copy(e.live);
  const fn = source.match(/^  async function applyActiveApiBinding\([\s\S]*?^  }\r?$/m)?.[0];
  assert.ok(fn);
  vm.createContext(e); vm.runInContext(fn, e);
  return e;
}

test('default label B with runtime A is projected to B, without a chat or unknown_chat binding', async () => {
  const e = harness();
  const overrides = copy([e.live.tableApiPreset, e.live.plotSettings, e.live.unrelated]);
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'new');
  assert.deepEqual(copy(e.live.apiPresetBindingsByChat), {});
  assert.deepEqual([e.live.tableApiPreset, e.live.plotSettings, e.live.unrelated], overrides);
  assert.deepEqual(e.stored, copy(e.live));
});

test('switch global with no context; repeat apply performs no extra save', async () => {
  const e = harness();
  await e.applyActiveApiBinding({ scope: 'global', name: 'C' });
  assert.equal(e.live.defaultApiPresetName, 'C');
  assert.equal(e.live.apiMode, 'tavern');
  assert.equal(e.live.tavernProfile, 'Test profile');
  for (let i = 0; i < 100; i++) await e.applyActiveApiBinding();
  assert.equal(e.writes, 1);
});

test('native chat beats character beats global; inherited API does not create a chat override', async () => {
  const e = harness();
  e.identity = { chatKey: 'chat-1', characterKey: 'role-1', characterStable: true };
  e.character.apiPreset = 'A';
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'old');
  assert.deepEqual(copy(e.live.apiPresetBindingsByChat), {});
  await e.applyActiveApiBinding({ scope: 'chat', name: 'C' });
  await e.applyActiveApiBinding({ scope: 'global', name: 'B' });
  assert.equal(e.live.apiConfig.model, 'chat');
  await e.applyActiveApiBinding({ scope: 'chat', name: '' });
  assert.equal(e.live.apiConfig.model, 'old');
  assert.deepEqual(copy(e.live.apiPresetBindingsByChat), {});
  delete e.character.apiPreset;
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'new');
});

test('switching chat and refreshing restores actual parameters, including format and headers', async () => {
  const e = harness();
  e.identity.chatKey = 'one';
  await e.applyActiveApiBinding({ scope: 'chat', name: 'C' });
  e.identity.chatKey = 'two'; e.runtime.contextEpoch++;
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'new');
  e.identity.chatKey = 'one'; e.runtime.contextEpoch++;
  e.live = copy(e.stored);
  await e.applyActiveApiBinding();
  assert.deepEqual(copy(e.live.apiConfig), e.live.apiPresets[2].apiConfig);
});

test('same-name preset edits are applied, not skipped by preset-name cache', async () => {
  const e = harness();
  await e.applyActiveApiBinding();
  e.live.apiPresets[1].apiConfig.model = 'updated';
  e.stored = copy(e.live);
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'updated');
  assert.equal(e.writes, 2);
});

test('missing, ambiguous and incompatible presets fail without writes or exposing credentials', async () => {
  for (const mode of ['missing', 'duplicate', 'schema']) {
    const e = harness();
    if (mode === 'missing') e.live.apiPresets = [];
    if (mode === 'duplicate') e.live.apiPresets.push(copy(e.live.apiPresets[1]));
    if (mode === 'schema') e.live.apiPresets[1].apiMode = 'unknown';
    e.stored = copy(e.live);
    await assert.rejects(e.applyActiveApiBinding(), error => !error.message.includes('TEST-SECRET'));
    assert.equal(e.writes, 0);
  }
});

test('chat binding is rejected with no chat and the database unknown_chat placeholder', async () => {
  for (const chatKey of ['', 'unknown_chat']) {
    const e = harness(); e.identity.chatKey = chatKey;
    await assert.rejects(e.applyActiveApiBinding({ scope: 'chat', name: 'B' }), /打开/);
    assert.equal(e.writes, 0);
  }
});

test('older database is skipped automatically, explicit API changes report unsupported', async () => {
  const e = harness(); e.live = {}; e.stored = {};
  assert.equal(await e.applyActiveApiBinding(), false);
  await assert.rejects(e.applyActiveApiBinding({ scope: 'global', name: 'B' }), /不支持/);
  assert.equal(e.writes, 0);
});

test('save failure rolls back runtime and leaves persistent state untouched', async () => {
  const e = harness(); const before = copy(e.live); e.failSave = true;
  await assert.rejects(e.applyActiveApiBinding(), /未完成/);
  assert.deepEqual(copy(e.live), before);
  assert.deepEqual(e.stored, before);
});

test('unconfirmed persistence is never reported as successful', async () => {
  const e = harness(); const before = copy(e.live);
  e.mutateDatabaseSettingsViaSave = async fn => { fn(e.live); };
  await assert.rejects(e.applyActiveApiBinding(), /未完成/);
  assert.deepEqual(copy(e.live), before);
});

test('chat switch before capture cancels old work before mutation', async () => {
  const e = harness(); const before = copy(e.live);
  e.beforeSave = () => { e.identity.chatKey = 'other'; e.runtime.contextEpoch++; };
  await assert.rejects(e.applyActiveApiBinding(), { code: 'SJBP_CONTEXT_CHANGED' });
  assert.deepEqual(e.live, before);
  assert.equal(e.writes, 0);
});

test('native edits between stored read and save are preserved by live re-planning', async () => {
  const e = harness(); e.identity.chatKey = 'one';
  e.beforeSave = () => { e.live.apiPresetBindingsByChat.one = { presetName: 'C', updatedAt: 1 }; };
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'chat');
});

test('concurrent applies serialize and do not repeat writes', async () => {
  const e = harness();
  await Promise.all(Array.from({ length: 10 }, () => e.applyActiveApiBinding()));
  assert.equal(e.writes, 1);
});

test('character binding can only contain a preset name, never a configuration object', () => {
  assert.equal(core.normalizePatchOwnedBindingCore('apiPreset', ' B '), 'B');
  assert.throws(() => core.normalizePatchOwnedBindingCore('apiPreset', { apiKey: 'secret' }), /名称/);
});

test('UI uses existing searchable selector and runtime verification omits connection fields', () => {
  const ui = source.match(/^  function buildFeatureControl\([\s\S]*?^  }\r?$/m)[0];
  assert.match(ui, /feature === 'apiPreset'/);
  assert.match(ui, /runtime.settingsRef.apiPresets/);
  assert.match(source, /features.apiPreset = \{ expected: name, matches \}/);
  assert.doesNotMatch(ui, /apiKey|apiConfig|requestHeaders/);
  assert.doesNotMatch(source, /\.loadApiPreset\(/);
});

test('stored selection alone is not proof: first apply captures and repairs stale live runtime', async () => {
  const e = harness();
  Object.assign(e.stored, copy(core.planActiveApiBindingCore(e.stored, '', '').fields));
  assert.equal(e.stored.apiConfig.model, 'new');
  assert.equal(e.live.apiConfig.model, 'old');
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'new');
  assert.equal(e.writes, 1);
  e.live.apiConfig.model = 'drift';
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.model, 'new');
});

test('real capture/save adapter updates the live settings and persisted JSON; restores JSON.stringify', async () => {
  const e = harness();
  const json = { stringify: JSON.stringify };
  const original = json.stringify;
  const api = {
    getUpdateConfigParams: () => ({ autoUpdateFrequency: 1 }),
    setUpdateConfigParams: () => { e.stored = JSON.parse(json.stringify(e.live)); e.writes++; return true; },
  };
  Object.assign(e, { getDatabaseApi: () => api, findDatabaseFrame: () => ({ contentWindow: { JSON: json } }),
    looksLikeDatabaseSettings: x => x === e.live, setTimeout,
  });
  const fn = source.match(/^  async function mutateDatabaseSettingsViaSave\([\s\S]*?^  }\r?$/m)?.[0];
  vm.runInContext(fn, e);
  await e.applyActiveApiBinding({ scope: 'global', name: 'C' });
  assert.equal(e.live.apiConfig.model, 'chat');
  assert.equal(e.stored.apiConfig.model, 'chat');
  assert.equal(json.stringify, original);
  await e.applyActiveApiBinding();
  assert.equal(e.writes, 1);
  const saved = copy(e.live);
  api.setUpdateConfigParams = () => { json.stringify(e.live); return false; };
  await assert.rejects(e.applyActiveApiBinding({ scope: 'global', name: 'B' }), /未完成/);
  assert.deepEqual(copy(e.live), saved);
  assert.equal(json.stringify, original);
});

test('disabled patch does not change the database active API', async () => {
  const e = harness(); e.disabled = true;
  assert.equal(await e.applyActiveApiBinding(), false);
  await assert.rejects(e.applyActiveApiBinding({ scope: 'global', name: 'C' }), /启用/);
  assert.equal(e.writes, 0);
  assert.equal(e.live.apiConfig.model, 'old');
});

test('naiv1.3.6 preset tool transport false and future fields survive all scope switches', async () => {
  const e = harness();
  e.live.apiPresets[0].apiConfig.contextToolTransportEnabled = true;
  e.live.apiPresets[1].apiConfig.contextToolTransportEnabled = false;
  e.live.apiPresets[2].apiConfig.contextToolTransportEnabled = true;
  e.live.takeoverEnabledGlobal = false;
  e.stored = copy(e.live);
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.contextToolTransportEnabled, false);
  assert.deepEqual(copy(e.live.apiConfig.futureOption), { keep: true });
  e.identity.chatKey = 'test-chat';
  e.character.apiPreset = 'A';
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.contextToolTransportEnabled, true);
  await e.applyActiveApiBinding({ scope: 'chat', name: 'B' });
  assert.equal(e.live.apiConfig.contextToolTransportEnabled, false);
  e.live.apiPresets[1].apiConfig.contextToolTransportEnabled = true;
  e.stored = copy(e.live);
  await e.applyActiveApiBinding();
  assert.equal(e.live.apiConfig.contextToolTransportEnabled, true);
  assert.equal(e.live.takeoverEnabledGlobal, false);
});

test('every save-adapter caller rejects explicit failure by default, including settings_loading', async () => {
  for (const result of [false, { ok: false }, { success: false }, { saved: false, code: 'settings_loading' }]) {
    const e = harness();
    const json = { stringify: JSON.stringify };
    const original = json.stringify;
    Object.assign(e, {
      getDatabaseApi: () => ({ getUpdateConfigParams: () => ({}), setUpdateConfigParams: () => {
        json.stringify(e.live);
        return result;
      } }),
      findDatabaseFrame: () => ({ contentWindow: { JSON: json } }),
      looksLikeDatabaseSettings: x => x === e.live, setTimeout,
    });
    vm.runInContext(source.match(/^  async function mutateDatabaseSettingsViaSave\([\s\S]*?^  }\r?$/m)[0], e);
    await assert.rejects(e.mutateDatabaseSettingsViaSave(() => false), /拒绝保存/);
    assert.equal(json.stringify, original);
    assert.equal(e.runtime.settingsRef, null);
  }
});

test('loading gate before serialization prevents mutations and later ready state can retry', async () => {
  const e = harness();
  const json = { stringify: JSON.stringify };
  let ready = false;
  const api = { getUpdateConfigParams: () => ({}), setUpdateConfigParams: () => {
    if (!ready) return false;
    e.stored = JSON.parse(json.stringify(e.live)); return true;
  } };
  Object.assign(e, { getDatabaseApi: () => api, findDatabaseFrame: () => ({ contentWindow: { JSON: json } }),
    looksLikeDatabaseSettings: x => x === e.live, setTimeout });
  vm.runInContext(source.match(/^  async function mutateDatabaseSettingsViaSave\([\s\S]*?^  }\r?$/m)[0], e);
  const before = copy(e.live);
  await assert.rejects(e.applyActiveApiBinding({ scope: 'global', name: 'C' }), /未完成/);
  assert.deepEqual(copy(e.live), before);
  assert.deepEqual(e.stored, before);
  ready = true;
  await e.applyActiveApiBinding({ scope: 'global', name: 'C' });
  assert.equal(e.live.apiConfig.model, 'chat');
  assert.equal(e.stored.apiConfig.model, 'chat');
});
