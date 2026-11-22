import { OLLAMA_URL, DEFAULT_MODEL, PAGE_LIMIT, SELECTION_LIMIT, PROMPT_LIMIT, splitJsonLines, localModelNames, youtubeMusicIntent, tabSwitchIntent, siteOpenIntent, browserActionIntent, makeMessages, safeHistory } from './core.mjs';
import { openYouTubeMusic } from './youtube.mjs';
import { switchTabByName, switchTabById, executeBrowserTool } from './browser-tools.mjs';
import { runBrowserAgent } from './agent.mjs';

const $ = id => document.getElementById(id);
const ui = {
  main: $('main'), welcome: $('welcome'), messages: $('messages'),
  connection: $('connection'), connectionLabel: $('connection-label'), connectionModel: $('connection-model'),
  prompt: $('prompt'), form: $('chat-form'), send: $('send-button'), stop: $('stop-button'),
  page: $('page-button'), selection: $('selection-button'), agent: $('agent-button'), contextHint: $('context-hint'),
  modelSelect: $('model-select'), footerModel: $('footer-model'), settings: $('settings'),
  originCommand: $('origin-command'), toast: $('toast')
};
let history = [];
let model = DEFAULT_MODEL;
let pageEnabled = false;
let agentEnabled = false;
let pendingTabTarget = null;
let selectionContext = null;
let requestController = null;
let requestId = 0;
let preparing = false;
let toastTimer = null;

const originCommand = `[Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','chrome-extension://${chrome.runtime.id}','User')`;
ui.originCommand.textContent = originCommand;

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 5500);
}

function updateContextUI() {
  ui.page.classList.toggle('active', pageEnabled);
  ui.page.setAttribute('aria-pressed', String(pageEnabled));
  ui.selection.classList.toggle('active', Boolean(selectionContext));
  ui.contextHint.textContent = selectionContext
    ? `Выделено: ${selectionContext.text.length} симв.`
    : pageEnabled ? 'Текст страницы будет добавлен при отправке' : 'Текст страницы читается только по вашему запросу';
}

function updateBusy(busy) {
  ui.send.classList.toggle('hidden', busy);
  ui.stop.classList.toggle('hidden', !busy);
  ui.prompt.disabled = busy;
  ui.page.disabled = busy;
  ui.selection.disabled = busy;
  ui.agent.disabled = busy;
}

function scrollDown() {
  ui.main.scrollTop = ui.main.scrollHeight;
}

function inlineText(element, text) {
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) element.append(document.createTextNode(text.slice(last, match.index)));
    const value = match[0];
    if (value.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = value.slice(2, -2);
      element.append(strong);
    } else if (value.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = value.slice(1, -1);
      element.append(code);
    } else {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value);
      if (linkMatch) {
        const link = document.createElement('a');
        link.textContent = linkMatch[1];
        link.href = linkMatch[2];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        element.append(link);
      }
    }
    last = match.index + value.length;
  }
  element.append(document.createTextNode(text.slice(last)));
}

function renderAssistant(container, text) {
  container.replaceChildren();
  if (!text) return;
  const lines = text.split('\n');
  let list = null;
  let code = null;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      list = null;
      if (code) {
        container.append(code);
        code = null;
      } else {
        code = document.createElement('pre');
        code.append(document.createElement('code'));
      }
      continue;
    }
    if (code) {
      code.firstChild.textContent += `${line}\n`;
      continue;
    }
    if (!line.trim()) { list = null; continue; }
    const header = /^#{1,3}\s+(.*)/.exec(line);
    if (header) {
      list = null;
      const heading = document.createElement('h3');
      inlineText(heading, header[1]);
      container.append(heading);
      continue;
    }
    const bullet = /^\s*([-*]|\d+\.)\s+(.*)/.exec(line);
    if (bullet) {
      const tag = /^\d/.test(bullet[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement('li');
      inlineText(item, bullet[2]);
      list.append(item);
      continue;
    }
    list = null;
    const paragraph = document.createElement('p');
    inlineText(paragraph, line);
    container.append(paragraph);
  }
  if (code) container.append(code);
}

