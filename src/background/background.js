// Aura — фоновый service worker (MV3, ES module).
// Отвечает за: чат с Ollama, агентные действия, вкладки, формы, курсор.

import {
  parseAction, buildPrompt, buildSearchUrl, isAllowedUrl, actionLabel,
} from '../lib/agent.js';
import {
  checkOllama, chatOnce, findInTabs,
  OLLAMA_DEFAULT_URL, OLLAMA_DEFAULT_MODEL,
} from '../lib/ollama.js';
import {
  fieldPlan, valueFor, profileValueFor, classifyField, isFillable,
  FIELD_TYPES,
} from '../lib/fields.js';

// ---------- Константы ----------
const MAX_STEPS = 8;
const CHAT_HISTORY_KEY = 'aura-chat';
const CHAT_MAX_STORED = 50;
const SETTINGS_KEY = 'aura-settings';
const PROFILE_KEY = 'aura-profile';
const DEFAULT_SETTINGS = {
  ollamaUrl: OLLAMA_DEFAULT_URL,
  model: OLLAMA_DEFAULT_MODEL,
  engine: 'yandex',
  autoFill: true,
};
const DEFAULT_PROFILE = {
  name: '', first_name: '', last_name: '', phone: '', email: '', age: '',
  city: '', address: '', birthdate: '', website: '', occupation: '', about: '',
};

// ---------- Состояние ----------
let currentPort = null;
let agentRunId = 0;

// ---------- Хранилище ----------
const storage = {
  async get(key, fallback) {
    try {
      const data = await chrome.storage.local.get(key);
      return data?.[key] ?? fallback;
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try { await chrome.storage.local.set({ [key]: value }); } catch { /* noop */ }
  },
};

async function getSettings() {
  const s = await storage.get(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...s };
}
async function getProfile() {
  const p = await storage.get(PROFILE_KEY, {});
  return { ...DEFAULT_PROFILE, ...p };
}

let _chatCache = null;
async function loadChat() {
  if (_chatCache) return _chatCache;
  _chatCache = await storage.get(CHAT_HISTORY_KEY, []);
  return _chatCache;
}
async function saveChat(list) {
  _chatCache = list.slice(-CHAT_MAX_STORED);
  await storage.set(CHAT_HISTORY_KEY, _chatCache);
}

// ---------- Порты ----------
function emit(msg) {
  if (currentPort) {
    try { currentPort.postMessage(msg); } catch { /* port closed */ }
  }
}

// ---------- Ollama ----------
async function checkModel(settings) {
  return await checkOllama(settings.ollamaUrl, fetch);
}

// ---------- Очистка текста ветки ----------
function sanitizeChatForModel(messages) {
  // Для модели только user/assistant/system
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({
      role: m.role,
      content: String(m.text ?? m.content ?? '').slice(0, 3000),
    }))
    .filter((m) => m.content.trim());
}

// ---------- Вкладки ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function readTabPage(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'page:read' });
  } catch (ex) {
    return null;
  }
}

async function waitForTab(tabId, maxMs = 20000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.status === 'complete') { clearInterval(timer); resolve(tab); return; }
        if (Date.now() - start > maxMs) { clearInterval(timer); resolve(tab); }
      } catch { clearInterval(timer); resolve(null); }
    }, 300);
  });
}

// ---------- AI-курсор ----------
async function showCursor() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'cursor:on' });
      if (res?.ok) return true;
    } catch { /* вкладка ещё не готова */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function hideCursor() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'cursor:off' }); } catch { /* closed */ }
}

// ---------- JSON из ответа модели (для массивов полей) ----------
function parseModelJsonArray(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const direct = raw.trim();
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const d = tryParse(direct);
  if (Array.isArray(d)) return d;
  // ищем сбалансированные [...] блоки
  let best = null;
  let depth = 0, start = -1;
  for (let i = 0; i < direct.length; i++) {
    const ch = direct[i];
    if (ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === ']') { depth--; if (depth === 0 && start >= 0) { const r = tryParse(direct.slice(start, i + 1)); if (Array.isArray(r)) best = r; start = -1; } }
  }
  return best;
}

