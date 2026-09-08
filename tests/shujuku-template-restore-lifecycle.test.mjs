import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const functions = [
  'isBindingContextCurrentCore', 'captureBindingContext', 'isBindingContextCurrent',
  'assertBindingContextCurrent', 'invalidateBindingContext', 'waitForWorldbookApiPromise',
  'needsNativePresetRestoreCore', 'tableTemplateMatchesRuntimeCore', 'stableStringify',
  'restoreNativeChatPreset', 'runTableTemplateOperation', 'applyPresetBinding',
  'applyMergedTemplateSourcesToCurrentChat', 'getTemplateSnapshotFromDatabase', 'buildMergedTemplateLabel',
  'buildFeatureControl', 'setNativePresetBinding', 'clearNativePresetBinding', 'openNativeTableTemplate',
  'getNativeTablePresetState', 'migrateLegacyPresetBindings',
];
const production = functions.map(name => {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');
const core = {};
vm.runInNewContext(source, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core, console });
const copy = value => JSON.parse(JSON.stringify(value));
const template = {
  mate: { type: 'chatSheets', version: 1 },
  sheet_one: {
    uid: 'one', name: 'One', orderNo: 1, content: [['Name', 'Value'], ['old', 'old']],
    sourceData: { ddl: 'CREATE TABLE one (name TEXT, value TEXT)' },
    updateConfig: { prompt: 'rules' }, exportConfig: { enabled: true }, seedRows: [['seed', '1']],
  },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const runtime = {
    started: true, contextEpoch: 0, contextController: new AbortController(),
    nativePresetAppliedTokens: {}, nativeTemplateRestorePending: null,
  };
  const env = {
    ...core, clone: copy, runtime, AbortController, setTimeout, clearTimeout, chatKey: 'a', imports: 0,
    data: copy(template), snapshot: { templateStr: JSON.stringify(template), presetName: 'Preset' },
    binding: { value: 'Preset', native: true }, DATABASE_TEMPLATE_RESTORE_TIMEOUT_MS: 20,
    isObject: x => !!x && typeof x === 'object' && !Array.isArray(x),
    getIdentity: () => ({ chatKey: env.chatKey }),
    buildNativePresetApplyToken: () => `${env.chatKey}:${runtime.contextEpoch}`,
    getSillyTavern: () => ({ chatMetadata: { TavernDB_ACU_ScopedConfig: { template: { '': env.snapshot } } } }),
    getDatabaseIsolationSlot: () => '',
    getNativeChatPresetBinding: () => env.binding,
    clearPresetRuntimeRetry: () => {},
    managed: null, characterBindings: {}, switches: 0,
    readState: () => ({}), getProfileState: () => ({}),
    getManagedPreset: () => env.managed,
    setManagedPreset: (_feature, value) => { env.managed = value; },
    getCharacterBindings: () => env.characterBindings,
    getNativeGlobalPresetBinding: () => ({ value: 'Global', native: true }),
    getEmbeddedTablePreset: id => env.embedded?.[id],
    FEATURE_LABELS: { tablePreset: '表格预设' },
    switchTemplatePresetWithConfirmation: (api, name, options) => api.switchTemplatePreset(name, options),
    handleTemplatePresetApiResult: (_feature, result) => {
      if (result?.success === false) throw new Error(result.message);
      return { saved: result === true || result?.success !== false, fullyApplied: result === true || result?.runtimeReady !== false };
    },
    api: {
      exportTableAsJson: () => env.data,
      getTemplatePresetNames: () => ['Global', 'Character'],
      getTableTemplate: options => options.presetName === 'Character' ? env.characterTemplate : template,
      switchTemplatePreset: (name, options) => {
        env.switches++;
        env.binding = { value: name, native: true };
        return true;
      },
      importTemplateFromData: () => { env.imports++; return { success: true, runtimeReady: true }; },
    },
    getDatabaseApi: () => env.api,
  };
  vm.createContext(env);
  vm.runInContext(production, env);
  return env;
}

test('already restored native tables are verified without importing or replaying stale rows', async () => {
  const e = harness();
  e.data.sheet_one.content.push(['new', 'current']);
  delete e.data.sheet_one.seedRows;
  const before = copy(e.data);
  assert.equal(await e.restoreNativeChatPreset('tablePreset', e.binding), false);
  assert.equal(e.imports, 0);
  assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined);
  e.chatKey = 'b';
  e.invalidateBindingContext();
  e.runtime.nativePresetAppliedTokens = {};
  await e.restoreNativeChatPreset('tablePreset', e.binding);
  assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined);
  assert.equal(e.imports, 0, 'new chat token alone must not start a template transaction');
  assert.deepEqual(e.data, before);
});

