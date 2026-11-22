// Aura — чистая логика страницы (без DOM).

/** Проверяет, пустой ли фрагмент строки. */
export function isBlank(text) {
  return !String(text || '').trim();
}

/**
 * Проверяет, совпадает ли текст с поисковым запросом.
 * sort/search: считает, сколько слов запроса есть в тексте.
 */
export function pageRelevance(text, query) {
  const needles = String(query || '').trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!needles.length) return 0;
  const hay = String(text || '').toLowerCase();
  return needles.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
}

/** Приhlustrивы страницы — параметры для промпта. */
export function summarizePage({ title, url, text, forms, fields }) {
  return {
    title: String(title || '').slice(0, 120),
    url: String(url || '').slice(0, 200),
    text: String(text || '').trim().slice(0, 2500),
    forms: Array.isArray(forms) ? forms.slice(0, 10) : [],
    fields: Array.isArray(fields) ? fields.slice(0, 40).map((f) => ({
      i: f.i,
      tag: f.tag,
      type: f.type,
      name: String(f.name || '').slice(0, 60),
      value: String(f.value || '').slice(0, 40),
    })) : [],
  };
}
