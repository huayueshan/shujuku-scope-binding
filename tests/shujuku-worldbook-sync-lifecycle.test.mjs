import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');

// Execute the production functions themselves with controlled host dependencies.
function functionSource(name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'));
  assert.ok(match, `Missing production function: ${name}`);
  return match[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function harness(extraFunctions = [], overrides = {}) {
  const clock = { now: 1000 };
  const runtime = {
    started: true, contextEpoch: 0, contextController: new AbortController(),
    settingsGeneration: 1, pendingWriteWorldbookTransition: null,
    worldbookApiPending: null, databaseTableRevision: 1,
    databaseTableUpdatedAt: 0, databaseTableDataState: 'ready',
    eventDisposers: [], applyQueue: Promise.resolve(false),
  };
  const env = {
    runtime, clock, chatKey: 'chat-a', AbortController, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return clock.now; } },
    isObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    getIdentity: () => ({ chatKey: env.chatKey }),
    installDatabaseTableUpdateMonitor: () => {},
    resolveBinding: () => ({ value: 'test-worldbook' }),
    refreshUiStatus: () => {}, warn: () => {},
    ...overrides,
  };
  const functions = [
    'isBindingContextCurrentCore', 'captureBindingContext', 'isBindingContextCurrent',
    'assertBindingContextCurrent', 'invalidateBindingContext',
    'isDatabaseTransitionReadyCore', 'databaseTableReadyForTransition',
    'waitForDatabaseTableReady', 'waitForWorldbookApiPromise', 'waitForWorldbookApiIdle',
    'callDatabaseWorldbookApiWithTimeout', ...extraFunctions,
  ];
  const constants = source.match(/^  const DATABASE_(?:CHAT|TABLE|WORLDBOOK)_\w+ = \d+;/gm);
  vm.createContext(env);
  vm.runInContext(`${constants.join('\n')}\n${[...new Set(functions)].map(functionSource).join('\n')}`, env);
  return env;
}

test('CHAT_CHANGED does not block the later database initialization listener', async () => {
  const pendingReset = deferred();
  const listeners = new Map();
  let resetCalls = 0;
  const env = harness(['installEventListeners'], {
    tavern_events: { CHAT_CHANGED: 'chat' },
    uniqueNames: values => [...new Set(values)],
    addTavernEventListener: (name, callback) => listeners.set(name, callback),
    resetPresetRuntimeState: () => {}, beginWriteWorldbookTransition: () => {},
    schedulePostCaptureReapply: () => {}, scheduleApply: () => {},
    requestWriteWorldbookReset: () => { resetCalls += 1; return pendingReset.promise; },
  });
  env.installEventListeners();
  const result = listeners.get('chat')();
  assert.equal(result, undefined);
  await result; // Matches SillyTavern's sequential await of listener results.
  let databaseStarted = false;
  await (() => { databaseStarted = true; pendingReset.resolve(true); })();
  assert.equal(databaseStarted, true);
  assert.equal(resetCalls, 1);
  env.chatKey = '';
  assert.equal(listeners.get('chat')(), undefined);
  assert.equal(resetCalls, 1, 'closing chat must not launch another write');
});

test('initial recovery can finish after eight seconds without forcing a retry', async () => {
  const env = harness();
  const transition = { chatKey: 'chat-a', settingsGeneration: 1, baselineRevision: 1, requestedAt: 1000, notBefore: 2100 };
  const result = env.waitForDatabaseTableReady(transition);
  env.clock.now = 10000;
  env.runtime.databaseTableRevision = 2;
  env.runtime.databaseTableUpdatedAt = 9500;
  assert.equal(await result, 'ready');
});

test('the normal 1200ms callback remains valid after the added settle delay', async () => {
  const env = harness();
  const transition = { chatKey: 'chat-a', settingsGeneration: 1, baselineRevision: 1, requestedAt: 1000, notBefore: 2100 };
  env.runtime.databaseTableRevision = 2;
  env.runtime.databaseTableUpdatedAt = 2200;
  env.clock.now = 2300;
  let finished = false;
  const result = env.waitForDatabaseTableReady(transition).then(value => { finished = true; return value; });
  await flushMicrotasks();
  assert.equal(finished, false);
  env.clock.now = 2600;
  assert.equal(await result, 'ready');
});

