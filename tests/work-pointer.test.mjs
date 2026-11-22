import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkPointer } from '../extension/work-pointer.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function browserMock() {
  const calls = [];
  const listeners = { activated: null, updated: null, removed: null, focused: null };
  const tabById = id => id === 1 ? { id, url: 'https://example.com/', active: true } :
    id === 2 ? { id, url: 'https://web.max.ru/', active: true } : { id, url: 'chrome://extensions/', active: true };
  const event = key => ({ addListener(fn) { listeners[key] = fn; }, removeListener(fn) { if (listeners[key] === fn) listeners[key] = null; } });
  const api = {
    tabs: {
      query: async () => [tabById(1)],
      get: async id => tabById(id),
      sendMessage: async (id, msg) => { calls.push([id, msg]); if (id === 2 && msg.action === 'POINTER_START') throw Error('Receiving end does not exist'); return { ok: true, result: { visible: msg.action === 'POINTER_START' } }; },
      onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed')
    },
    scripting: { executeScript: async options => { calls.push(['inject', options.target.tabId]); } },
    windows: { onFocusChanged: event('focused') }
  };
  return { api, calls, listeners };
}

test('working cursor appears on web page and is removed when request ends', async () => {
  const { api, calls, listeners } = browserMock();
  const session = startWorkPointer(api);
  await session.ready;
  assert.ok(calls.some(([id, msg]) => id === 1 && msg.action === 'POINTER_START'));
  session.stop();
  await tick();
  assert.ok(calls.some(([id, msg]) => id === 1 && msg.action === 'POINTER_STOP'));
  assert.equal(listeners.activated, null);
  assert.equal(listeners.updated, null);
});

test('cursor injects new content script when an old script ignores pointer messages', async () => {
  const { api, calls } = browserMock();
  let injected = false;
  api.tabs.sendMessage = async (id, msg) => {
    calls.push([id, msg]);
    return injected ? { ok: true, result: { visible: msg.action === 'POINTER_START' } } : undefined;
  };
  api.scripting.executeScript = async () => { injected = true; calls.push(['inject', 1]); };
  const session = startWorkPointer(api);
  await session.ready;
  assert.ok(injected);
  assert.ok(calls.filter(([id, msg]) => id === 1 && msg?.action === 'POINTER_START').length === 2);
  session.stop();
});

test('cursor follows tab activation, reinjects on page load, skips restricted pages', async () => {
  const { api, calls, listeners } = browserMock();
  // Simulate an extension without content script in tab 2; the controller injects it.
  api.tabs.sendMessage = async (id, msg) => {
    calls.push([id, msg]);
    if (id === 2 && msg.action === 'POINTER_START' && !calls.some(call => call[0] === 'inject')) throw Error('No receiver');
    return { ok: true, result: { visible: msg.action === 'POINTER_START' } };
  };
  const session = startWorkPointer(api);
  await session.ready;
  listeners.activated({ tabId: 2, windowId: 1 });
  await tick();
  assert.ok(calls.some(([id, msg]) => id === 1 && msg.action === 'POINTER_STOP'));
  assert.ok(calls.some(([kind, id]) => kind === 'inject' && id === 2));
  assert.ok(calls.some(([id, msg]) => id === 2 && msg.action === 'POINTER_START'));
  listeners.updated(2, { status: 'complete' }, { active: true });
  await tick();
  listeners.activated({ tabId: 3, windowId: 1 });
  await tick();
  assert.ok(calls.some(([id, msg]) => id === 2 && msg.action === 'POINTER_STOP'));
  assert.ok(!calls.some(([id, msg]) => id === 3 && msg?.action === 'POINTER_START'));
  session.stop();
});

test('abort clears the cursor and prevents future injection', async () => {
  const { api, calls, listeners } = browserMock();
  const controller = new AbortController();
  const session = startWorkPointer(api, controller.signal);
  await session.ready;
  controller.abort();
  listeners.activated?.({ tabId: 2 });
  await tick();
  assert.equal(listeners.activated, null);
  assert.ok(calls.some(([id, msg]) => id === 1 && msg.action === 'POINTER_STOP'));
  assert.ok(!calls.some(([id, msg]) => id === 2 && msg?.action === 'POINTER_START'));
});
