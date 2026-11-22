// Aura — popup UI. Чистый DOM + chrome.* API.

const $ = (id) => document.getElementById(id);

// ---------- Порт ----------
let port = null;
let runActive = false;

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((msg) => onAgentEvent(msg));
    port.onDisconnect.addListener(() => { port = null; });
  } catch (ex) {
    port = null;
  }
}

function send(msg) {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (resp) => resolve(resp)); }
    catch { resolve(null); }
  });
}

// ---------- Статус ----------
async function refreshStatus() {
  const resp = await send({ type: 'status:get' });
  if (!resp) { setStatus('warn', 'нет связи'); return; }
  const { ollama } = resp;
  if (ollama?.ok) {
    const models = (ollama.models || []).slice(0, 3).join(', ');
    setStatus('ok', `Ollama · ${models || 'модель не найдена'}`);
  } else {
    setStatus('err', 'Ollama недоступна');
  }
}

function setStatus(state, text) {
  const dot = $('status-dot');
  dot.classList.remove('ok', 'warn', 'err');
  if (state === 'ok') dot.classList.add('ok');
  else if (state === 'warn') dot.classList.add('warn');
  else dot.classList.add('err');
  $('status-text').textContent = text || '';
}

// ---------- Чат ----------
function addMsg(role, text) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  persistMessage(role, text);
}

function addActivity(label, detail) {
  const log = $('activity-log');
  const div = document.createElement('div');
  div.className = 'activity-item';
  const lbl = document.createElement('span');
  lbl.className = 'act-label';
  lbl.textContent = `⚡ ${label}`;
  div.appendChild(lbl);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'act-detail';
    d.textContent = detail;
    div.appendChild(d);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function clearActivity() {
  $('activity-log').innerHTML = '';
}

async function loadChat() {
  const resp = await send({ type: 'chat:get' });
  const list = resp?.chat || [];
  const log = $('chat-log');
  log.innerHTML = '';
  for (const m of list) {
    if (m.role === 'user') addMsgSilent('user', m.text);
    else if (m.role === 'assistant') addMsgSilent('assistant', m.text);
  }
  log.scrollTop = log.scrollHeight;
}

function addMsgSilent(role, text) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
}

function persistMessage(role, text) {
  // сохранится второй раз — фоновый процесс тоже сохраняет assistant; это нетрасстановочное
}

// ---------- События агента ----------
function onAgentEvent(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'status':
      setBusy(msg.state === 'running');
      break;
    case 'step':
      addActivity(msg.label || 'шаг', msg.detail);
      break;
    case 'answer':
      addMsg('assistant', msg.text || '');
      setBusy(false);
      break;
    case 'fill-result':
      if (msg.filled > 0) {
        addActivity('Форма заполнена', `Заполнено ${msg.filled} полей`);
      } else {
        addActivity('Форма не заполнена', msg.reason || '');
      }
      break;
    case 'error':
      addMsg('error', msg.message || 'Ошибка');
      setBusy(false);
      break;
    case 'done':
      setBusy(false);
      break;
  }
}

function setBusy(busy) {
  runActive = busy;
  $('input').disabled = busy;
  $('btn-send').disabled = busy;
  $('btn-abort').style.display = busy ? 'inline-block' : 'none';
  $('btn-send').style.display = busy ? 'none' : 'inline-block';
  if (busy) clearActivity();
  if (!busy) {
    // не чистим activity полностью — пользователь видит шаги
  }
}

// ---------- Отправка ----------
function sendGoal(text) {
  if (!text.trim()) return;
  clearActivity();
  addMsg('user', text.trim());
  $('input').value = '';
  autoResize();
  setBusy(true);
  if (port) {
    try { port.postMessage({ type: 'chat:send', message: text }); }
    catch { setBusy(false); addMsg('error', 'Нет связи с фоном. Закройте и откройте попап.'); }
  } else {
    // если порт не успел установиться — попробуем еще раз через sendMessage? Нет порта → ошибка
    setBusy(false);
    addMsg('error', 'Порт не установился. Попробуйте ещё раз.');
  }
}

// ---------- Таймер активности ----------
let activityTimer = null;
function noteActivity(label) { /* placeholder */ }

// ---------- Светлая/тёмная тема ----------
// (только тёмная по дизайну)

// ---------- Вкладки ----------
async function doTabSearch() {
  const query = $('tab-search').value.trim();
  if (!query) return;
  $('btn-tab-search').disabled = true;
  $('btn-tab-search').textContent = 'Ищу…';
  const resp = await send({ type: 'find-in-tabs', query });
  $('btn-tab-search').disabled = false;
  $('btn-tab-search').textContent = 'Найти';
  renderTabResults(resp?.results || [], query);
}