function addMessage(role, text, isError = false) {
  ui.welcome.classList.add('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}${isError ? ' error' : ''}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = isError ? 'Ошибка' : role === 'user' ? 'Вы' : 'Перо ✦';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (role === 'assistant' && !isError) renderAssistant(bubble, text);
  else bubble.textContent = text;
  wrapper.append(label, bubble);
  ui.messages.append(wrapper);
  scrollDown();
  return { wrapper, bubble };
}

function showHistory() {
  ui.messages.replaceChildren();
  ui.welcome.classList.toggle('hidden', history.length > 0);
  for (const message of history) addMessage(message.role, message.content);
}

async function saveHistory() {
  try { await chrome.storage.local.set({ history }); } catch { /* Storage can be unavailable during shutdown. */ }
}

function setConnection(ok, label) {
  ui.connection.classList.toggle('online', ok);
  ui.connection.classList.toggle('offline', !ok);
  ui.connectionLabel.textContent = label;
  ui.connectionModel.textContent = ok ? model : '';
  ui.footerModel.textContent = model || '—';
}

async function refreshModels() {
  ui.connection.classList.remove('offline', 'online');
  ui.connectionLabel.textContent = 'Проверяем Ollama…';
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const names = localModelNames(data.models);
    ui.modelSelect.replaceChildren();
    if (names.length === 0) {
      const option = new Option('Сначала скачайте локальную модель', '');
      ui.modelSelect.add(option);
      model = '';
      setConnection(false, 'Нет установленных моделей');
      return;
    }
    model = names.includes(model) ? model : (names.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : names[0]);
    for (const name of names) ui.modelSelect.add(new Option(name, name));
    ui.modelSelect.value = model;
    await chrome.storage.local.set({ model });
    setConnection(true, 'Ollama подключена');
  } catch (error) {
    ui.modelSelect.replaceChildren(new Option('Нет подключения', ''));
    const hint = String(error).includes('403') ? 'Проверьте разрешение OLLAMA_ORIGINS' : 'Ollama недоступна · откройте настройки';
    setConnection(false, hint);
  }
}

// This function is executed in the active page only after a user action.
// Do not extract forms, inputs, editable areas, hidden elements or page scripts.
function extractFromPage(kind, limit) {
  const metadata = { title: document.title, url: location.href, kind };
  if (kind === 'selection') {
    const text = String(window.getSelection()?.toString() || '').trim();
    return { ...metadata, text: text.slice(0, limit), originalLength: text.length };
  }
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) return { ...metadata, text: '', originalLength: 0 };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let length = 0;
  let inspected = 0;
  const exclude = 'script,style,noscript,svg,form,input,textarea,select,button,nav,header,footer,aside,[contenteditable],[hidden],[aria-hidden="true"]';
  while (walker.nextNode() && length < limit && inspected++ < 12000) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(exclude)) continue;
    if (parent.getClientRects().length === 0) continue;
    const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    pieces.push(value.slice(0, limit - length));
    length += value.length + 1;
  }
  const text = pieces.join(' ').slice(0, limit);
  return { ...metadata, text, originalLength: length };
}

async function getContext(kind) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) {
    throw new Error('Откройте обычную веб-страницу. Служебные вкладки браузера недоступны.');
  }
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFromPage,
      args: [kind, kind === 'selection' ? SELECTION_LIMIT : PAGE_LIMIT]
    });
  } catch {
    throw new Error('Не удалось прочитать вкладку. Обновите страницу и проверьте разрешения расширения.');
  }
  const context = result?.result;
  if (!context?.text) {
    throw new Error(kind === 'selection' ? 'Сначала выделите текст на странице, затем нажмите «Выделение».' : 'На этой странице не удалось найти доступный текст.');
  }
  return context;
}

async function streamReply(messages, target, controller, id) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: 4096, num_predict: 768 } }),
    signal: controller.signal
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.text()).slice(0, 200); } catch { /* Ignore response parsing errors. */ }
    throw new Error(`Ollama вернула HTTP ${response.status}. ${detail}`);
  }
  if (!response.body) throw new Error('Ollama не вернула поток ответа.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let answer = '';
  let lastPaint = 0;
  let finished = false;
  const accept = events => {
    for (const event of events) {
      if (event.error) throw new Error(String(event.error));
      if (event.message?.content) answer += event.message.content;
      if (event.done) finished = true;
    }
    if (id === requestId && (Date.now() - lastPaint > 70 || finished)) {
      renderAssistant(target.bubble, answer);
      scrollDown();
      lastPaint = Date.now();
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (id !== requestId) { await reader.cancel(); return ''; }
      if (done) break;
      const parsed = splitJsonLines(pending, decoder.decode(value, { stream: true }));
      pending = parsed.rest;
      accept(parsed.events);
    }
    accept(splitJsonLines(pending, decoder.decode(), true).events);
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  }
  renderAssistant(target.bubble, answer || 'Ответ остановлен.');
  scrollDown();
  return answer;
}