test('all template structure fields and the exact table set are checked', () => {
  const e = harness();
  for (const change of [
    d => { d.sheet_one.content[0][1] = 'Different'; },
    d => { d.sheet_one.name = 'Different'; },
    d => { d.sheet_one.sourceData.ddl += ';'; },
    d => { d.sheet_one.updateConfig.prompt = 'Different'; },
    d => { d.sheet_one.exportConfig.enabled = false; },
    d => { d.sheet_one.orderNo = 2; },
    d => { d.sheet_one.uid = 'different'; },
    d => { d.sheet_two = copy(d.sheet_one); },
    d => { delete d.sheet_one; },
  ]) {
    const data = copy(template);
    change(data);
    assert.equal(e.tableTemplateMatchesRuntimeCore(template, data), false);
  }
  for (const invalid of [null, {}, '{broken', [], { sheet_one: {} }, Promise.resolve(template)]) {
    assert.equal(e.tableTemplateMatchesRuntimeCore(template, invalid), false);
  }
  assert.equal(e.tableTemplateMatchesRuntimeCore(JSON.stringify(template), JSON.stringify(template)), true);
});

test('schema drift and missing old export APIs never trigger automatic chat imports', async () => {
  for (const omitExport of [false, true]) {
    const e = harness();
    e.data.sheet_one.content[0] = ['Old'];
    if (omitExport) delete e.api.exportTableAsJson;
    await e.restoreNativeChatPreset('tablePreset', e.binding);
    assert.equal(e.imports, 0);
    assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined);
  }
});

test('a timed-out import does not deadlock the binding queue or submit duplicates', async () => {
  const e = harness();
  const task = deferred();
  e.data = {};
  e.api.importTemplateFromData = () => { e.imports++; return task.promise; };
  await assert.rejects(e.runTableTemplateOperation(() => e.api.importTemplateFromData()), /表格模板操作超时/);
  assert.ok(e.runtime.nativeTemplateRestorePending);
  await assert.rejects(e.runTableTemplateOperation(() => e.api.importTemplateFromData()), /不会重复提交/);
  assert.equal(e.imports, 1);
  assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined);
  task.resolve({ success: true });
  await task.promise;
  await Promise.resolve();
  assert.equal(e.runtime.nativeTemplateRestorePending, null);
  assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined, 'late completion cannot claim application');
});

test('switching or closing chat cancels waiting and rejects late success for the old context', async () => {
  for (const next of ['b', '']) {
    const e = harness();
    const task = deferred();
    e.data = {};
    e.api.importTemplateFromData = () => { e.imports++; return task.promise; };
    const result = e.runTableTemplateOperation(() => e.api.importTemplateFromData());
    const rejection = assert.rejects(result, error => error.code === 'SJBP_CONTEXT_CHANGED');
    await Promise.resolve();
    e.chatKey = next;
    e.invalidateBindingContext();
    await rejection;
    assert.equal(e.imports, 1);
    await assert.rejects(e.runTableTemplateOperation(() => e.api.importTemplateFromData()), /不会重复提交|取消旧同步任务/);
    task.resolve({ success: true });
    await task.promise;
    await Promise.resolve();
    assert.equal(e.runtime.nativeTemplateRestorePending, null);
    assert.equal(e.runtime.nativePresetAppliedTokens.tablePreset, undefined);
  }
});

