import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const names = ['assertBindingScopeAvailable', 'setBindingForScope', 'clearBindingForScope',
  'getVerificationReport', 'applyBindings', 'saveGlobalTemplateWithoutChat', 'runBindingUiAction'];
const code = names.map(name => source.match(new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'))?.[0]).join('\n');
function harness() {
  const settings = { currentTemplatePresetName: 'Old' };
  const key = 'shujuku_v120_profile_v1____default____settings';
  const e = {
    SCOPE_IDS: ['global', 'character', 'chat'], NATIVE_PRESET_FEATURES: new Set(['tablePreset', 'plotPreset']),
    identity: { chatKey: '', characterStable: false }, writes: [], messages: [],
    runtime: { contextEpoch: 0, databaseProfileKey: key, settingsRef: settings },
    getIdentity: () => e.identity,
    setBinding: (...args) => e.writes.push(args), clearBinding: (...args) => e.writes.push(args),
    setNativePresetBinding: (...args) => e.writes.push(args), clearNativePresetBinding: (...args) => e.writes.push(args),
    captureDatabaseSettings: async () => settings, refreshUiStatus: () => {},
    host: { toastr: { error: x => e.messages.push(x), info: x => e.messages.push(x) } },
    isObject: x => !!x && typeof x === 'object' && !Array.isArray(x),
    parseStoredJson: x => JSON.parse(x), DB_STORAGE_CONTRACT: { settingsNamespace: 'db' },
    variables: { other: 9, db: { [key]: JSON.stringify(settings), untouched: 'keep' } },
    updateVariablesSafely: (fn, options) => { assert.equal(options.type, 'extension'); e.variables = fn(e.variables); },
    mutateDatabaseSettingsViaSave: async fn => { fn(settings); e.variables.db[key] = JSON.stringify(settings); },
    getDatabaseApi: () => e.api,
    api: { getTemplatePresetNames: () => ['New'], getTableTemplate: () => ({ mate: {}, sheet_a: { name: 'A' } }) },
  };
  vm.createContext(e); vm.runInContext(code, e);
  return e;
}
test('global saves require neither a character nor a chat for all five features', async () => {
  const e = harness();
  for (const feature of ['writeWorldbook', 'tableWorldbooks', 'plotWorldbooks', 'plotPreset', 'tablePreset']) {
    await e.setBindingForScope(feature, 'global', 'New');
  }
  assert.equal(e.writes.length, 5);
});
test('missing character/chat fails before binding or clearing writes, with actionable errors', async () => {
  const e = harness();
  for (const scope of ['character', 'chat']) {
    await assert.rejects(e.setBindingForScope('writeWorldbook', scope, 'New'), /请先/);
    await assert.rejects(e.clearBindingForScope('plotPreset', scope), /请先/);
  }
  assert.equal(e.writes.length, 0);
  e.identity.characterStable = true;
  await e.setBindingForScope('tablePreset', 'character', 'New');
  assert.equal(e.writes.length, 1);
});
test('no-chat apply refreshes settings, not tables, and verification is explicitly deferred', async () => {
  const e = harness();
  assert.equal(await e.applyBindings(), true);
  const result = e.getVerificationReport();
  assert.equal(result.deferred, true);
  assert.equal(result.total, 0);
  assert.match(result.message, /进入对话/);
  assert.equal(await e.applyBindings('manual sync', true, false, true, true), false);
  assert.match(e.messages[0], /请先打开/);
});
test('UI errors are caught and shown instead of becoming unhandled rejections', async () => {
  const e = harness();
  assert.equal(await e.runBindingUiAction(() => e.assertBindingScopeAvailable('chat')), false);
  assert.match(e.messages[0], /请先打开/);
});

test('no-chat apply never reports success for missing settings or a changed context', async () => {
  const e = harness();
  e.captureDatabaseSettings = async () => null;
  assert.equal(await e.applyBindings(), false);
  assert.match(e.runtime.lastError, /尚未就绪/);
  e.runtime.lastError = 'keep';
  e.captureDatabaseSettings = async () => {
    e.runtime.contextEpoch += 1;
    return {};
  };
  assert.equal(await e.applyBindings(), false);
  assert.equal(e.runtime.lastError, 'keep');
});
test('no-chat template fallback saves native default and snapshot, preserving other data', async () => {
  const e = harness();
  await e.saveGlobalTemplateWithoutChat('New');
  assert.equal(e.runtime.settingsRef.currentTemplatePresetName, 'New');
  assert.equal(JSON.parse(e.variables.db.shujuku_v120_profile_v1____default____template).sheet_a.name, 'A');
  assert.equal(e.variables.db.untouched, 'keep');
  assert.equal(e.variables.other, 9);
  await e.saveGlobalTemplateWithoutChat('');
  assert.equal(e.runtime.settingsRef.currentTemplatePresetName, '');
  assert.equal(e.variables.db.shujuku_v120_profile_v1____default____template, undefined);
});
test('fallback rejects unknown presets and context switches without saving', async () => {
  const e = harness();
  await assert.rejects(e.saveGlobalTemplateWithoutChat('Missing'), /不存在/);
  e.api.getTableTemplate = () => { e.identity.chatKey = 'opened'; return { sheet_a: {} }; };
  await assert.rejects(e.saveGlobalTemplateWithoutChat('New'), /已切换/);
  assert.equal(e.runtime.settingsRef.currentTemplatePresetName, 'Old');
});

test('template storage failure does not change the native selection name', async () => {
  const e = harness();
  const before = JSON.stringify(e.variables);
  e.updateVariablesSafely = () => { throw new Error('storage unavailable'); };
  await assert.rejects(e.saveGlobalTemplateWithoutChat('New'), /storage unavailable/);
  assert.equal(e.runtime.settingsRef.currentTemplatePresetName, 'Old');
  assert.equal(JSON.stringify(e.variables), before);
});
