import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const core = {};
vm.runInNewContext(source, { __SHUJUKU_SCOPE_BINDING_PATCH_TEST__: core, console });
const plain = value => JSON.parse(JSON.stringify(value));

test('worldbook identity preserves whitespace, excludes blanks, deduplicates exact names only', () => {
  assert.deepEqual(plain(core.uniqueWorldbookNames([' Book ', 'Book', ' Book ', '\u3000Book\u00a0', '', ' \t', null])), [' Book ', 'Book', '\u3000Book\u00a0']);
  assert.deepEqual(plain(core.uniqueNames([' Book ', 'Book'])), ['Book']);
  assert.equal(core.normalizeInjectionTarget(' character '), ' character ');
  assert.equal(core.normalizeInjectionTarget('character'), 'character');
  assert.equal(core.normalizeInjectionTarget(' \t'), 'character');
});

test('manual bindings preserve exact entry keys through materialization and config writes', () => {
  const binding = { source: 'manual', manualSelection: [' Book ', 'Book'], enabledEntries: { ' Book ': [1], Book: [2] } };
  const normalized = core.normalizeWorldbookBindingCore(binding);
  assert.deepEqual(plain(normalized), binding);
  const desired = core.materializeWorldbookSource({}, normalized, []);
  const config = { source: 'manual', manualSelection: ['Book'], enabledEntries: {} };
  assert.equal(core.applyWorldbookConfigAtomic(config, desired), true);
  assert.deepEqual(plain(config), binding);
  assert.equal(core.applyWorldbookConfigAtomic(config, desired), false);
  assert.equal(core.controlValuesEquivalentCore('tableWorldbooks', binding, { ...binding, manualSelection: ['Book'] }), false);
});

test('all source scopes preserve names, including singular character and persona books', () => {
  const active = core.normalizeActiveSourcesCore({ global: [' G '], characterPrimary: ' C ', characterAdditional: [' A '], chat: ' T ', persona: ' P ' });
  assert.deepEqual(plain(active.all), [' G ', ' C ', ' A ', ' T ', ' P ']);
  assert.deepEqual(plain(core.materializeWorldbookSource({}, { source: 'active' }, active.all).manualSelection), plain(active.all));
});

test('UI readers use the label text, not whitespace around icons', () => {
  const extract = name => source.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'))[0];
  const e = {
    worldbookName: core.worldbookName,
    DB_UI_CONTRACT: { sourcePicker: 'picker', sourceItemLabel: 'label', selectLabel: 'label', injectionTrigger: 'trigger', labels: { manual: 'manual', characterTarget: 'character label' } },
    findDatabaseControl: () => ({ getAttribute: () => 'true' }),
  };
  vm.createContext(e);
  vm.runInContext(extract('readDatabaseUiWorldbookConfig') + extract('readDatabaseUiInjectionTarget'), e);
  const button = { textContent: '  Book  ', getAttribute: () => 'true', querySelector: () => ({ textContent: ' Book ' }) };
  const picker = { querySelector: () => null, querySelectorAll: () => [button] };
  assert.deepEqual(plain(e.readDatabaseUiWorldbookConfig({ querySelector: () => picker }).manualSelection), [' Book ']);
  assert.equal(e.readDatabaseUiInjectionTarget({ querySelector: () => button }), ' Book ');
});