test('switching or closing a chat cancels readiness waiting even after manual approval', async () => {
  for (const nextChat of ['chat-b', '']) {
    const env = harness();
    const transition = { chatKey: 'chat-a', settingsGeneration: 1, baselineRevision: 1, requestedAt: 1000, notBefore: 2100, manualApproved: true };
    const result = env.waitForDatabaseTableReady(transition);
    env.chatKey = nextChat;
    env.invalidateBindingContext();
    await assert.rejects(result, { code: 'SJBP_CONTEXT_CHANGED' });
  }
});

test('a later runtime-only write invalidates an earlier persisted readiness notification', async () => {
  const env = harness();
  const transition = { chatKey: 'chat-a', settingsGeneration: 1, baselineRevision: 1, requestedAt: 1000, notBefore: 2100 };
  env.runtime.databaseTableRevision = 2;
  env.runtime.databaseTableUpdatedAt = 2200;
  env.runtime.databaseTableUnpersistedAt = 2300;
  env.clock.now = 4000;
  let finished = false;
  const result = env.waitForDatabaseTableReady(transition).then(value => { finished = true; return value; });
  await flushMicrotasks();
  assert.equal(finished, false);
  env.runtime.databaseTableUpdatedAt = 4500;
  env.clock.now = 5000;
  assert.equal(await result, 'ready');
});

test('an old cleanup cannot continue into synchronization and a new cleanup waits for its real completion', async () => {
  const oldDelete = deferred();
  const calls = [];
  const env = harness(['performWriteWorldbookReset', 'refreshWriteWorldbookViaDatabase']);
  env.getDatabaseApi = () => ({
    deleteInjectedEntries: () => {
      calls.push(`delete:${env.chatKey}`);
      return calls.length === 1 ? oldDelete.promise : true;
    },
    syncWorldbookEntries: () => { calls.push(`sync:${env.chatKey}`); return true; },
  });
  const old = env.performWriteWorldbookReset('old');
  const cancelled = assert.rejects(old, { code: 'SJBP_CONTEXT_CHANGED' });
  await flushMicrotasks();
  assert.deepEqual(calls, ['delete:chat-a']);
  env.chatKey = 'chat-b';
  env.invalidateBindingContext();
  const next = env.performWriteWorldbookReset('new');
  await cancelled;
  await flushMicrotasks();
  assert.deepEqual(calls, ['delete:chat-a']);
  oldDelete.resolve(true);
  assert.equal(await next, true);
  assert.deepEqual(calls, ['delete:chat-a', 'delete:chat-b', 'sync:chat-b']);
  assert.equal(env.runtime.lastWriteWorldbookRefresh.chatKey, 'chat-b');
});

test('API timeout retains the lock until the upstream operation actually settles', async () => {
  const env = harness();
  const first = deferred();
  let calls = 0;
  await assert.rejects(env.callDatabaseWorldbookApiWithTimeout(
    () => { calls += 1; return first.promise; }, 'slow', env.captureBindingContext(), 5,
  ), /操作超时/);
  assert.ok(env.runtime.worldbookApiPending);
  const next = env.callDatabaseWorldbookApiWithTimeout(() => { calls += 1; return true; }, 'next');
  await flushMicrotasks();
  assert.equal(calls, 1);
  first.resolve(true);
  assert.equal(await next, true);
  assert.equal(calls, 2);
  assert.equal(env.runtime.worldbookApiPending, null);
});

test('queued work from an earlier visit is discarded even when returning to the same chat', async () => {
  const calls = [];
  const env = harness(['applyBindings'], { runBindingsOnce: reason => { calls.push(reason); return true; } });
  const blocker = deferred();
  env.runtime.applyQueue = blocker.promise;
  const old = env.applyBindings('old');
  env.chatKey = 'chat-b';
  env.invalidateBindingContext();
  env.chatKey = 'chat-a';
  env.invalidateBindingContext();
  const current = env.applyBindings('current');
  blocker.resolve(true);
  assert.equal(await old, false);
  assert.equal(await current, true);
  assert.deepEqual(calls, ['current']);
});

test('manual clicks coalesce only within the current chat and never approve the next transition', async () => {
  const pending = [];
  const env = harness(['requestWriteWorldbookReset'], {
    host: { toastr: { info: () => {} } },
    applyBindings: () => { const task = deferred(); pending.push(task); return task.promise; },
  });
  const first = env.requestWriteWorldbookReset('first');
  assert.equal(env.requestWriteWorldbookReset('repeat', { allowCurrentDatabaseState: true }), first);
  env.chatKey = 'chat-b';
  env.invalidateBindingContext();
  const second = env.requestWriteWorldbookReset('second');
  assert.notEqual(first, second);
  pending[0].resolve(false);
  await first;
  assert.equal(env.runtime.writeWorldbookResetRequestPromise, second);
  pending[1].resolve(true);
  await second;
  assert.equal(env.runtime.writeWorldbookResetRequestPromise, null);
});

