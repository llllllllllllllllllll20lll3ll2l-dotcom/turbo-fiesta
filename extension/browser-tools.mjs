const PUBLIC_URL = /^https:\/\//i;
const privateHost = host => host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' || host === '[::1]' || /^\[/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);

export function rankTab(tab, target) {
  const q = String(target || '').trim().toLocaleLowerCase('ru');
  const title = String(tab.title || '').toLocaleLowerCase('ru');
  if (!q || !title) return 0;
  if (title === q) return 100;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(title)) return 80;
  if (title.includes(q)) return 50;
  try { if (new URL(tab.url).hostname.toLocaleLowerCase('ru').includes(q)) return 30; } catch { /* Not a web tab. */ }
  return 0;
}

export async function listTabs(api) {
  const tabs = await api.tabs.query({});
  return tabs.filter(tab => !tab.incognito && tab.id && tab.windowId)
    .map(tab => ({ id: tab.id, windowId: tab.windowId, title: String(tab.title || 'Без названия').slice(0, 110), url: String(tab.url || '').slice(0, 240), active: Boolean(tab.active), pinned: Boolean(tab.pinned) }));
}

export async function switchTabById(api, requested) {
  const tab = (await listTabs(api)).find(item => item.id === requested.id && item.windowId === requested.windowId);
  if (!tab || tab.title !== requested.title || tab.url !== requested.url) {
    return { ok: false, message: 'Вкладка изменилась или закрыта. Запросите список вкладок снова.' };
  }
  await api.tabs.update(tab.id, { active: true });
  await api.windows.update(tab.windowId, { focused: true });
  const [active] = await api.tabs.query({ active: true, windowId: tab.windowId });
  const window = await api.windows.get(tab.windowId);
  if (active?.id !== tab.id || !window?.focused) {
    return { ok: false, message: `Не удалось подтвердить переключение на «${tab.title}». Проверьте вкладки браузера.`, tab };
  }
  return { ok: true, message: `Переключился на вкладку «${tab.title}» (окно ${tab.windowId}).`, tab };
}

export async function switchTabByName(api, target) {
  const tabs = await listTabs(api);
  const matches = tabs.map(tab => ({ ...tab, score: rankTab(tab, target) })).filter(tab => tab.score > 0).sort((a, b) => b.score - a.score);
  if (!matches.length) return { ok: false, message: `Открытая вкладка «${String(target).slice(0, 65)}» не найдена.` };
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    return { ok: false, message: `Найдено несколько вкладок «${String(target).slice(0, 65)}». Выберите нужную ниже.`, matches: matches.filter(item => item.score === matches[0].score).slice(0, 8) };
  }
  return switchTabById(api, matches[0]);
}

export async function closeTabById(api, requested, approve, signal) {
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const tab = (await listTabs(api)).find(item => item.id === requested.id && item.windowId === requested.windowId);
  if (!tab || tab.title !== requested.title || tab.url !== requested.url) {
    return { ok: false, message: 'Вкладка изменилась или уже закрыта. Повторите запрос.' };
  }
  if (tab.pinned) return { ok: false, message: 'Закреплённую вкладку агент не закрывает. Сначала открепите её вручную.' };
  const detail = `${tab.title}\n${tab.url || 'Служебная вкладка'}\nОкно ${tab.windowId}, вкладка ${tab.id}. Несохранённые данные могут быть потеряны.`;
  if (!await approve?.({ title: 'Закрыть вкладку?', detail, site: 'Браузер' })) return { denied: true, message: 'Закрытие отменено.' };
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const current = (await listTabs(api)).find(item => item.id === tab.id && item.windowId === tab.windowId);
  if (!current || current.title !== tab.title || current.url !== tab.url || current.pinned) {
    return { ok: false, message: 'Вкладка изменилась после подтверждения. Закрытие отменено.' };
  }
  await api.tabs.remove(tab.id);
  if ((await listTabs(api)).some(item => item.id === tab.id)) {
    return { ok: false, message: `Браузер не подтвердил закрытие вкладки «${tab.title}».` };
  }
  return { ok: true, message: `Закрыл вкладку «${tab.title}» (окно ${tab.windowId}).` };
}

