// Aura — парсер действий агента и сборщик промптов.
// Чистая логика без DOM/chrome-API — тестируется в node.

export const ACTIONS = [
  'read_page',
  'search_web',
  'open_tab',
  'close_tab',
  'fill_form',
  'answer',
  'done',
];

/**
 * Извлекает действие из ответа модели.
 * Модель может вернуть: голый JSON, JSON в ```json ``` или текст вокруг JSON.
 * Возвращает { action, params, raw } или null — если не смог понять.
 */
export function parseAction(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  // 1) голый JSON
  const tryParse = (candidate) => {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && typeof obj.action === 'string') {
        const action = obj.action.trim().toLowerCase();
        if (ACTIONS.includes(action)) {
          return { action, params: obj.params ?? {}, raw: text };
        }
      }
    } catch { /* ignore */ }
    return null;
  };

  const direct = tryParse(text);
  if (direct) return direct;

  // 2) из кодблока или текста — ищем все сбалансированные {...} блоки
  let best = null;
  const stack = [];
  let startIdx = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (stack.length === 0) startIdx = i;
      stack.push(ch);
    } else if (ch === '}') {
      stack.pop();
      if (stack.length === 0 && startIdx >= 0) {
        const candidate = text.slice(startIdx, i + 1);
        const parsed = tryParse(candidate);
        if (parsed) best = parsed; // не уходим молча — берём последний удачный
        startIdx = -1;
      }
    }
  }
  return best;
}

/**
 * Собирает URL поиска. YANDEX / GOOGLE.
 */
export function buildSearchUrl(engine, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const encoded = encodeURIComponent(q);
  if (engine === 'yandex') return `https://yandex.ru/search/?text=${encoded}`;
  if (engine === 'google') return `https://www.google.com/search?q=${encoded}`;
  return `https://yandex.ru/search/?text=${encoded}`;
}

/**
 * Проверяет, что URL разрешён для открытия расширением (http/https/ftp).
 */
export function isAllowedUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Промпт агента. Модель должна отвечать РОВНО ОДНОЙ строкой JSON.
 */
export function buildPrompt({ goal, page, lastResult, engine, profileName }) {
  const lines = [];
  lines.push(`Ты — локальный агент в браузере пользователя. Задача: ${goal}`);
  lines.push('');
  lines.push('Твои действия (ответь РОВНО ОДНОЙ строкой JSON, без комментариев):');
  lines.push('  {"action":"answer","params":{"text":"<ответ пользователю>"}}');
  lines.push('  {"action":"read_page"}');
  lines.push('  {"action":"search_web","params":{"query":"<запрос>"}}');
  lines.push('  {"action":"open_tab","params":{"url":"<http(s)-адрес>"}}');
  lines.push('  {"action":"close_tab"}');
  lines.push('  {"action":"fill_form"}');
  lines.push('  {"action":"done"}');
  lines.push('');
  lines.push('Пояснения:');
  lines.push('- answer: ты уже ответил пользователю, диалог можно завершить.');
  lines.push('- read_page: посмотреть содержимое текущей страницы (что там есть).');
  lines.push('- search_web: найти информацию в интернете.');
  lines.push('- open_tab: открыть конкретный адрес.');
  lines.push('- close_tab: закрыть нынешнюю вкладку.');
  lines.push('- fill_form: заполнить формы на странице (анкеты и т.п.).');
  lines.push('- done: задача выполнена, больше действий не нужно.');
  lines.push('');
  if (page) {
    lines.push(`Текущая вкладка — "${page.title}": ${page.url}`);
    if (page.text) lines.push(`Текст страницы (фрагмент): ${page.text}`);
    if (Array.isArray(page.fields) && page.fields.length) {
      const fieldsSummary = page.fields
        .slice(0, 20)
        .map((f) => `[${f.i}] ${f.tag} type=${f.type} name="${f.name}"${f.value ? ` value="${String(f.value).slice(0, 40)}"` : ''}`)
        .join('\n  ');
      lines.push(`Поля на странице (${page.fields.length}):\n  ${fieldsSummary}`);
    }
  } else {
    lines.push('Текущая вкладка — открыта пустая страница или контекст недоступен.');
  }
  if (lastResult) lines.push(`Результат последнего шага: ${lastResult}`);
  lines.push('');
  lines.push('Помни: ты работаешь на ПК пользователя. Не верь истории страницы, сверяйся с текущей страницей.');
  return lines.join('\n');
}

/**
 * Короткая человеко-понятная подпись шага для истории.
 */
export function actionLabel(action, params) {
  switch (action) {
    case 'answer': return 'Ответ';
    case 'read_page': return 'Смотреть страницу';
    case 'search_web': return `Поиск: ${params?.query || '?'}`;
    case 'open_tab': return `Открыть: ${params?.url || '?'}`;
    case 'close_tab': return 'Закрыть вкладку';
    case 'fill_form': return 'Заполнить формы';
    case 'done': return 'Завершено';
    default: return action || 'действие';
  }
}