test('an application suspended while capturing settings cannot bind or write to the next chat', async () => {
  const captured = deferred();
  const calls = [];
  const env = harness(['runBindingsOnce'], {
    captureDatabaseSettings: () => captured.promise,
    refreshActiveWorldbooks: () => { calls.push('read-books'); },
    ensureWorldbookChatBindings: () => { calls.push('bind'); },
  });
  const result = env.runBindingsOnce('old');
  await flushMicrotasks();
  env.chatKey = 'chat-b';
  env.invalidateBindingContext();
  captured.resolve({});
  assert.equal(await result, false);
  assert.deepEqual(calls, []);
});

test('a completed old retry cannot schedule more work after chat cancellation', async () => {
  const scheduled = [];
  const operation = deferred();
  const env = harness(['schedulePostCaptureReapply'], {
    setTimeout: callback => { scheduled.push(callback); return scheduled.length; },
    clearTimeout: () => {},
    requestWriteWorldbookReset: () => operation.promise,
  });
  env.schedulePostCaptureReapply('old', 1800, true, true);
  scheduled[0]();
  env.chatKey = '';
  env.invalidateBindingContext();
  operation.resolve(false);
  await flushMicrotasks();
  assert.equal(scheduled.length, 1);
});

test('target changes during a transition do not bypass the reset readiness gate', () => {
  assert.match(functionSource('runBindingsOnce'), /resetWriteWorldbook \|\| !!runtime\.pendingWriteWorldbookTransition/);
  assert.match(functionSource('applyWorldbookBindings'), /if \(targetChanged && !deferWriteRefresh\)/);
  assert.match(functionSource('applyWorldbookBindings'), /mutateDatabaseSettingsViaSave\(currentSettings => \{\s+assertBindingContextCurrent\(context\)/);
});

function startupHarness(pauseAt) {
  const paused = deferred();
  const effects = [];
  const pollers = [];
  let env;
  const step = name => async () => {
    effects.push(name);
    if (name === pauseAt) await paused.promise;
    if (name === 'capture') env.runtime.settingsRef = {};
    return env.runtime.settingsRef;
  };
  env = harness(['main'], {
    PATCH_VERSION: 'test',
    disableLegacyPatch: () => {}, installStyles: () => {}, installMenuItem: () => {},
    exposeApi: () => {}, installEventListeners: () => {}, installDatabaseUiIntegration: () => {},
    captureDatabaseSettings: step('capture'),
    readState: () => ({}), writeState: () => effects.push('write-state'),
    getCharacterBindings: () => effects.push('read-character'),
    migrateLegacyPresetBindings: step('migrate'),
    refreshActiveWorldbooks: step('refresh'), applyBindings: step('apply'),
    schedulePostCaptureReapply: () => effects.push('schedule'),
    scheduleApply: () => effects.push('schedule-apply'),
    findDatabaseFrame: () => null,
    setInterval: callback => { effects.push('poll'); pollers.push(callback); return 1; },
    log: () => effects.push('log'),
  });
  return { env, paused, effects, pollers };
}

for (const stage of ['capture', 'migrate', 'refresh', 'apply']) {
  test(`destroying during startup ${stage} cannot resume writes or install polling`, async () => {
    const { env, paused, effects } = startupHarness(stage);
    const running = env.main();
    await flushMicrotasks();
    assert.equal(effects.at(-1), stage);
    effects.length = 0;
    env.runtime.started = false;
    env.invalidateBindingContext();
    paused.resolve();
    await running;
    assert.deepEqual(effects, []);
  });
}

test('an in-flight poll capture cannot schedule work after destroy', async () => {
  const { env, effects, pollers } = startupHarness();
  await env.main();
  assert.equal(pollers.length, 1);
  const captured = deferred();
  env.runtime.settingsRef = null;
  env.captureDatabaseSettings = () => captured.promise;
  pollers[0]();
  effects.length = 0;
  env.runtime.started = false;
  env.invalidateBindingContext();
  captured.resolve({});
  await flushMicrotasks();
  assert.deepEqual(effects, []);
});