async function runYouTubeRequest(prompt, intent) {
  const controller = new AbortController();
  requestController = controller;
  const id = ++requestId;
  updateBusy(true);
  history.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  ui.prompt.value = '';
  ui.prompt.style.height = '';
  const reply = addMessage('assistant', 'Открываю YouTube…');
  reply.bubble.classList.add('typing');
  await saveHistory();
  if (id !== requestId) return;
  try {
    const result = await openYouTubeMusic(intent, chrome, controller.signal, text => {
      if (id === requestId) renderAssistant(reply.bubble, text);
    });
    if (id !== requestId) return;
    let answer;
    if (result.status === 'playing') {
      answer = result.ad
        ? `Открыл «${result.title}». Сейчас на YouTube идёт реклама — после неё должно начаться видео. Проверьте вкладку.`
        : result.muted
          ? `Открыл «${result.title}». Видео воспроизводится без звука — включите звук в открытой вкладке.`
          : `Открыл «${result.title}» на YouTube. Видеоплеер воспроизводит запись.`;
    } else if (result.status === 'opened') {
      answer = `Открыл «${result.title}» на YouTube, но браузер не подтвердил воспроизведение. Нажмите ▶ в открытой вкладке.`;
    } else {
      answer = intent.play
        ? `Открыл результаты поиска «${intent.query}» на YouTube. Не удалось надёжно выбрать и запустить видео — выберите его в открытой вкладке.`
        : `Открыл результаты поиска «${intent.query}» на YouTube.`;
    }
    renderAssistant(reply.bubble, answer);
    history.push({ role: 'assistant', content: answer });
    await saveHistory();
  } catch (error) {
    if (id !== requestId) return;
    const answer = error.name === 'AbortError'
      ? 'Остановлено. Уже открытая вкладка останется доступной.'
      : `Не удалось выполнить действие в YouTube: ${String(error.message || error).slice(0, 180)}. Проверьте доступность сайта.`;
    renderAssistant(reply.bubble, answer);
    history.push({ role: 'assistant', content: answer });
    await saveHistory();
  } finally {
    if (id === requestId) {
      reply.bubble.classList.remove('typing');
      requestController = null;
      updateBusy(false);
      ui.prompt.focus();
      scrollDown();
    }
  }
}

function askApproval({ title, detail, site }, signal) {
  return new Promise(resolve => {
    const box = $('approval');
    const yes = $('approval-yes');
    const no = $('approval-no');
    $('approval-title').textContent = String(title).slice(0, 180);
    $('approval-detail').textContent = String(detail).slice(0, 1000);
    $('approval-site').textContent = `Сайт: ${String(site).slice(0, 180)}`;
    box.classList.remove('hidden');
    const finish = value => {
      box.classList.add('hidden');
      yes.removeEventListener('click', accept);
      no.removeEventListener('click', decline);
      signal.removeEventListener('abort', decline);
      document.removeEventListener('keydown', escape);
      resolve(value && !signal.aborted);
    };
    const accept = () => finish(true);
    const decline = () => finish(false);
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); decline(); } };
    yes.addEventListener('click', accept);
    no.addEventListener('click', decline);
    signal.addEventListener('abort', decline, { once: true });
    document.addEventListener('keydown', escape);
    if (signal.aborted) decline(); else no.focus();
  });
}

function showTabChoices(reply, matches, request) {
  const choices = document.createElement('div');
  choices.className = 'tab-choices';
  for (const [index, tab] of matches.entries()) {
    const button = document.createElement('button');
    let host = '';
    try { host = new URL(tab.url).hostname; } catch { host = tab.url; }
    button.type = 'button';
    button.textContent = `${index + 1}. ${tab.title} · ${host} · окно ${tab.windowId}, вкладка ${tab.id}`;
    button.addEventListener('click', async () => {
      if (request !== requestId || requestController) return;
      choices.querySelectorAll('button').forEach(item => { item.disabled = true; });
      const controller = new AbortController();
      requestController = controller;
      updateBusy(true);
      try {
        const result = await switchTabById(chrome, tab);
        if (request !== requestId) return;
        const answer = result.message;
        renderAssistant(reply.bubble, answer);
        if (result.ok) pendingTabTarget = null;
        history[history.length - 1] = { role: 'assistant', content: answer };
        await saveHistory();
      } catch (error) {
        if (request === requestId) renderAssistant(reply.bubble, `Не удалось переключиться: ${String(error.message || error).slice(0, 180)}`);
      } finally {
        if (request === requestId) { requestController = null; updateBusy(false); }
      }
    });
    choices.append(button);
  }
  reply.bubble.append(choices);
  scrollDown();
}