export async function closeTabByName(api, query, approve, signal) {
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const tabs = await listTabs(api);
  const matches = tabs.map(tab => ({ ...tab, score: rankTab(tab, query) })).filter(tab => tab.score > 0).sort((a, b) => b.score - a.score);
  if (!matches.length) return { ok: false, message: `Открытая вкладка «${String(query).slice(0, 65)}» не найдена.` };
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    return { ok: false, message: `Найдено несколько вкладок «${String(query).slice(0, 65)}». Выберите, какую закрыть.`, matches: matches.filter(item => item.score === matches[0].score).slice(0, 8) };
  }
  return closeTabById(api, matches[0], approve, signal);
}

export async function closeTabsByName(api, query, approve, signal) {
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const tabs = (await listTabs(api)).map(tab => ({ ...tab, score: rankTab(tab, query) })).filter(tab => tab.score > 0);
  const best = Math.max(0, ...tabs.map(tab => tab.score));
  const matches = tabs.filter(tab => tab.score === best);
  if (!matches.length) return { ok: false, message: `Вкладки «${String(query).slice(0, 65)}» не найдены.` };
  if (matches.length > 8) return { ok: false, message: `Найдено ${matches.length} вкладок. Для безопасности ограничение — 8 за запрос.` };
  if (matches.some(tab => tab.pinned)) return { ok: false, message: 'Среди найденных есть закреплённые вкладки. Сначала открепите их вручную.' };
  const detail = matches.map(tab => `${tab.title} — ${tab.url || 'Служебная вкладка'} (окно ${tab.windowId}, №${tab.id})`).join('\n').slice(0, 1100);
  if (!await approve?.({ title: `Закрыть вкладки (${matches.length})?`, detail: `${detail}\nНесохранённые данные могут быть потеряны.`, site: 'Браузер' })) return { denied: true, message: 'Закрытие отменено.' };
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const latest = await listTabs(api);
  if (matches.some(tab => !latest.some(item => item.id === tab.id && item.windowId === tab.windowId && item.title === tab.title && item.url === tab.url && !item.pinned))) {
    return { ok: false, message: 'Одна из вкладок изменилась после подтверждения. Закрытие отменено.' };
  }
  await api.tabs.remove(matches.map(tab => tab.id));
  const remaining = await listTabs(api);
  const notClosed = matches.filter(tab => remaining.some(item => item.id === tab.id));
  return notClosed.length ? { ok: false, message: `Браузер не подтвердил закрытие ${notClosed.length} вкладок.` } :
    { ok: true, message: `Закрыл ${matches.length} вкладок по запросу «${String(query).slice(0, 65)}».` };
}

export async function closeCurrentTab(api, approve, signal) {
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (!active?.id || active.incognito) return { ok: false, message: 'Не удалось определить текущую обычную вкладку.' };
  const tab = (await listTabs(api)).find(item => item.id === active.id && item.windowId === active.windowId);
  if (!tab) return { ok: false, message: 'Текущая вкладка недоступна.' };
  return closeTabById(api, tab, approve, signal);
}

export function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!PUBLIC_URL.test(url.href) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (privateHost(host) || !host.includes('.')) return null;
    if (url.href.length > 500) return null;
    return url.href;
  } catch { return null; }
}

async function activeWebTab(api) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.incognito || !/^https?:\/\//i.test(tab.url || '')) throw new Error('Откройте обычную веб-страницу (не приватное окно) для управления ею.');
  return tab;
}

async function sendToPage(api, action, data = {}, expectedTab = null) {
  const tab = await activeWebTab(api);
  if (expectedTab && (tab.id !== expectedTab.id || tab.url !== expectedTab.url)) throw new Error('Вкладка сменилась после подтверждения. Действие отменено.');
  const message = { source: 'pero-panel', action, ...data };
  try {
    const result = await api.tabs.sendMessage(tab.id, message);
    if (result?.ok) return result.result;
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message || '')) throw error;
  }
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  const result = await api.tabs.sendMessage(tab.id, message);
  if (!result?.ok) throw new Error(result?.error || 'Нет доступа к странице. Обновите вкладку и повторите.');
  return result.result;
}

