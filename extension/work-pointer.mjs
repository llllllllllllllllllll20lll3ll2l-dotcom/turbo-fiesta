// A visible extension-owned cursor while a request is running. It does not
// move the OS cursor or read the page; restricted browser pages are skipped.
export function startWorkPointer(api, signal) {
  const token = Math.random().toString(36).slice(2, 12);
  const touched = new Set();
  let active = true;
  let currentId = null;
  let sequence = 0;

  async function sendStop(id) {
    try { await api.tabs.sendMessage(id, { source: 'pero-work-pointer', action: 'POINTER_STOP', token }); }
    catch { /* The tab may have navigated or closed. */ }
  }
  async function show(id, force = false) {
    if (!active || !id || (currentId === id && !force)) return;
    const generation = ++sequence;
    try {
      const tab = await api.tabs.get(id);
      if (!active || generation !== sequence) return;
      if (tab.incognito || !/^https?:\/\//i.test(tab.url || '')) {
        if (currentId) { void sendStop(currentId); currentId = null; }
        return;
      }
      if (currentId && currentId !== id) void sendStop(currentId);
      currentId = id;
      const msg = { source: 'pero-work-pointer', action: 'POINTER_START', token };
      try {
        const reply = await api.tabs.sendMessage(id, msg);
        if (!reply?.ok || !reply.result?.visible) throw new Error('Указатель ещё не установлен.');
      }
      catch {
        if (!active || generation !== sequence) return;
        await api.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        if (!active || generation !== sequence) { await sendStop(id); return; }
        const reply = await api.tabs.sendMessage(id, msg);
        if (!reply?.ok || !reply.result?.visible) throw new Error('Указатель недоступен на странице.');
      }
      touched.add(id);
      if (!active || generation !== sequence) await sendStop(id);
    } catch { /* Some pages refuse scripting; the panel cursor remains visible. */ }
  }
  async function sync() {
    if (!active) return;
    try {
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && tab?.id) await show(tab.id, true);
    } catch { /* Window might be closing. */ }
  }
  const activated = info => { void show(info.tabId, true); };
  const updated = (id, change, tab) => { if (change.status === 'complete' && tab?.active) void show(id, true); };
  const removed = id => { touched.delete(id); if (currentId === id) { currentId = null; void sync(); } };
  const focused = () => { void sync(); };
  api.tabs.onActivated?.addListener(activated);
  api.tabs.onUpdated?.addListener(updated);
  api.tabs.onRemoved?.addListener(removed);
  api.windows?.onFocusChanged?.addListener(focused);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setInterval(sync, 1400);
  const ready = sync();
  function stop() {
    if (!active) return;
    active = false;
    sequence++;
    clearInterval(timer);
    api.tabs.onActivated?.removeListener(activated);
    api.tabs.onUpdated?.removeListener(updated);
    api.tabs.onRemoved?.removeListener(removed);
    api.windows?.onFocusChanged?.removeListener(focused);
    signal?.removeEventListener('abort', stop);
    if (currentId) touched.add(currentId);
    for (const id of touched) void sendStop(id);
    touched.clear();
    currentId = null;
  }
  return { ready, stop };
}
