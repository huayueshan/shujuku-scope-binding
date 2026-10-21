import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'))[0];

function harness() {
  const observers = [];
  const timers = new Map();
  let nextTimer = 0;
  const e = {
    runtime: { started: true, eventDisposers: [], databaseUiOpenTimers: [] },
    DB_UI_CONTRACT: { rootId: 'db' },
    root: null, syncs: 0, checks: 0, context: 1, applies: 0,
    captureBindingContext: () => e.context,
    isBindingContextCurrent: context => context === e.context,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    syncDatabaseUi: () => { e.syncs++; assert.equal(observers[0].connected, false); },
    applyBindings: async () => { e.applies++; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
    host: {
      document: { body: {}, addEventListener() {}, removeEventListener() {}, getElementById: () => e.root },
      getComputedStyle: root => { e.checks++; return { display: root.display }; },
    },
  };
  vm.createContext(e);
  vm.runInContext(extract('installDatabaseUiIntegration'), e);
  e.installDatabaseUiIntegration();
  e.flush = () => { const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn()); };
  e.observers = observers;
  e.timers = timers;
  e.makeRoot = () => ({ display: 'block', classList: { contains: () => false } });
  return e;
}

test('unrelated page mutations do not schedule verification or read computed style', () => {
  const e = harness();
  e.root = e.makeRoot();
  e.observers[1].callback();
  e.flush();
  e.flush();
  const before = [e.syncs, e.checks];
  for (let i = 0; i < 1000; i++) e.observers[1].callback();
  assert.deepEqual([e.syncs, e.checks], before);
  assert.equal(e.timers.size, 0);
  assert.equal(e.observers[1].options.attributes, undefined);
});

test('panel changes coalesce; own writes are unobserved; root replacement reconnects', () => {
  const e = harness();
  e.root = e.makeRoot();
  e.observers[1].callback();
  e.flush(); e.flush();
  const before = e.syncs;
  for (let i = 0; i < 100; i++) e.observers[0].callback();
  assert.equal(e.timers.size, 1);
  e.flush();
  assert.equal(e.syncs, before + 1);
  assert.equal(e.observers[0].connected, true);
  e.root = e.makeRoot();
  e.observers[1].callback();
  assert.equal(e.observers[0].target, e.root);
  e.flush();
  assert.equal(e.syncs, before + 2);
});

test('hidden panels skip sync, reopening via visibility check resumes, teardown stays stopped', () => {
  const e = harness();
  e.root = e.makeRoot(); e.root.display = 'none';
  e.observers[1].callback(); e.flush();
  assert.equal(e.syncs, 0);
  e.root.display = 'block';
  e.runtime.trackDatabaseUiVisibility(); e.flush();
  assert.equal(e.syncs, 1);
  e.observers[0].callback();
  e.runtime.started = false;
  for (const dispose of e.runtime.eventDisposers) dispose();
  e.flush();
  assert.equal(e.syncs, 1);
  assert.equal(e.observers[0].connected, false);
});

test('worldbook-only verification never calls table export or preset APIs', () => {
  const e = {
    getIdentity: () => ({ chatKey: 'chat' }), runtime: { settingsRef: {}, activeWorldbooks: { all: [] } },
    getTableWorldbookConfig: () => ({}), getPlotWorldbookConfig: () => ({}),
    getVisibleDatabaseRoot: () => null, readDatabaseUiWorldbookConfig: () => null,
    readDatabaseUiInjectionTarget: () => null, resolveBinding: () => null,
    normalizeInjectionTarget: x => x || 'character', uniqueWorldbookNames: x => x || [],
    isObject: x => x && typeof x === 'object', clone: structuredClone,
    stableStringify: JSON.stringify, sortedNames: x => x,
    supportsActiveApiBindingCore: () => false,
    getDatabaseApi: () => { throw new Error('Preset/table API must not be called'); },
  };
  vm.createContext(e); vm.runInContext(extract('getVerificationReport'), e);
  const result = e.getVerificationReport(true);
  assert.equal(result.total, 3);
  assert.equal(result.ok, true);
  assert.throws(() => e.getVerificationReport(), /Preset\/table API must not be called/);
  assert.match(extract('syncDatabaseUi'), /getVerificationReport\(true\)/);
  assert.doesNotMatch(extract('syncDatabaseUiSourcePicker'), /getVerificationReport\(/);
});

test('delayed panel verification does not follow a switched context or stopped runtime', () => {
  for (const stop of [false, true]) {
    const e = harness();
    e.root = e.makeRoot();
    e.observers[1].callback(); e.flush();
    assert.equal(e.timers.size, 1);
    if (stop) e.runtime.started = false;
    else e.context++;
    e.flush();
    assert.equal(e.applies, 0);
  }
});

test('hot reload replaces stale button handlers and unchanged sync performs no DOM writes', () => {
  let writes = 0, clicks = 0, activeButton;
  const button = () => {
    const attrs = new Map(), classes = new Set();
    return {
      dataset: {}, className: '', textContent: '',
      classList: { toggle(name, enabled) {
        if (classes.has(name) === enabled) return;
        writes++; enabled ? classes.add(name) : classes.delete(name);
      } },
      setAttribute(k, v) { attrs.set(k, v); writes++; },
      getAttribute: k => attrs.get(k) ?? null,
      removeAttribute(k) { attrs.delete(k); },
      querySelector: () => null,
      addEventListener(_, handler) { this.click = handler; },
      cloneNode: () => button(),
      remove() { if (activeButton === this) activeButton = null; writes++; },
    };
  };
  const nativeButtons = [button(), button()];
  const styles = new Map();
  const segmented = {
    style: {
      getPropertyValue: k => styles.get(k) || '',
      setProperty(k, v) { styles.set(k, v); writes++; },
    },
    querySelector: selector => selector === '[data-sjbp-source-active]' ? activeButton : nativeButtons[0],
    querySelectorAll: () => nativeButtons,
    appendChild(value) { activeButton = value; writes++; },
  };
  const picker = { classList: button().classList, querySelector: s => s.startsWith('.acu-segmented') ? segmented : null };
  const page = { querySelector: () => picker };
  const e = {
    runtime: { started: true, settingsRef: {} },
    DB_UI_CONTRACT: { sourcePicker: '.picker', segmentedItem: '.item' },
    resolveBinding: () => null,
    getIdentity: () => ({ chatKey: 'chat' }),
    getTableWorldbookConfig: () => ({ source: 'manual' }),
    activateDatabaseUiAllWorldbooks: () => { clicks++; },
  };
  vm.createContext(e); vm.runInContext(extract('syncDatabaseUiSourcePicker'), e);
  const sync = () => e.syncDatabaseUiSourcePicker(page, 'tableWorldbooks', null);
  sync();
  const old = activeButton;
  writes = 0;
  sync();
  assert.equal(writes, 0);
  e.runtime.started = false;
  old.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(clicks, 0);
  e.runtime = { started: true, settingsRef: {} };
  sync();
  assert.notEqual(activeButton, old);
  activeButton.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(clicks, 1);
});
