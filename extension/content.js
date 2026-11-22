// Runs only in normal web pages. It never reads a page until the user asks from the panel.
(() => {
  if (globalThis.__PERO_CONTENT_VERSION__ === '1.5.0') return;
  globalThis.__PERO_CONTENT_VERSION__ = '1.5.0';
  const refs = new Map();
  const sessionId = crypto.randomUUID().slice(0, 8);
  let generation = 0;
  let snapshotTime = 0;
  let workPointerTimer = null;
  let workPointerLastSeen = 0;
  const sensitive = /password|парол|passcode|otp|код.?подтвержд|card.?number|credit.?card|cvv|cvc|iban|номер.?карт/i;
  const forbidden = /pay|оплат|купить|checkout|purchase|order now|place order|заказат|плат[её]ж|перевести деньги|transfer funds/i;
  const allowedTypes = new Set(['text', 'search', 'email', 'url', 'number', 'tel']);

  function labelOf(el) {
    const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('id');
    const text = name || (el.matches('input,textarea,[contenteditable="true"]') ? 'Поле ввода' : (el.innerText || el.textContent || el.tagName));
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 110);
  }
  function isSensitive(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const label = [labelOf(el), el.getAttribute('name'), el.getAttribute('id'), autocomplete].join(' ');
    return ['password', 'hidden', 'file'].includes(type) || /cc-|one-time-code|password/.test(autocomplete) || sensitive.test(label);
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return el.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility === 'visible' && style.opacity !== '0';
  }
  function getRef(ref) {
    const el = refs.get(String(ref));
    if (!el || Date.now() - snapshotTime > 90000 || !isVisible(el) || isSensitive(el) || el.disabled) throw new Error('Элемент устарел или недоступен. Прочитайте страницу снова.');
    return el;
  }
  function describe(el) {
    const href = el.closest('a[href]')?.href || '';
    if (href && !/^https?:\/\//i.test(href)) throw new Error('Переход по небезопасной ссылке запрещён.');
    const label = labelOf(el);
    const form = el.closest('form') || el.closest('[role="dialog"]') || el.parentElement;
    const destination = href ? new URL(href).pathname : '';
    if (forbidden.test(label) || forbidden.test(destination) || forbidden.test(el.closest('form')?.getAttribute('action') || '')) throw new Error('Платежи и покупки через агента отключены.');
    let draft = '';
    if (form) {
      const fields = form.querySelectorAll('textarea, input, [contenteditable="true"]');
      draft = Array.from(fields).filter(field => !isSensitive(field)).map(field =>
        field.isContentEditable ? field.innerText : field.value
      ).filter(Boolean).join(' ').slice(0, 400);
    }
    return { label, href: href.slice(0, 300), draft };
  }
  function textOfPage() {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let length = 0;
    for (let n = 0; walker.nextNode() && n < 7000 && length < 3000; n++) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,svg,form,textarea,input,nav,footer,header,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
      if (parent.getClientRects().length === 0) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      parts.push(text.slice(0, 3000 - length));
      length += text.length + 1;
    }
    return parts.join(' ').slice(0, 3000);
  }
  function snapshot() {
    refs.clear();
    generation++;
    snapshotTime = Date.now();
    const elements = [];
    const selector = 'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]';
    const primary = document.querySelector('main, article, [role="main"]');
    const candidates = [...new Set([...(primary?.querySelectorAll(selector) || []), ...document.querySelectorAll(selector)])];
    for (const el of candidates) {
      if (elements.length >= 45) break;
      if (!isVisible(el) || isSensitive(el) || el.disabled || el.closest('[aria-hidden="true"],[hidden]')) continue;
      if (el.matches('input, textarea') && !allowedTypes.has((el.getAttribute('type') || 'text').toLowerCase())) continue;
      const label = labelOf(el);
      if (!label || label.length < 2) continue;
      const ref = `${sessionId}:${generation}:${elements.length + 1}`;
      refs.set(ref, el);
      elements.push({ ref, label, kind: el.matches('input,textarea,[contenteditable="true"]') ? 'поле ввода' : el.matches('a[href]') ? 'ссылка' : 'кнопка' });
    }
    return { title: document.title.slice(0, 150), url: location.href.slice(0, 250), text: textOfPage(), elements };
  }
  function workPointer(token) {
    if (typeof token !== 'string' || !/^[a-z0-9]{6,16}$/.test(token)) throw new Error('Некорректный указатель.');
    const existing = document.querySelector('[data-pero-work-pointer]');
    workPointerLastSeen = Date.now();
    if (existing?.getAttribute('data-pero-work-pointer') === token) return;
    existing?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-pero-work-pointer', token);
    host.style.cssText = 'position:fixed;left:65%;top:40%;z-index:2147483647;pointer-events:none;transition:left .45s ease,top .45s ease;filter:drop-shadow(0 2px 4px #0009)';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '@keyframes pero-cursor-idle{0%,100%{transform:translate(0,0)}50%{transform:translate(6px,5px)}}svg{width:35px;height:40px;animation:pero-cursor-idle 1.3s ease-in-out infinite}';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 34 38');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 2v28l7-7 6 12 5-3-6-12h13Z');
    path.setAttribute('fill', '#111114'); path.setAttribute('stroke', 'white'); path.setAttribute('stroke-width', '2');
    svg.append(path); shadow.append(style, svg); document.documentElement.append(host);
    clearInterval(workPointerTimer);
    workPointerTimer = setInterval(() => {
      if (Date.now() - workPointerLastSeen < 5500) return;
      document.querySelector('[data-pero-work-pointer]')?.remove();
      clearInterval(workPointerTimer);
      workPointerTimer = null;
    }, 1800);
  }
  function pointer(el) {
    const work = document.querySelector('[data-pero-work-pointer]');
    if (work) {
      const rect = el.getBoundingClientRect();
      work.style.left = `${Math.max(8, Math.min(innerWidth - 40, rect.left + Math.min(rect.width / 2, 100)))}px`;
      work.style.top = `${Math.max(8, Math.min(innerHeight - 40, rect.top + Math.min(rect.height / 2, 30)))}px`;
      return;
    }
    const old = document.querySelector('[data-pero-agent-pointer]');
    old?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-pero-agent-pointer', '');
    host.style.cssText = 'position:fixed;left:35px;top:110px;z-index:2147483647;pointer-events:none;transition:left .4s,top .4s;filter:drop-shadow(0 2px 3px #0009)';
    const shadow = host.attachShadow({ mode: 'closed' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 34 38'); svg.setAttribute('width', '34'); svg.setAttribute('height', '38');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 2v28l7-7 6 12 5-3-6-12h13Z');
    path.setAttribute('fill', '#111114'); path.setAttribute('stroke', 'white'); path.setAttribute('stroke-width', '2');
    svg.append(path); shadow.append(svg); document.documentElement.append(host);
    host.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    host.style.left = `${Math.max(8, Math.min(innerWidth - 40, rect.left + Math.min(rect.width / 2, 100)))}px`;
    host.style.top = `${Math.max(8, Math.min(innerHeight - 40, rect.top + Math.min(rect.height / 2, 30)))}px`;
    setTimeout(() => host.remove(), 1600);
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || (msg?.source !== 'pero-panel' && msg?.source !== 'pero-work-pointer')) return;
    if (msg.source === 'pero-work-pointer' && !['POINTER_START', 'POINTER_STOP'].includes(msg.action)) return;
    if (msg.source === 'pero-panel' && ['POINTER_START', 'POINTER_STOP'].includes(msg.action)) return;
    try {
      let result;
      switch (msg.action) {
        case 'PING': result = { ok: true }; break;
        case 'POINTER_START': workPointer(msg.token); result = { visible: true }; break;
        case 'POINTER_STOP': {
          const host = document.querySelector('[data-pero-work-pointer]');
          if (host?.getAttribute('data-pero-work-pointer') === msg.token) {
            host.remove();
            clearInterval(workPointerTimer);
            workPointerTimer = null;
          }
          result = { visible: false }; break;
        }
        case 'SNAPSHOT': result = snapshot(); break;
        case 'INSPECT': result = describe(getRef(msg.ref)); break;
        case 'CLICK': {
          const el = getRef(msg.ref);
          const now = describe(el);
          if (now.label !== msg.expected?.label || now.href !== msg.expected?.href || now.draft !== msg.expected?.draft) throw new Error('Сайт изменил элемент после подтверждения. Действие отменено.');
          pointer(el);
          setTimeout(() => { if (el.isConnected && isVisible(el) && !isSensitive(el)) {
            try { const next = describe(el); if (next.label === now.label && next.href === now.href && next.draft === now.draft) el.click(); } catch { /* stale element */ }
          } }, 500);
          result = { scheduled: true }; break;
        }
        case 'TYPE': {
          const el = getRef(msg.ref);
          if (!el.matches('input,textarea,[contenteditable="true"]') || el.readOnly || (el.matches('input') && !allowedTypes.has((el.getAttribute('type') || 'text').toLowerCase()))) throw new Error('Этот элемент не принимает текст.');
          const text = String(msg.text || '').slice(0, 800);
          if (labelOf(el) !== msg.expected?.label || text !== msg.expected?.text) throw new Error('Поле изменилось после подтверждения.');
          pointer(el);
          el.focus();
          if (el.isContentEditable) {
            const range = document.createRange(); range.selectNodeContents(el); range.deleteContents(); range.insertNode(document.createTextNode(text));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          } else {
            const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
            if (!setter) throw new Error('Нельзя заполнить это поле.');
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          result = { typed: true }; break;
        }
        case 'SCROLL': {
          const direction = msg.direction === 'up' ? -1 : 1;
          window.scrollBy({ top: direction * Math.max(350, innerHeight * .7), behavior: 'smooth' });
          result = { scrolled: true }; break;
        }
        default: throw new Error('Неизвестная команда.');
      }
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: String(error.message || error).slice(0, 180) });
    }
  });
})();