function buildFieldFillPrompt(fields, snapshot) {
  const lines = [];
  lines.push('Ты заполняешь форму на веб-странице. Пользователь НЕ хочет, чтобы форма была отправлена — только заполнить поля.');
  lines.push('');
  lines.push(`Страница: "${snapshot?.title || ''}"`);
  lines.push('');
  lines.push('Найди значения для полей. Ответь СТРОГО JSON-массивом, без комментариев:');
  lines.push('[{"i": <число из поля>, "value": "<значение>"}]');
  lines.push('');
  lines.push('Правила:');
  lines.push('- Уникальное имя/фамилия/телефон НЕ угадывай. Если не знаешь — value: null.');
  lines.push('- Для Email опиши, как пишется локальная часть, если поле пуст. Иначе value: null.');
  lines.push('- Для SELECT выбирай только вариант, который реально есть в options.');
  lines.push('- Для textarea и комментариев — короткое правдоподобное значение на русском.');
  lines.push('- Для checkbox/radio — "true" или "false".');
  lines.push('');
  lines.push('Поля:');
  for (const f of fields) {
    lines.push(`[${f.i}] ${f.tag} ${f.type} «${f.label}»${f.options?.length ? ` (options: ${f.options.join(' | ')})` : ''}`);
  }
  return lines.join('\n');
}

// ---------- Заполнение формы ----------
async function runFillForm(profile, settings) {
  if (!settings.autoFill) {
    return { ok: false, reason: 'Автозаполнение форм выключено в настройках' };
  }
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, reason: 'Нет активной вкладки' };
  const snapshot = await readTabPage(tab.id);
  if (!snapshot) return { ok: false, reason: 'Не удалось прочитать страницу' };
  if (!snapshot.fields?.length) return { ok: false, reason: 'На странице нет полей для заполнения' };

  const items = [];
  const aiNeeded = [];
  for (const field of snapshot.fields) {
    if (!isFillable(field)) continue;
    const plan = fieldPlan(field, profile);
    if (plan.needsProfile) {
      const v = valueFor(field, profile);
      if (v) items.push({ i: field.i, value: v, label: field.label });
    } else if (plan.needsAi) {
      aiNeeded.push(field);
    }
  }

  // AI для оставшихся
  if (aiNeeded.length) {
    try {
      const prompt = buildFieldFillPrompt(aiNeeded, snapshot);
      const res = await chatOnce({
        baseUrl: settings.ollamaUrl,
        model: settings.model,
        messages: [
          { role: 'system', content: 'Ты агент формы. Отвечаешь только JSON-массивом.' },
          { role: 'user', content: prompt },
        ],
        fetchImpl: fetch,
      });
      const arr = parseModelJsonArray(res.text);
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (it && typeof it.i === 'number' && it.value != null && String(it.value).trim()) {
            items.push({ i: it.i, value: String(it.value).trim(), label: aiNeeded.find((f) => f.i === it.i)?.label || '' });
          }
        }
      }
    } catch (ex) {
      // AI недоступен — просто возвращаемся без AI полей
      console.warn('AI fill failed:', ex?.message);
    }
  }

  if (!items.length) {
    return {
      ok: true,
      filled: 0,
      failed: 0,
      reason: 'Нечего заполнять (профиль пустой и поля не требуют AI)',
    };
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'fill-fields', items });
    return { ok: true, ...result, ai: { used: aiNeeded.length, provided: items.length } };
  } catch (ex) {
    return { ok: false, reason: 'Не удалось отправить заполнение на страницу' };
  }
}

// ---------- Поиск во вкладках ----------
async function findInOpenTabs(query) {
  const tabs = await chrome.tabs.query({});
  const results = [];
  for (const tab of tabs) {
    if (!tab.id || tab.url?.startsWith('chrome://') || tab.url?.startsWith('about:')) continue;
    const snapshot = await readTabPage(tab.id);
    if (!snapshot?.text) continue;
    results.push({ id: tab.id, title: snapshot.title, url: snapshot.url, text: snapshot.text.slice(0, 4000) });
    if (results.length >= 20) break;
  }
  return await findInTabs({ tabs: results, query });
}