test('existing chat templates always win, including game initialization and pristine imports', async () => {
  for (const nativeSource of ['game_init', 'api_import_template_chat', 'ui']) {
    const e = harness();
    e.binding.nativeSource = nativeSource;
    e.binding.nativeReason = 'chat_template_pristine_switch';
    e.characterBindings = { tablePreset: { presetName: 'Character', mergeGlobal: true } };
    e.managed = { scope: 'character', value: 'Old' };
    const before = copy(e.data);
    assert.equal(await e.applyPresetBinding('tablePreset'), false);
    assert.equal(e.imports + e.switches, 0);
    assert.deepEqual(e.data, before);
  }
});

test('global fallback is left to the database without creating a second chat override', async () => {
  const e = harness();
  e.binding = null;
  assert.equal(await e.applyPresetBinding('tablePreset'), false);
  assert.equal(e.imports + e.switches, 0);
  assert.equal(e.managed, null);
});

test('missing chat templates inherit a character preset once through the database API', async () => {
  const e = harness();
  e.binding = null;
  e.characterBindings = { tablePreset: 'Character' };
  assert.equal(await e.applyPresetBinding('tablePreset'), true);
  assert.equal(e.switches, 1);
  assert.equal(e.managed.scope, 'character');
  assert.equal(await e.applyPresetBinding('tablePreset'), false);
  assert.equal(e.switches, 1);
});

test('embedded character inheritance uses the public import API and respects an arriving native snapshot', async () => {
  const e = harness();
  e.binding = null;
  e.characterBindings = { tablePreset: { source: 'embedded', embeddedPresetId: 'card', mergeGlobal: false } };
  e.embedded = { card: { name: 'Card', template } };
  e.api.importTemplateFromData = (data, options) => {
    e.imports++;
    assert.deepEqual(data, template);
    assert.equal(options.scope, 'chat');
    assert.equal(options.dataMode, 'seed');
    assert.equal(options.conflictPolicy, 'keep-current');
    e.binding = { value: options.presetName, native: true };
    return { success: true, runtimeReady: true };
  };
  await e.applyPresetBinding('tablePreset');
  assert.equal(e.imports, 1);
  e.binding = null;
  const applying = e.applyPresetBinding('tablePreset');
  e.binding = { value: 'Arrived from card script', native: true };
  assert.equal(await applying, false);
  assert.equal(e.imports, 1);
});

test('manual ordered merge delegates migration to importTemplateFromData without changing existing rows itself', async () => {
  const e = harness();
  const later = copy(template);
  later.sheet_one.updateConfig.prompt = 'later wins';
  const before = copy(e.data);
  e.api.importTemplateFromData = (merged, options) => {
    e.imports++;
    assert.equal(merged.sheet_one.updateConfig.prompt, 'later wins');
    assert.equal(options.scope, 'chat');
    assert.equal(options.dataMode, 'seed');
    assert.equal(options.conflictPolicy, 'keep-current');
    return { success: true, runtimeReady: true };
  };
  await e.applyMergedTemplateSourcesToCurrentChat([
    { type: 'global', label: 'Global' },
    { type: 'embedded', label: 'Card', template: later },
  ], 'manual merge');
  assert.equal(e.imports, 1);
  assert.deepEqual(e.data, before);
});

test('automatic character merge only initializes missing snapshots and later preserves them', async () => {
  const e = harness();
  e.binding = null;
  e.runtime.settingsRef = { currentTemplatePresetName: 'Global' };
  e.characterBindings = { tablePreset: { presetName: 'Character', mergeGlobal: true } };
  e.characterTemplate = copy(template);
  e.characterTemplate.sheet_one.updateConfig.prompt = 'character wins';
  e.api.importTemplateFromData = (merged, options) => {
    e.imports++;
    assert.equal(merged.sheet_one.updateConfig.prompt, 'character wins');
    e.binding = { value: options.presetName, native: true };
    return true;
  };
  await e.applyPresetBinding('tablePreset');
  await e.applyPresetBinding('tablePreset');
  assert.equal(e.imports, 1);
});