async function runBrowserRequest(prompt, tabTarget = null, siteTarget = null) {
  const controller = new AbortController();
  requestController = controller;
  const id = ++requestId;
  history.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  ui.prompt.value = '';
  ui.prompt.style.height = '';
  const reply = addMessage('assistant', tabTarget ? 'Ищу вкладку…' : siteTarget ? 'Проверяю адрес…' : 'Начинаю действия…');
  reply.bubble.classList.add('typing');
  updateBusy(true);
  await saveHistory();
  let matches = null;
  try {
    let answer;
    if (tabTarget) {
      const result = await switchTabByName(chrome, tabTarget);
      answer = result.message;
      matches = result.matches;
      pendingTabTarget = matches ? tabTarget : null;
    } else if (siteTarget) {
      const result = await executeBrowserTool(chrome, siteTarget.url ? 'open_url' : 'search_web', siteTarget.url ? { url: siteTarget.url } : { query: siteTarget.query }, item => askApproval(item, controller.signal), controller.signal);
      answer = result.denied ? 'Открытие отменено. Никаких сайтов не открывал.' : result.message;
    } else {
      const result = await runBrowserAgent({ prompt, model, signal: controller.signal, approve: item => askApproval(item, controller.signal), onProgress: text => {
        if (id === requestId && !controller.signal.aborted) { renderAssistant(reply.bubble, text); scrollDown(); }
      } });
      answer = result.answer;
      if (result.actions.length) answer += `\n\nПроверенные шаги: ${result.actions.map(step => `${step.name}: ${String(step.result).slice(0, 100)}`).join('; ').slice(0, 700)}`;
    }
    if (id !== requestId) return;
    if (controller.signal.aborted) answer = 'Остановлено. Уже выполненные действия в браузере не отменены.';
    renderAssistant(reply.bubble, answer);
    history.push({ role: 'assistant', content: answer });
    await saveHistory();
  } catch (error) {
    if (id !== requestId) return;
    const answer = error.name === 'AbortError' ? 'Остановлено. Уже выполненные действия в браузере не отменены.' :
      `Не удалось выполнить действие: ${String(error.message || error).slice(0, 220)}`;
    renderAssistant(reply.bubble, answer);
    history.push({ role: 'assistant', content: answer });
    await saveHistory();
  } finally {
    if (id === requestId) {
      reply.bubble.classList.remove('typing');
      requestController = null;
      updateBusy(false);
      if (matches) showTabChoices(reply, matches, id);
      ui.prompt.focus();
    }
  }
}

async function sendQuestion(question) {
  const prompt = question.trim().slice(0, PROMPT_LIMIT);
  if (!prompt || requestController || preparing) return;
  const tabTarget = tabSwitchIntent(prompt) || (pendingTabTarget && prompt.toLocaleLowerCase('ru') === pendingTabTarget.toLocaleLowerCase('ru') ? pendingTabTarget : null);
  if (tabTarget) return runBrowserRequest(prompt, tabTarget);
  const siteTarget = siteOpenIntent(prompt);
  if (siteTarget) return runBrowserRequest(prompt, null, siteTarget);
  const youtube = youtubeMusicIntent(prompt);
  if (youtube) return runYouTubeRequest(prompt, youtube);
  if (/^MAX$/iu.test(prompt)) { toast('Уточните: «зайди на вкладку MAX» или «открой сайт MAX».'); return; }
  if (!model) { toast('Сначала подключите Ollama и скачайте модель.'); openSettings(); return; }
  if (agentEnabled || browserActionIntent(prompt)) return runBrowserRequest(prompt);
  preparing = true;
  const preparationId = requestId;
  let context = selectionContext;
  if (pageEnabled) {
    try { context = await getContext('page'); }
    catch (error) { toast(error.message); preparing = false; return; }
  }
  preparing = false;
  if (preparationId !== requestId) return;
  const messages = makeMessages(history, prompt, context);
  history.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  await saveHistory();
  ui.prompt.value = '';
  ui.prompt.style.height = '';
  selectionContext = null;
  updateContextUI();
  const controller = new AbortController();
  requestController = controller;
  const id = ++requestId;
  updateBusy(true);
  const reply = addMessage('assistant', '');
  reply.bubble.classList.add('typing');
  let answer = '';
  try {
    answer = await streamReply(messages, reply, controller, id);
  } catch (error) {
    if (id !== requestId) return;
    if (error.name === 'AbortError') {
      if (!reply.bubble.textContent) reply.bubble.textContent = 'Ответ остановлен.';
    } else {
      reply.wrapper.remove();
      const text = error instanceof TypeError
        ? 'Не удалось связаться с Ollama. Проверьте настройки и разрешение OLLAMA_ORIGINS.'
        : error.message;
      addMessage('assistant', text, true);
      setConnection(false, 'Ошибка подключения · откройте настройки');
    }
  } finally {
    if (id === requestId) {
      reply.bubble.classList.remove('typing');
      if (answer) { history.push({ role: 'assistant', content: answer }); await saveHistory(); }
      requestController = null;
      updateBusy(false);
      ui.prompt.focus();
    }
  }
}

