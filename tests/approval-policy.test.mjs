import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationsEnabled, approvalForRequest } from '../extension/approval-policy.mjs';
import { executeBrowserTool } from '../extension/browser-tools.mjs';

test('confirmation remains enabled by default and with malformed storage values', () => {
  for (const value of [undefined, null, 0, 'false', {}, true]) assert.equal(confirmationsEnabled(value), true);
  assert.equal(confirmationsEnabled(false), false);
});

test('enabled requests ask every time; denied requests never pass through', async () => {
  const controller = new AbortController();
  const seen = [];
  const approve = approvalForRequest(true, async (details, signal) => {
    assert.equal(signal, controller.signal);
    seen.push(details.title);
    return details.title !== 'Запретить';
  }, controller.signal);
  assert.equal(await approve({ title: 'Разрешить' }), true);
  assert.equal(await approve({ title: 'Запретить' }), false);
  assert.deepEqual(seen, ['Разрешить', 'Запретить']);
});

test('opted-out requests bypass prompts but not aborts; policy stays fixed per request', async () => {
  const controller = new AbortController();
  let asked = 0;
  const ask = async () => { asked++; return true; };
  const optedOut = approvalForRequest(false, ask, controller.signal);
  const optedIn = approvalForRequest(true, ask, controller.signal);
  assert.equal(await optedOut({ title: 'Открыть' }), true);
  assert.equal(asked, 0);
  assert.equal(await optedIn({ title: 'Открыть' }), true);
  assert.equal(asked, 1);
  controller.abort();
  assert.equal(await optedOut({ title: 'Открыть' }), false);
  assert.equal(await optedIn({ title: 'Открыть' }), false);
  assert.equal(asked, 1);
});

test('opt-out also bypasses click and typing dialogs while retaining ref checks', async () => {
  const calls = [];
  const tab = { id: 3, windowId: 1, url: 'https://example.com/' };
  const api = {
    tabs: {
      query: async () => [tab],
      sendMessage: async (_tabId, message) => {
        calls.push(message.action);
        if (message.action === 'INSPECT') return { ok: true, result: { label: 'Поиск', href: '', draft: '' } };
        return { ok: true, result: {} };
      }
    }
  };
  const controller = new AbortController();
  const approve = approvalForRequest(false, () => { throw new Error('Dialog should not open'); }, controller.signal);
  await executeBrowserTool(api, 'type', { ref: 'deadbeef:1:1', text: 'запрос' }, approve, controller.signal);
  await executeBrowserTool(api, 'click', { ref: 'deadbeef:1:1' }, approve, controller.signal);
  assert.ok(calls.includes('TYPE'));
  assert.ok(calls.includes('CLICK'));
  await assert.rejects(executeBrowserTool(api, 'click', { ref: 'invalid' }, approve, controller.signal), /read_page/);
});

test('opt-out opens a public URL but still rejects unsafe targets before bypass', async () => {
  let created;
  const api = {
    tabs: {
      create: async args => { created = args; return { id: 4, windowId: 2 }; },
      query: async () => [{ id: 4 }]
    },
    windows: { update: async () => {}, get: async () => ({ focused: true }) }
  };
  const controller = new AbortController();
  const approve = approvalForRequest(false, () => { throw new Error('Dialog should not open'); }, controller.signal);
  const result = await executeBrowserTool(api, 'open_url', { url: 'https://web.max.ru/' }, approve, controller.signal);
  assert.equal(result.ok, true);
  assert.equal(created.url, 'https://web.max.ru/');
  await assert.rejects(executeBrowserTool(api, 'open_url', { url: 'http://127.0.0.1/' }, approve, controller.signal), /Небезопасный/);
});