test('the chat template control is a database entry and direct bind/unbind is rejected', async () => {
  const e = harness();
  const html = e.buildFeatureControl('tablePreset', 'chat');
  assert.match(html, /data-open-native-template/);
  assert.doesNotMatch(html, /data-control|data-select-trigger/);
  assert.match(source, /sjbp-native-template-controls \{ grid-template-columns: minmax\(0,1fr\)/);
  await assert.rejects(e.setNativePresetBinding('tablePreset', 'chat', 'X'), /由数据库管理/);
  await assert.rejects(e.clearNativePresetBinding('tablePreset', 'chat'), /由数据库管理/);
  assert.equal(e.imports + e.switches, 0);
});

test('legacy and first-message native snapshots are preserved without replaying obsolete patch bindings', async () => {
  const e = harness();
  const native = { mode: 'preset_link', presetName: 'Old link' };
  e.getSillyTavern = () => ({ chatMetadata: { TavernDB_ACU_ScopedConfig: {} }, chat: [{ TavernDB_ACU_ScopedConfig: { template: { '': native } } }] });
  assert.equal(e.getNativeTablePresetState(), native);
  const legacy = { bindings: { tablePreset: 'Obsolete' } };
  e.NATIVE_PRESET_FEATURES = new Set(['tablePreset', 'plotPreset']);
  e.getProfileState = () => ({ global: {} });
  e.readChatPatchRoot = () => legacy;
  e.getChatProfile = () => legacy;
  e.writeState = e.writeChatPatchRoot = () => { throw new Error('must not erase legacy data'); };
  assert.equal(await e.migrateLegacyPresetBindings(), false);
  assert.equal(legacy.bindings.tablePreset, 'Obsolete');
  assert.equal(e.imports + e.switches, 0);
});

test('opening database settings does not mutate templates and handles missing or failed APIs', async () => {
  const e = harness();
  let closed = 0;
  e.closeDialog = () => { closed++; };
  e.renderDialog = () => {};
  e.host = { document: { getElementById: () => null } };
  e.DB_UI_CONTRACT = { rootId: 'acu-app-v2', sidebarItem: '.acu-v2-sidebar__item', labels: { table: '填表规则' } };
  assert.equal(await e.openNativeTableTemplate(), false);
  e.api.openSettings = async () => false;
  assert.equal(await e.openNativeTableTemplate(), false);
  assert.equal(closed, 0);
  e.api.openSettings = async () => true;
  assert.equal(await e.openNativeTableTemplate(), true);
  assert.equal(closed, 1);
  assert.equal(e.imports + e.switches, 0);
});

test('the native settings shortcut reaches the template panel via existing UI controls', async () => {
  const e = harness();
  let clicked = 0;
  let scrolled = 0;
  e.api.openSettings = async () => true;
  e.closeDialog = e.renderDialog = () => {};
  e.DB_UI_CONTRACT = { labels: { formFill: '填表工作台' }, templatePanel: '#form-fill-template-panel' };
  e.host = { document: { getElementById: () => ({
    querySelectorAll: () => [{ textContent: '填表工作台', click: () => { clicked++; } }],
    querySelector: selector => {
      assert.equal(selector, '#form-fill-template-panel');
      return { scrollIntoView: () => { scrolled++; } };
    },
  }) } };
  assert.equal(await e.openNativeTableTemplate(), true);
  assert.equal(clicked, 1);
  assert.equal(scrolled, 1);
});

test('opening an already connected panel does not hide its controls behind a pending restore', async () => {
  const task = deferred();
  const states = [];
  const env = {
    runtime: { settingsRef: {}, overlay: { hidden: true }, panelLoading: false },
    installStyles: () => {}, renderDialog: () => states.push(env.runtime.panelLoading),
    applyBindings: () => task.promise,
  };
  const code = source.match(/^  async function openDialog\([\s\S]*?^  }\r?$/m)[0];
  vm.createContext(env);
  vm.runInContext(code, env);
  const opening = env.openDialog();
  assert.equal(env.runtime.overlay.hidden, false);
  assert.deepEqual(states, [false]);
  task.resolve(false);
  await opening;
  assert.deepEqual(states, [false, false]);
});