export async function executeBrowserTool(api, name, args, approve, signal) {
  const ensureActive = () => { if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError'); };
  ensureActive();
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'list_tabs') return (await listTabs(api)).map(({ title, url, active }) => ({ title, url, active })).slice(0, 25);
  if (name === 'switch_tab') {
    const result = await switchTabByName(api, String(input.query || '').slice(0, 65));
    return { ok: result.ok, message: result.message };
  }
  if (name === 'close_tabs') {
    const query = String(input.query || '').trim().slice(0, 65);
    if (!query) return { ok: false, message: 'Укажите название вкладок, которые надо закрыть.' };
    return closeTabsByName(api, query, approve, signal);
  }
  if (name === 'close_tab') {
    const query = String(input.query || '').trim().slice(0, 65);
    const result = input.current === true ? await closeCurrentTab(api, approve, signal) :
      query ? await closeTabByName(api, query, approve, signal) : { ok: false, message: 'Укажите название вкладки или current: true.' };
    return { ok: result.ok, denied: result.denied, message: result.message, matches: result.matches?.map(({ title, url, id, windowId }) => ({ title, url, id, windowId })) };
  }
  if (name === 'read_page') {
    const page = await sendToPage(api, 'SNAPSHOT');
    return { title: page.title, url: page.url, text: page.text.slice(0, 1800), elements: page.elements.slice(0, 30) };
  }
  if (name === 'scroll') {
    const direction = input.direction === 'up' ? 'up' : 'down';
    await sendToPage(api, 'SCROLL', { direction });
    return { ok: true, message: `Прокрутил страницу ${direction === 'up' ? 'вверх' : 'вниз'}. Прочитайте страницу снова.` };
  }
  if (name === 'open_url' || name === 'search_web') {
    const url = name === 'open_url'
      ? safeWebUrl(input.url)
      : `https://yandex.ru/search/?text=${encodeURIComponent(String(input.query || '').slice(0, 120))}`;
    if (!url) throw new Error('Небезопасный или некорректный адрес. Для открытия разрешены только публичные HTTPS-сайты.');
    if (!await approve?.({ title: 'Открыть страницу?', detail: url, site: new URL(url).hostname })) return { denied: true, message: 'Пользователь отменил открытие сайта.' };
    ensureActive();
    const created = await api.tabs.create({ url, active: true });
    if (!created?.id || !created.windowId) throw new Error('Браузер не подтвердил создание вкладки. Проверьте вкладки вручную.');
    await api.windows.update(created.windowId, { focused: true });
    const [active] = await api.tabs.query({ active: true, windowId: created.windowId });
    const window = await api.windows.get(created.windowId);
    if (active?.id !== created.id || !window?.focused) {
      return { ok: false, message: `Вкладка с адресом ${url} создана, но её отображение не подтверждено. Проверьте окно браузера.` };
    }
    return { ok: true, message: `Создал активную вкладку с адресом ${url}. Дождитесь загрузки сайта; содержимое страницы пока не проверено.` };
  }
  if (name === 'click' || name === 'type') {
    const ref = String(input.ref || '').slice(0, 20);
    if (!/^[a-f0-9]{8}:\d+:\d+$/.test(ref)) throw new Error('Сначала вызовите read_page и используйте полученный ref.');
    const tab = await activeWebTab(api);
    const info = await sendToPage(api, 'INSPECT', { ref }, tab);
    const text = String(input.text || '').slice(0, 800);
    const title = name === 'click' ? `Нажать «${info.label}»?` : `Ввести текст в «${info.label}»?`;
    const detail = name === 'click'
      ? [info.href ? `Ссылка: ${info.href}` : 'Нажатие кнопки на странице.', info.draft ? `Черновик формы: ${info.draft}` : ''].filter(Boolean).join('\n')
      : `Будет введено: ${text}`;
    if (!await approve?.({ title, detail, site: new URL(tab.url).hostname })) return { denied: true, message: 'Пользователь отклонил действие.' };
    ensureActive();
    if (name === 'click') {
      await sendToPage(api, 'CLICK', { ref, expected: { label: info.label, href: info.href, draft: info.draft } }, tab);
      await new Promise(resolve => setTimeout(resolve, 650));
      return { ok: true, message: 'Нажатие запланировано. Прочитайте страницу, чтобы проверить результат.' };
    }
    if (!text) throw new Error('Пустой текст не вводится.');
    await sendToPage(api, 'TYPE', { ref, text, expected: { label: info.label, text } }, tab);
    return { ok: true, message: 'Текст введён. Дальнейший клик по кнопке отправки — отдельное действие (согласно настройке подтверждений).' };
  }
  throw new Error('Недоступная команда браузера.');
}