// ---------- Основное: агент ----------
async function runAgent(goal, { assistantText = '' } = {}) {
  const runId = ++agentRunId;
  const settings = await getSettings();
  const profile = await getProfile();
  const ollamaCheck = await checkModel(settings);
  if (!ollamaCheck.ok) {
    emit({ kind: 'error', message: `Ollama недоступен: ${ollamaCheck.error || 'проверьте, что Ollama запущен'}. Убедитесь, что Ollama работает на ${settings.ollamaUrl}` });
    return;
  }
  if (!ollamaCheck.models.find((m) => m.startsWith(settings.model.split(':')[0]))) {
    // model may not be exactly present; still try — user might use exact name
  }

  // курсор
  const showCursorPromise = showCursor();

  // текущая страница
  const tab = await getActiveTab();
  const snapshot = tab?.id ? await readTabPage(tab.id) : null;

  const history = [];
  history.push({ role: 'system', content: 'Ты агент внутри браузера. Отвечай РОВНО ОДНОЙ строкой JSON с действием. См. правила в задаче.' });
  history.push({
    role: 'user',
    content: buildPrompt({
      goal,
      page: snapshot ? summarizePageInline(snapshot) : null,
      lastResult: null,
      engine: settings.engine,
    }),
  });

  emit({ kind: 'status', state: 'running' });

  let finalAnswer = null;
  let lastResult = null;
  let iterations = 0;
  let errorOccurred = null;

  try {
    while (iterations < MAX_STEPS) {
      if (runId !== agentRunId) return; // прервано
      iterations++;

      const messages = sanitizeChatForModel(history);
      let response;
      try {
        response = await chatOnce({
          baseUrl: settings.ollamaUrl,
          model: settings.model,
          messages,
          fetchImpl: fetch,
        });
      } catch (ex) {
        errorOccurred = `Ошибка запроса к Ollama: ${ex?.message || ex}`;
        emit({ kind: 'error', message: errorOccurred });
        break;
      }
      const action = parseAction(response.text);
      if (!action) {
        // одна попытка с подсказкой
        history.push({ role: 'assistant', content: response.text.slice(0, 500) });
        history.push({ role: 'user', content: 'Ответь РОВНО ОДНОЙ строкой JSON вида {"action":"answer","params":{"text":"..."}}. Без комментариев.' });
        continue;
      }

      emit({ kind: 'step', label: actionLabel(action.action, action.params), detail: action.action === 'answer' ? String(action.params?.text || '').slice(0, 300) : undefined });

      switch (action.action) {
        case 'answer': {
          finalAnswer = String(action.params?.text || '').trim();
          if (!finalAnswer) finalAnswer = '(модель не дала текста ответа)';
          iterations = MAX_STEPS; // выпадим из цикла
          break;
        }
        case 'read_page': {
          const freshTab = await getActiveTab();
          const page = await readTabPage(freshTab?.id);
          if (page) {
            const text = page.text.slice(0, 3000);
            lastResult = `Страница загружена. Заголовок: ${page.title}. Содержимое: ${text.slice(0, 1200)}`;
          } else {
            lastResult = 'Страница не прочитана.';
          }
          history.push({ role: 'assistant', content: response.text.slice(0, 500) });
          history.push({ role: 'user', content: `Результат шага «read_page»: ${lastResult}. Что делать дальше?` });
          break;
        }
        case 'search_web': {
          const query = String(action.params?.query || '').trim();
          const url = buildSearchUrl(settings.engine, query);
          if (!url) {
            history.push({ role: 'assistant', content: response.text.slice(0, 500) });
            history.push({ role: 'user', content: 'Поисковый запрос пуст. Попробуй еще раз.' });
            break;
          }
          const newTab = await chrome.tabs.create({ url, active: true });
          emit({ kind: 'step', label: `Поиск: «${query}»`, detail: `Открыта вкладка «${query}»` });
          await waitForTab(newTab.id, 20000);
          const page = await readTabPage(newTab.id);
          const snippet = (page?.text || '').slice(0, 1200);
          lastResult = `Результат поиска: ${query}. Страница: "${page?.title || '?'}". Содержимое: ${snippet}`;
          history.push({ role: 'assistant', content: response.text.slice(0, 500) });
          history.push({ role: 'user', content: `Результат шага «search_web»: ${lastResult}. Что делать дальше?` });
          break;
        }
        case 'open_tab': {
          const url = String(action.params?.url || '').trim();
          if (!isAllowedUrl(url)) {
            history.push({ role: 'assistant', content: response.text.slice(0, 500) });
            history.push({ role: 'user', content: 'Недопустимый URL (нужен http/https). Попробуй другой.' });
            break;
          }
          const newTab = await chrome.tabs.create({ url, active: true });
          emit({ kind: 'step', label: `Открыта страница`, detail: url });
          await waitForTab(newTab.id, 20000);
          const page = await readTabPage(newTab.id);
          lastResult = `Страница открыта: ${url}. Заголовок: ${page?.title || '?'}. Содержимое: ${(page?.text || '').slice(0, 1200)}`;
          history.push({ role: 'assistant', content: response.text.slice(0, 500) });
          history.push({ role: 'user', content: `Результат шага «open_tab»: ${lastResult}. Что делать дальше?` });
          break;
        }
        case 'close_tab': {
          const current = await getActiveTab();
          if (current?.id) {
            await chrome.tabs.remove(current.id).catch(() => {});
            emit({ kind: 'step', label: 'Вкладка закрыта' });
            lastResult = 'Активная вкладка закрыта.';
          } else {
            lastResult = 'Нет активной вкладки для закрытия.';
          }
          history.push({ role: 'assistant', content: response.text.slice(0, 500) });
          history.push({ role: 'user', content: `Результат шага «close_tab»: ${lastResult}. Что делать дальше?` });
          break;
        }
        case 'fill_form': {
          emit({ kind: 'step', label: 'Заполнение формы…' });
          const result = await runFillForm(profile, settings);
          if (result.ok) {
            emit({
              kind: 'fill-result',
              filled: result.filled || 0,
              failed: (result.failed || 0),
              reason: result.reason || null,
            });
            lastResult = result.filled
              ? `Форма заполнена: заполнено ${result.filled} полей, ошибок ${result.failed}.`
              : `Форма не заполнена: ${result.reason || 'нет данных'}.`;
          } else {
            lastResult = `Ошибка заполнения: ${result.reason}`;
            errorOccurred = errorOccurred || lastResult;
            emit({ kind: 'error', message: lastResult });
          }
          history.push({ role: 'assistant', content: response.text.slice(0, 500) });
          history.push({ role: 'user', content: `Результат шага «fill_form»: ${lastResult}. Что делать дальше?` });
          break;
        }
        case 'done': {
          if (!finalAnswer) finalAnswer = assistantText || 'Готово.';
          iterations = MAX_STEPS; // выпадим из цикла
          break;
        }
      }
    }

    if (errorOccurred) {
      // ошибка уже показана — не выдавай фантомный «ответ»
      emit({ kind: 'status', state: 'idle' });
      emit({ kind: 'done' });
      return;
    }

    if (!finalAnswer) {
      finalAnswer = lastResult || 'Агент выполнил ограниченный цикл действий без явного ответа.';
    }

    saveChatMessage('assistant', finalAnswer);
    emit({ kind: 'answer', text: finalAnswer });
    emit({ kind: 'done' });
  } catch (ex) {
    emit({ kind: 'error', message: `Ошибка агента: ${ex?.message || ex}` });
  } finally {
    hideCursor();
    await showCursorPromise.catch(() => {});
    emit({ kind: 'status', state: 'idle' });
  }
}

