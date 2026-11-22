// Aura — клиент Ollama. Чистая логика (fetch/JSON) — тестируется с моком fetch.

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen2.5:3b';

export function ollamaTagsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/api/tags`;
}
export function ollamaChatUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/api/chat`;
}

/**
 * Проверяет, доступен ли Ollama.
 * @returns {Promise<{ok: boolean, models: string[], error?: string}>}
 */
export async function checkOllama(baseUrl, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(ollamaTagsUrl(baseUrl));
    if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` };
    const data = await r.json();
    const models = Array.isArray(data?.models) ? data.models.map((m) => m.name) : [];
    return { ok: true, models };
  } catch (ex) {
    return { ok: false, models: [], error: String(ex?.message || ex) };
  }
}

/**
 * Одно сообщение, обычный (не стриминг) ответ.
 */
export async function chatOnce({ baseUrl, model, messages, fetchImpl = fetch }) {
  const r = await fetchImpl(ollamaChatUrl(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Ollama ответил ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data?.message?.content ?? '';
  return { text, model: data?.model ?? model, done: Boolean(data?.done) };
}

/**
 * Поиск информации по открытым вкладкам в памяти.
 * Работает на контенте страницы, переданном вызывающим кодом.
 */
export async function findInTabs({ tabs, query, maxResults = 5 }) {
  const needles = String(query || '').trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const results = [];
  if (!needles.length) return results;
  for (const tab of tabs) {
    const text = String(tab?.text || '').toLowerCase();
    const title = tab?.title || '';
    const url = tab?.url || '';
    if (!text) continue;
    const score = needles.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    if (score === 0) continue;
    const pos = needles.reduce((acc, w) => {
      const p = text.indexOf(w);
      return acc || (p >= 0 ? p : -1);
    }, -1);
    const snippet = p2snippet(tab?.text || '', needles);
    results.push({
      tabId: tab.id, title, url, score,
      scoreWord: needles.filter((w) => text.includes(w)).slice(0, 3),
      snippet,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

function p2snippet(text, needles) {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const w of needles) { const p = lower.indexOf(w); if (p >= 0) { idx = p; break; } }
  if (idx < 0) return text.slice(0, 200);
  const start = Math.max(0, idx - 40);
  return text.slice(start, Math.min(text.length, idx + 200));
}