function renderTabResults(results, query) {
  const wrap = $('tab-results');
  wrap.innerHTML = '';
  if (!results.length) {
    wrap.innerHTML = `<div class="tab-empty">Ничего не найдено по запросу «${escapeHtml(query)}»</div>`;
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'tab-result';
    const title = document.createElement('div');
    title.className = 't-title';
    title.innerHTML = `<a href="${escapeAttr(r.url)}" target="_blank">${escapeHtml(r.title || '(без названия)')}</a>`;
    const url = document.createElement('div');
    url.className = 't-url';
    url.textContent = r.url || '';
    const snippet = document.createElement('div');
    snippet.className = 't-snippet';
    snippet.textContent = r.snippet || '';
    div.appendChild(title); div.appendChild(url); div.appendChild(snippet);
    wrap.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- Настройки ----------
async function loadSettings() {
  const resp = await send({ type: 'settings:get' });
  const s = resp?.settings || {};
  $('set-url').value = s.ollamaUrl || 'http://127.0.0.1:11434';
  $('set-model').value = s.model || 'qwen2.5:3b';
  $('set-engine').value = s.engine || 'yandex';
  $('set-autofill').checked = s.autoFill !== false;
}

async function loadProfile() {
  const resp = await send({ type: 'profile:get' });
  const p = resp?.profile || {};
  $('p-name').value = p.name || '';
  $('p-first').value = p.first_name || '';
  $('p-last').value = p.last_name || '';
  $('p-phone').value = p.phone || '';
  $('p-email').value = p.email || '';
  $('p-city').value = p.city || '';
  $('p-age').value = p.age || '';
  $('p-address').value = p.address || '';
  $('p-birth').value = p.birthdate || '';
  $('p-website').value = p.website || '';
  $('p-occupation').value = p.occupation || '';
  $('p-about').value = p.about || '';
}

async function saveSettings() {
  const settings = {
    ollamaUrl: $('set-url').value.trim() || 'http://127.0.0.1:11434',
    model: $('set-model').value.trim() || 'qwen2.5:3b',
    engine: $('set-engine').value,
    autoFill: $('set-autofill').checked,
  };
  const resp = await send({ type: 'settings:set', settings });
  $('check-result').textContent = resp?.ok ? 'Настройки сохранены ✓' : 'Не удалось сохранить';
  refreshStatus();
}

async function saveProfile() {
  const profile = {
    name: $('p-name').value.trim(),
    first_name: $('p-first').value.trim(),
    last_name: $('p-last').value.trim(),
    phone: $('p-phone').value.trim(),
    email: $('p-email').value.trim(),
    city: $('p-city').value.trim(),
    age: $('p-age').value.trim(),
    address: $('p-address').value.trim(),
    birthdate: $('p-birth').value.trim(),
    website: $('p-website').value.trim(),
    occupation: $('p-occupation').value.trim(),
    about: $('p-about').value.trim(),
  };
  const resp = await send({ type: 'profile:set', profile });
  $('check-result').textContent = resp?.ok ? 'Профиль сохранён ✓' : 'Не удалось сохранить';
}

async function checkOllamaNow() {
  const url = $('set-url').value.trim() || 'http://127.0.0.1:11434';
  const btn = $('btn-check');
  btn.disabled = true; btn.textContent = 'Проверяю…';
  const model = $('set-model').value.trim() || 'qwen2.5:3b';
  const resp = await send({ type: 'status:get', settings: { ollamaUrl: url, model } });
  btn.disabled = false; btn.textContent = 'Проверить';
  const out = $('check-result');
  if (resp?.ollama?.ok) {
    out.textContent = `✓ Ollama работает. Модели: ${(resp.ollama.models || []).join(', ') || 'нет'}`;
    out.className = 'check-result ok';
  } else {
    out.textContent = `✕ Ollama недоступна: ${resp?.ollama?.error || 'нет ответа'}`;
    out.className = 'check-result err';
  }
  refreshStatus();
}

// ---------- Раскладка view'ов ----------
function showView(name) {
  document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('view-chat').classList.toggle('hidden', name !== 'chat');
  $('view-tabs').classList.toggle('hidden', name !== 'tabs');
  $('view-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'settings') { loadSettings(); loadProfile(); }
}

// ---------- События ----------
function init() {
  connect();
  setTimeout(() => { if (!port) connect(); }, 300);
  loadChat();
  refreshStatus();

  // view tabs
  document.querySelectorAll('.view-tab').forEach((t) => {
    t.addEventListener('click', () => showView(t.dataset.view));
  });
  $('btn-settings').addEventListener('click', () => showView('settings'));

  // send
  const input = $('input');
  const sendBtn = $('btn-send');
  const abortBtn = $('btn-abort');

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
  }
  input.addEventListener('input', autoResize);
  autoResize();

  function doSend() {
    if (runActive) return;
    const t = input.value;
    if (!t.trim()) return;
    sendGoal(t);
  }
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  abortBtn.addEventListener('click', () => {
    if (port) try { port.postMessage({ type: 'abort' }); } catch {}
    setBusy(false);
  });

  // chips
  document.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      if (runActive) return;
      input.value = c.dataset.q || '';
      autoResize();
      doSend();
    });
  });

  // tabs view
  $('btn-tab-search').addEventListener('click', doTabSearch);
  $('tab-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doTabSearch(); });
  $('btn-tab-new').addEventListener('click', async () => {
    const url = $('tab-url').value.trim();
    if (!url) return;
    const resp = await send({ type: 'tab:new', url });
    if (resp?.ok) $('tab-url').value = '';
    else alert(resp?.reason || 'Не удалось открыть');
  });
  $('btn-tab-close').addEventListener('click', async () => {
    if (confirm('Закрыть текущую вкладку?')) {
      await send({ type: 'tab:close' });
    }
  });

  // settings view
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-save-profile').addEventListener('click', saveProfile);
  $('btn-check').addEventListener('click', checkOllamaNow);
}

document.addEventListener('DOMContentLoaded', init);