function summarizePageInline(snapshot) {
  return {
    title: snapshot.title || '',
    url: snapshot.url || '',
    text: (snapshot.text || '').slice(0, 2500),
    fields: (snapshot.fields || []).slice(0, 40).map((f) => ({
      i: f.i, tag: f.tag, type: f.type, name: String(f.name || '').slice(0, 60), value: String(f.value || '').slice(0, 40),
    })),
  };
}

function saveChatMessage(role, text) {
  (async () => {
    const list = await loadChat();
    list.push({ role, text, ts: Date.now() });
    await saveChat(list);
  })();
}

// ---------- Обработчики сообщений ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'status:get': {
      (async () => {
        const stored = await getSettings();
        const settings = { ...stored, ...(msg.settings || {}) };
        const ollama = await checkModel(settings);
        sendResponse({ settings, ollama, chat: (await loadChat()) });
      })();
      return true;
    }
    case 'settings:get': {
      getSettings().then((s) => sendResponse({ settings: s }));
      return true;
    }
    case 'settings:set': {
      const merged = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      storage.set(SETTINGS_KEY, merged).then(() => sendResponse({ ok: true, settings: merged }));
      return true;
    }
    case 'profile:get': {
      getProfile().then((p) => sendResponse({ profile: p }));
      return true;
    }
    case 'profile:set': {
      const merged = { ...DEFAULT_PROFILE, ...(msg.profile || {}) };
      storage.set(PROFILE_KEY, merged).then(() => sendResponse({ ok: true, profile: merged }));
      return true;
    }
    case 'page:read': {
      (async () => {
        const tab = await getActiveTab();
        if (!tab?.id) { sendResponse({ ok: false, reason: 'Нет активной вкладки' }); return; }
        const snapshot = await readTabPage(tab.id);
        sendResponse({ ok: Boolean(snapshot), snapshot });
      })();
      return true;
    }
    case 'find-in-tabs': {
      findInOpenTabs(msg.query || '').then((results) => sendResponse({ results }));
      return true;
    }
    case 'chat:get': {
      loadChat().then((list) => sendResponse({ chat: list }));
      return true;
    }
    case 'chat:clear': {
      _chatCache = [];
      storage.set(CHAT_HISTORY_KEY, []).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'fill-form': {
      (async () => {
        const result = await runFillForm(await getProfile(), await getSettings());
        sendResponse(result);
      })();
      return true;
    }
    case 'cursor:off': {
      hideCursor().then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'tab:new': {
      const url = String(msg.url || '').trim();
      if (!isAllowedUrl(url)) { sendResponse({ ok: false, reason: 'Нужна http(s)-ссылка' }); return true; }
      chrome.tabs.create({ url, active: true }).then((tab) => sendResponse({ ok: true, tabId: tab.id }));
      return true;
    }
    case 'tab:close': {
      (async () => {
        const tab = await getActiveTab();
        if (!tab?.id) { sendResponse({ ok: false, reason: 'Нет активной вкладки' }); return; }
        await chrome.tabs.remove(tab.id).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'tab:list': {
      chrome.tabs.query({}).then((tabs) => sendResponse({
        tabs: tabs.slice(0, 30).map((t) => ({ id: t.id, title: t.title || '(без заголовка)', url: t.url || '', active: t.active, pinned: t.pinned })),
      }));
      return true;
    }
  }
  return false;
});

// Порт от попапа (для асинхронного потока событий)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'agent') return;
  currentPort = port;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'chat:send' && typeof msg.message === 'string' && msg.message.trim()) {
      // если уже идёт агент — прерываем
      agentRunId++;
      const goal = msg.message.trim().slice(0, 800);
      saveChatMessage('user', goal);
      runAgent(goal).catch((ex) => {
        console.error('runAgent error:', ex);
        emit({ kind: 'error', message: `Ошибка агента: ${ex?.message || ex}` });
        emit({ kind: 'done' });
      });
    }
    if (msg?.type === 'abort') {
      agentRunId++; // прервать текущий
      hideCursor();
      emit({ kind: 'done' });
    }
  });
  port.onDisconnect.addListener(() => {
    currentPort = null;
  });
});

// Уведомление о том, что сервисный воркер поднят
chrome.runtime.onStartup.addListener(() => { /* окно запуска */ });