function openSettings() {
  ui.settings.classList.remove('hidden');
  ui.settings.setAttribute('aria-hidden', 'false');
  $('close-settings').focus();
}
function closeSettings() {
  ui.settings.classList.add('hidden');
  ui.settings.setAttribute('aria-hidden', 'true');
  $('settings-button').focus();
}

ui.form.addEventListener('submit', event => {
  event.preventDefault();
  sendQuestion(ui.prompt.value);
});
ui.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});
ui.prompt.addEventListener('input', () => {
  ui.prompt.style.height = 'auto';
  ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 116)}px`;
});
ui.agent.addEventListener('click', () => {
  agentEnabled = !agentEnabled;
  ui.agent.classList.toggle('active', agentEnabled);
  ui.agent.setAttribute('aria-pressed', String(agentEnabled));
  toast(agentEnabled ? 'Режим действий включён. Открытие сайта, клики и ввод требуют отдельного подтверждения.' : 'Режим действий выключен.');
});
ui.page.addEventListener('click', () => {
  pageEnabled = !pageEnabled;
  if (pageEnabled) selectionContext = null;
  updateContextUI();
});
ui.selection.addEventListener('click', async () => {
  if (selectionContext) { selectionContext = null; updateContextUI(); return; }
  try {
    selectionContext = await getContext('selection');
    pageEnabled = false;
    updateContextUI();
    ui.prompt.focus();
  } catch (error) { toast(error.message); }
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  const action = button.dataset.action;
  if (action === 'music') {
    sendQuestion('Открой YouTube, найди музыку 2000-х и включи её.');
    return;
  }
  if (action === 'explain') {
    try { selectionContext = await getContext('selection'); pageEnabled = false; updateContextUI(); }
    catch (error) { toast(error.message); return; }
    sendQuestion('Объясни выделенный текст простыми словами.');
  } else {
    pageEnabled = true;
    selectionContext = null;
    updateContextUI();
    sendQuestion(action === 'summary' ? 'Кратко перескажи эту страницу и выдели главное.' : 'Переведи основное содержание этой страницы на русский язык.');
  }
}));
$('new-chat').addEventListener('click', async () => {
  requestId++;
  requestController?.abort();
  requestController = null;
  updateBusy(false);
  history = [];
  pendingTabTarget = null;
  selectionContext = null;
  pageEnabled = false;
  ui.prompt.value = '';
  ui.messages.replaceChildren();
  ui.welcome.classList.remove('hidden');
  updateContextUI();
  await saveHistory();
  ui.prompt.focus();
});
ui.stop.addEventListener('click', () => requestController?.abort());
$('settings-button').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ui.settings.classList.contains('hidden')) closeSettings();
});
$('refresh-models').addEventListener('click', refreshModels);
ui.modelSelect.addEventListener('change', async () => {
  model = ui.modelSelect.value;
  await chrome.storage.local.set({ model });
  setConnection(Boolean(model), model ? 'Ollama подключена' : 'Нет модели');
});
$('copy-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(originCommand); toast('Команда скопирована. Запустите её в PowerShell.'); }
  catch { toast('Не получилось скопировать. Выделите команду вручную.'); }
});

async function start() {
  try {
    const stored = await chrome.storage.local.get(['history', 'model']);
    history = safeHistory(stored.history);
    if (typeof stored.model === 'string' && stored.model) model = stored.model;
  } catch { /* First launch or storage unavailable. */ }
  showHistory();
  updateContextUI();
  await refreshModels();
}
start();
