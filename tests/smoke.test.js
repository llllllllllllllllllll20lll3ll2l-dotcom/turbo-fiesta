// Смоук-тест агента: мок chrome-API + мок fetch, тест жизненного цикла runAgent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------- Моки chrome-API ----------
function makeChromeMock({ pages }) {
  const listeners = { message: [], connect: [], startup: [] };
  const tabs = new Map();
  let nextTabId = 1;

  return {
    _listeners: listeners,
    _tabs: tabs,
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      sendMessage: (msg, cb) => {
        // синхронная отправка в зарегистрированные обработчики
        for (const fn of listeners.message) {
          const ret = fn(msg, {}, (res) => cb?.(res));
          if (ret === true) return;
        }
      },
    },
    storage: {
      local: {
        _data: {},
        async get(key) {
          if (key == null) return { ...this._data };
          if (typeof key === 'string') return { [key]: this._data[key] };
          return this._data;
        },
        async set(obj) { Object.assign(this._data, obj); },
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, active: true, url: 'https://example.com/page', pinned: false }];
      },
      async get(id) { return { id, status: 'complete', url: 'https://example.com/page' }; },
      async sendMessage(tabId, msg) {
        if (msg?.type === 'page:read') return pages[tabId] || {
          title: 'Пример', url: 'https://example.com/page',
          text: 'Привет! Это тестовая страница с содержимым.',
          fields: [], forms: [],
        };
        if (msg?.type === 'cursor:on') return { ok: true };
        if (msg?.type === 'cursor:off') return { ok: true };
        if (msg?.type === 'fill-fields') return { filled: 1, failed: 0, results: [] };
        return null;
      },
      async create({ url } = {}) {
        const id = nextTabId++;
        tabs.set(id, { id, url, status: 'complete' });
        return { id };
      },
      async remove(id) { tabs.delete(id); },
    },
  };
}

// ---------- Запуск теста ----------
test('полный агентский цикл: read_page → answer', async () => {
  const pages = {};
  const chromeMock = makeChromeMock({ pages });

  // фиктивный ответ Ollama: сначала read_page, потом answer
  let call = 0;
  const fakeFetch = async (url, opts) => {
    call++;
    const body = JSON.parse(opts?.body || '{}');
    const content = body?.messages?.[body.messages.length - 1]?.content || '';
    let message;
    if (call === 1) message = '{"action":"read_page"}';
    else message = '{"action":"answer","params":{"text":"Страница прочитана: это тест."}}';
    return {
      ok: true,
      json: async () => ({ message: { content: message }, model: 'qwen2.5:3b', done: true }),
      text: async () => message,
    };
  };

  globalThis.chrome = chromeMock;
  globalThis.fetch = fakeFetch;

  // подгружаем background.js
  const mod = await import('../src/background/background.js?smoke=1');

  // создаём фейковый порт
  const events = [];
  const fakePort = {
    name: 'agent',
    postMessage: (m) => events.push(m),
    onMessage: { addListener: (fn) => { fakePort._onMessage = fn; } },
    onDisconnect: { addListener: () => {} },
  };
  for (const fn of chromeMock._listeners.connect) fn(fakePort);

  // отправляем задачу через порт
  fakePort._onMessage({ type: 'chat:send', message: 'Прочитай эту страницу' });

  // ждём события ответа
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const answer = events.find((e) => e.kind === 'answer');
    if (answer) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const answer = events.find((e) => e.kind === 'answer');
  assert.ok(answer, 'агентом должен прийти answer-событие; событие: ' + JSON.stringify(events));
  assert.equal(call, 2, 'должно быть 2 вызова к Ollama');
  assert.match(answer.text, /Страница прочитана/);

  // курсор должен был показаться/скрыться
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds.includes('done'), true);
});

test('агент: модель ответила не-JSON → повтор → answer', async () => {
  const chromeMock = makeChromeMock({ pages: {} });
  let call = 0;
  const fakeFetch = async () => {
    call++;
    const msg = call === 1
      ? 'привет, давай начнём' // не JSON — агент попытается ещё раз
      : '{"action":"answer","params":{"text":"Ок, слушаю."}}';
    return {
      ok: true,
      json: async () => ({ message: { content: msg }, model: 'm', done: true }),
      text: async () => msg,
    };
  };
  globalThis.chrome = chromeMock;
  globalThis.fetch = fakeFetch;

  const mod = await import('../src/background/background.js?smoke2=1');

  const events = [];
  const fakePort = {
    name: 'agent',
    postMessage: (m) => events.push(m),
    onMessage: { addListener: (fn) => { fakePort._onMessage = fn; } },
    onDisconnect: { addListener: () => {} },
  };
  for (const fn of chromeMock._listeners.connect) fn(fakePort);

  fakePort._onMessage({ type: 'chat:send', message: 'привет' });
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (events.find((e) => e.kind === 'answer')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const answer = events.find((e) => e.kind === 'answer');
  assert.ok(answer, 'answer должен прийти');
  assert.equal(call, 2);
  assert.match(answer.text, /Ок, слушаю/);
});

test('агент: Ollama недоступен → error', async () => {
  const chromeMock = makeChromeMock({ pages: {} });
  // fetch выкидывает ошибку (Ollama не запущен)
  globalThis.chrome = chromeMock;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };

  const mod = await import('../src/background/background.js?smoke3=1');

  const events = [];
  const fakePort = {
    name: 'agent',
    postMessage: (m) => events.push(m),
    onMessage: { addListener: (fn) => { fakePort._onMessage = fn; } },
    onDisconnect: { addListener: () => {} },
  };
  for (const fn of chromeMock._listeners.connect) fn(fakePort);

  fakePort._onMessage({ type: 'chat:send', message: 'тест' });
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (events.find((e) => e.kind === 'error')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const error = events.find((e) => e.kind === 'error');
  assert.ok(error, 'error должен прийти; события: ' + JSON.stringify(events));
  assert.match(error.message, /Ошибка|Ollama/);
});
