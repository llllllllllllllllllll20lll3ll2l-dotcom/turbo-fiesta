// Aura — контентный скрипт: чтение страницы, заполнение форм, AI-курсор.
// Сообщения от фона. Чистый DOM, без API.

const CURSOR_ID = 'aura-cursor';
const CURSOR_CSS = `
#aura-cursor{
  position:fixed; z-index:2147483647; pointer-events:none;
  width:16px; height:16px; border-radius:50%;
  background:#0b0e14; border:2.5px solid #e8ebf2;
  box-shadow:0 0 0 3px rgba(232,235,242,0.28), 0 2px 10px rgba(0,0,0,0.55);
  display:none; opacity:0; transform:translate(-50%,-50%) scale(0.6);
  transition:opacity .18s ease, transform .18s ease;
}
@keyframes aura-pulse{0%,100%{box-shadow:0 0 0 3px rgba(232,235,242,0.28),0 2px 10px rgba(0,0,0,0.55);}
50%{box-shadow:0 0 0 8px rgba(232,235,242,0.12),0 2px 10px rgba(0,0,0,0.55);}}
#aura-cursor.aura-on{display:block;opacity:1;transform:translate(-50%,-50%) scale(1);animation:aura-pulse 1.1s ease-in-out infinite;}
`;

let cursorRaf = null;
let cursorPos = null; // {x, y}
let cursorTarget = null;

function cursorEnsureEl() {
  let el = document.getElementById(CURSOR_ID);
  if (el) return el;
  // CSS injected once
  if (!document.getElementById('aura-cursor-style')) {
    const style = document.createElement('style');
    style.id = 'aura-cursor-style';
    style.textContent = CURSOR_CSS;
    document.head.appendChild(style);
  }
  el = document.createElement('div');
  el.id = CURSOR_ID;
  document.documentElement.appendChild(el);
  return el;
}

function cursorShow() {
  const el = cursorEnsureEl();
  el.style.display = 'block';
  requestAnimationFrame(() => el.classList.add('aura-on'));
  el.style.left = (cursorTarget?.x ?? window.innerWidth / 2) + 'px';
  el.style.top = (cursorTarget?.y ?? window.innerHeight / 2) + 'px';
  const tick = () => {
    const target = cursorTarget;
    if (!target) { cursorRaf = requestAnimationFrame(tick); return; }
    if (!cursorPos) { cursorPos = { x: target.x, y: target.y }; }
    cursorPos.x += (target.x - cursorPos.x) * 0.28;
    cursorPos.y += (target.y - cursorPos.y) * 0.28;
    el.style.left = cursorPos.x + 'px';
    el.style.top = cursorPos.y + 'px';
    cursorRaf = requestAnimationFrame(tick);
  };
  if (!cursorRaf) tick();
}

function cursorHide() {
  const el = document.getElementById(CURSOR_ID);
  if (el) {
    el.classList.remove('aura-on');
    el.style.display = 'none';
  }
  if (cursorRaf) { cancelAnimationFrame(cursorRaf); cursorRaf = null; }
  cursorPos = null;
  cursorTarget = null;
}

window.addEventListener('mousemove', (e) => {
  if (!document.getElementById(CURSOR_ID)) return;
  cursorTarget = { x: e.clientX, y: e.clientY };
}, { passive: true });

// ---------- Сбор полей ----------
function findLabelText(el) {
  const id = el.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.textContent.trim()) return parentLabel.textContent.trim();
  const prev = el.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === 'label' && prev.textContent.trim()) {
    return prev.textContent.trim();
  }
  return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '').trim();
}

function collectFormsAndFields() {
  const fields = [];
  const keptEls = [];
  const formList = [];
  let i = 0;
  const formEls = Array.from(document.querySelectorAll('form'));
  for (const form of formEls) {
    const formId = form.id || `form-${formList.length}`;
    const formFields = Array.from(form.querySelectorAll('input, select, textarea'));
    formList.push({ i: formList.length, id: formId, fields: formFields.length });
  }
  const all = Array.from(document.querySelectorAll('input, select, textarea'));
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || tag).toLowerCase();
    if (tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    const label = findLabelText(el);
    fields.push({
      i, tag, type,
      name: el.name || '',
      id: el.id || '',
      label,
      value: tag === 'select' ? (el.selectedOptions?.[0]?.textContent?.trim() || '') : (el.value || ''),
      required: Boolean(el.required),
      placeholder: el.placeholder || '',
      options: tag === 'select' ? Array.from(el.options).map((o) => o.value).slice(0, 30) : [],
    });
    keptEls.push(el);
    i++;
  }
  return { fields, forms: formList, keptEls };
}

function pageText() {
  // Clone and strip heavy/hidden nodes
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, iframe, svg, canvas, video, audio, nav, footer').forEach((n) => n.remove());
  const text = (clone.innerText || clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 6000);
}

function buildPageSnapshot() {
  const { fields, forms } = collectFormsAndFields();
  return {
    title: document.title || '',
    url: location.href,
    text: pageText(),
    fields,
    forms: forms.map((f) => ({ i: f.i, id: f.id, fields: f.fields })),
  };
}

function findFreshElements() {
  // Возвращает свеже собранный массив keptEls (без скрытых/submit-полей).
  return collectFormsAndFields().keptEls;
}

// ---------- Заполнение ----------


function setFieldValue(el, value) {
  const tag = el.tagName.toLowerCase();
  const type = (el.type || tag).toLowerCase();
  const proto = tag === 'select' ? HTMLSelectElement.prototype : tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (tag === 'select') {
    const str = String(value);
    let chosen = null;
    for (const opt of el.options) {
      if (opt.value === str || opt.textContent.trim() === str) { chosen = opt; break; }
    }
    if (!chosen) {
      const lower = str.toLowerCase();
      for (const opt of el.options) {
        if (opt.textContent.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)) { chosen = opt; break; }
      }
    }
    if (chosen) {
      if (setter) setter.call(el, chosen.value); else el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }
  if (type === 'checkbox') {
    const truthy = /^(yes|да|ок|true|1|истина)$/i.test(String(value).trim());
    el.checked = truthy;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (type === 'radio') {
    el.checked = String(value).trim() === String(el.value).trim();
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const str = String(value);
  if (setter) setter.call(el, str); else el.value = str;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fillFields(items) {
  const kept = findFreshElements();
  const results = [];
  let filled = 0;
  const failures = [];
  for (const item of items) {
    const label = item.label || item.name || `field-${item.i}`;
    const idx = item.i;
    const el = kept[idx];
    if (!el) {
      failures.push({ i: idx, label, reason: 'поле не найдено (список изменился?)' });
      continue;
    }
    try {
      const ok = setFieldValue(el, item.value);
      if (ok) filled++;
      else failures.push({ i: idx, label, reason: 'значение не применилось' });
      results.push({ i: idx, label, ok });
    } catch (ex) {
      failures.push({ i: idx, label, reason: String(ex?.message || ex).slice(0, 120) });
      results.push({ i: idx, label, ok: false });
    }
  }
  return { filled, failed: failures.length, failures, results };
}

// ---------- Сообщения ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'page:read') {
    sendResponse(buildPageSnapshot());
    return false;
  }
  if (msg?.type === 'fill-fields') {
    sendResponse(fillFields(msg.items || []));
    return false;
  }
  if (msg?.type === 'cursor:on') { cursorShow(); sendResponse({ ok: true }); return false; }
  if (msg?.type === 'cursor:off') { cursorHide(); sendResponse({ ok: true }); return false; }
  return false;
});

// Никогда не падаем на старте контентного скрипта
window.addEventListener('error', () => {}, { once: true });
