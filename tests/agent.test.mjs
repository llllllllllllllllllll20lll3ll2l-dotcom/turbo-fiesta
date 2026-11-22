import test from 'node:test';
import assert from 'node:assert/strict';
import { tabSwitchIntent } from '../extension/core.mjs';
import { rankTab, safeWebUrl, switchTabByName, executeBrowserTool } from '../extension/browser-tools.mjs';
import { runBrowserAgent } from '../extension/agent.mjs';

const ref = 'deadbeef:1:2';
const tab = { id: 8, windowId: 2, title: 'MAX — чат', url: 'https://max.ru/', active: true };
function mockApi() {
  const events = [];
  const api = {
    tabs: {
      query: async () => [tab],
      update: async (...args) => { events.push(['update', ...args]); },
      create: async args => { events.push(['create', args]); },
      sendMessage: async (_id, msg) => {
        events.push(['message', msg]);
        if (msg.action === 'INSPECT') return { ok: true, result: { label: 'Отправить', href: '', draft: 'Привет' } };
        return { ok: true, result: { scheduled: true } };
      }
    },
    windows: { update: async (...args) => { events.push(['window', ...args]); } }
  };
  return { api, events };
}

test('direct MAX request switches an existing tab and focuses its window without Ollama', async () => {
  assert.equal(tabSwitchIntent('Зайди на вкладку MAX'), 'MAX');
  assert.equal(tabSwitchIntent('переключись на вкладку «MAX»'), 'MAX');
  assert.equal(tabSwitchIntent('Привет, MAX'), null);
  const { api, events } = mockApi();
  const result = await switchTabByName(api, 'MAX');
  assert.equal(result.ok, true);
  assert.deepEqual(events, [['update', 8, { active: true }], ['window', 2, { focused: true }]]);
});

test('tab matching prefers exact word; ambiguous matches do not switch', async () => {
  assert.equal(rankTab({ title: 'MAX — чат' }, 'MAX'), 80);
  assert.equal(rankTab({ title: 'MAXIMUM' }, 'MAX'), 50);
  const { api, events } = mockApi();
  api.tabs.query = async () => [{ ...tab, id: 8 }, { ...tab, id: 9 }];
  const result = await switchTabByName(api, 'MAX');
  assert.equal(result.ok, false);
  assert.equal(events.length, 0);
});

test('rejects private and non-web addresses and credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://localhost:8080/', 'http://127.1/', 'http://192.168.1.2/', 'https://[::1]/', 'https://name:pass@example.com/', 'https://host.local/']) {
    assert.equal(safeWebUrl(url), null, url);
  }
  assert.equal(safeWebUrl('https://example.com/path'), 'https://example.com/path');
});

test('opening sites, search and form clicks require explicit approval', async () => {
  const { api, events } = mockApi();
  const open = await executeBrowserTool(api, 'open_url', { url: 'https://example.com/' }, async () => false);
  assert.equal(open.denied, true);
  const search = await executeBrowserTool(api, 'search_web', { query: 'кот' }, async () => false);
  assert.equal(search.denied, true);
  const click = await executeBrowserTool(api, 'click', { ref }, async () => false);
  assert.equal(click.denied, true);
  assert.equal(events.filter(event => event[0] === 'create' || event[1]?.action === 'CLICK').length, 0);
});

test('click uses inspected form draft and target tab unchanged after approval', async () => {
  const { api, events } = mockApi();
  let prompt;
  const result = await executeBrowserTool(api, 'click', { ref }, async value => { prompt = value; return true; });
  assert.equal(result.ok, true);
  assert.match(prompt.detail, /Привет/);
  assert.deepEqual(events.find(event => event[1]?.action === 'CLICK')[1].expected, { label: 'Отправить', href: '', draft: 'Привет' });
  let active = tab;
  api.tabs.query = async () => [active];
  await assert.rejects(executeBrowserTool(api, 'click', { ref }, async () => { active = { ...tab, id: 10 }; return true; }), /Вкладка сменилась/);
  assert.equal(events.filter(event => event[1]?.action === 'CLICK').length, 1);
});

test('typing requires confirmation and sends exact inspected text; scrolling does not send form data', async () => {
  const { api, events } = mockApi();
  let confirmation;
  const result = await executeBrowserTool(api, 'type', { ref, text: 'Здравствуйте' }, async item => { confirmation = item; return true; });
  assert.equal(result.ok, true);
  assert.match(confirmation.detail, /Здравствуйте/);
  const sent = events.find(event => event[1]?.action === 'TYPE')[1];
  assert.equal(sent.text, 'Здравствуйте');
  assert.deepEqual(sent.expected, { label: 'Отправить', text: 'Здравствуйте' });
  await executeBrowserTool(api, 'scroll', { direction: 'down' });
  assert.ok(events.some(event => event[1]?.action === 'SCROLL'));
  await assert.rejects(executeBrowserTool(api, 'type', { ref: '1:2', text: 'x' }, async () => true), /read_page/);
});

test('abort after approval prevents a new navigation', async () => {
  const { api, events } = mockApi();
  const controller = new AbortController();
  await assert.rejects(executeBrowserTool(api, 'open_url', { url: 'https://example.org/' }, async () => {
    controller.abort(); return true;
  }, controller.signal), /Остановлено/);
  assert.equal(events.length, 0);
});

test('agent sends tool calls to Ollama and stops on user denial', async () => {
  const { api, events } = mockApi();
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(item => item.function.name === 'switch_tab'));
    requests++;
    return { ok: true, json: async () => ({ message: { tool_calls: [{ function: { name: 'open_url', arguments: { url: 'https://example.com/' } } }] } }) };
  };
  try {
    const result = await runBrowserAgent({ prompt: 'Открой сайт', model: 'qwen3:4b-instruct-2507-q4_K_M', api, approve: async () => false });
    assert.match(result.answer, /отменили/);
    assert.equal(requests, 1);
    assert.equal(events.length, 0);
  } finally { globalThis.fetch = oldFetch; }
});
