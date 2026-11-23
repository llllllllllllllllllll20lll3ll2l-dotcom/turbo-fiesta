import { youtubeWatchUrl } from './core.mjs';

const YOUTUBE = 'https://www.youtube.com';

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
}

async function waitForLoaded(api, tabId, signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(onUpdated);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onUpdated = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
    const onAbort = () => finish(new DOMException('Остановлено', 'AbortError'));
    const timer = setTimeout(() => finish(), 15000);
    api.tabs.onUpdated.addListener(onUpdated);
    signal?.addEventListener('abort', onAbort, { once: true });
    api.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(); }, finish);
  });
  checkAbort(signal);
}

async function waitForWatchUrl(api, tabId, expected, signal) {
  for (let n = 0; n < 14; n++) {
    checkAbort(signal);
    try {
      const tab = await api.tabs.get(tabId);
      if (youtubeWatchUrl(tab.url) === expected) return true;
    } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function isYouTubeTab(tab) {
  try {
    const url = new URL(tab?.url || '');
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com';
  } catch { return false; }
}

// Chrome serializes this function for execution in the page. It must not rely on module variables.
// Current YouTube can render classic ytd-video-renderer OR new yt-lockup-view-model cards.
export async function findVideoCandidates() {
  const end = Date.now() + 10500;
  while (Date.now() < end) {
    const root = document.querySelector('ytd-search, #primary') || document;
    const links = Array.from(root.querySelectorAll('a[href*="watch?v="], a[href*="/watch?"]'));
    const videos = links.filter(link => !link.closest('ytd-ad-slot-renderer, ytd-promoted-video-renderer, ytd-reel-item-renderer, ytd-shorts, [class*="shortsLockup"]'))
      .slice(0, 32).map(link => {
        const card = link.closest('yt-lockup-view-model, ytd-video-renderer, ytd-rich-item-renderer, ytd-playlist-renderer') || link;
        const heading = card.querySelector('h3, #video-title, .yt-lockup-metadata-view-model__heading-reset');
        return {
          href: link.href,
          title: (link.getAttribute('title') || link.getAttribute('aria-label') || heading?.textContent || link.textContent || '').trim().slice(0, 160)
        };
      });
    if (videos.length) return videos;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return [];
}

// Only a previously validated YouTube video ID reaches this injected function.
// Show a black agent pointer, move it to the result, then click the real link.
export async function clickVideoCandidate(videoId) {
  const links = Array.from(document.querySelectorAll('a[href*="watch?v="], a[href*="/watch?"]'));
  const link = links.find(node => {
    try {
      const url = new URL(node.href);
      return url.hostname === 'www.youtube.com' && url.pathname === '/watch' && url.searchParams.get('v') === videoId;
    } catch { return false; }
  });
  if (!link) return { clicked: false };
  const card = link.closest?.('yt-lockup-view-model, ytd-video-renderer, ytd-rich-item-renderer') || link;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  let host = document.querySelector('[data-pero-work-pointer]');
  const persistent = Boolean(host);
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('data-pero-agent-pointer', '');
    host.style.cssText = 'position:fixed;left:36px;top:112px;width:34px;height:38px;z-index:2147483647;pointer-events:none;transition:left .55s ease,top .55s ease;filter:drop-shadow(0 2px 3px #0009);';
    const shadow = host.attachShadow({ mode: 'closed' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 34 38');
    svg.setAttribute('width', '34');
    svg.setAttribute('height', '38');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M2 2v28l7-7 6 12 5-3-6-12h13Z');
    arrow.setAttribute('fill', '#111114');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '2');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.append(arrow);
    const badge = document.createElement('span');
    badge.textContent = 'Перо';
    badge.style.cssText = 'position:absolute;top:20px;left:20px;background:#111114;color:#fff;border:1px solid #fff;border-radius:8px;padding:3px 7px;font:600 11px Arial,sans-serif;white-space:nowrap;';
    shadow.append(svg, badge);
    document.documentElement.append(host);
  }
  host.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const rect = linkRect.width && linkRect.height ? linkRect : card.getBoundingClientRect();
  host.style.left = `${Math.max(8, Math.min(innerWidth - 40, rect.left + Math.min(rect.width / 2, 100)))}px`;
  host.style.top = `${Math.max(8, Math.min(innerHeight - 40, rect.top + Math.min(rect.height / 2, 35)))}px`;
  await new Promise(resolve => setTimeout(resolve, 1050));
  link.click();
  if (!persistent) setTimeout(() => host.remove(), 2200);
  return { clicked: true };
}

// Autoplay can fail without a user gesture in the tab. Report that honestly.
async function tryPlayVideo() {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const video = document.querySelector('video.html5-main-video, video');
    if (video) {
      if (video.paused) {
        try {
          await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
        } catch { /* Browser/site blocked automatic playback. */ }
      }
      return { playing: !video.paused, muted: video.muted || video.volume === 0, ad: Boolean(document.querySelector('.html5-video-player.ad-showing')) };
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return { playing: false, muted: false, ad: false };
}

export async function openYouTubeMusic(intent, api = chrome, signal, onProgress = () => {}) {
  if (!intent?.query || typeof intent.query !== 'string') throw new Error('Не указано, что искать на YouTube.');
  checkAbort(signal);
  const searchUrl = `${YOUTUBE}/results?search_query=${encodeURIComponent(intent.query.slice(0, 110))}`;
  onProgress('Открываю поиск YouTube…');
  const tab = await api.tabs.create({ url: searchUrl, active: true });
  if (!tab?.id) throw new Error('Не удалось открыть вкладку YouTube.');
  if (!intent.play) return { status: 'search', url: searchUrl };
  await waitForLoaded(api, tab.id, signal);
  if (!isYouTubeTab(await api.tabs.get(tab.id))) return { status: 'search', url: searchUrl };
  onProgress('Ищу подходящее видео…');
  let results;
  try {
    [results] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: findVideoCandidates });
  } catch { return { status: 'search', url: searchUrl }; }
  checkAbort(signal);
  const first = results?.result?.find(item => youtubeWatchUrl(item.href));
  if (!first) return { status: 'search', url: searchUrl };
  const watchUrl = youtubeWatchUrl(first.href);
  const videoId = new URL(watchUrl).searchParams.get('v');
  onProgress('Открываю видео…');
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, func: clickVideoCandidate, args: [videoId] });
  } catch { /* Navigation can destroy the injection response; check the tab URL below. */ }
  checkAbort(signal);
  if (!await waitForWatchUrl(api, tab.id, watchUrl, signal)) {
    // The site may ignore programmatic clicks. Navigate to the validated URL instead.
    await api.tabs.update(tab.id, { url: watchUrl, active: true });
  }
  await waitForLoaded(api, tab.id, signal);
  if (!isYouTubeTab(await api.tabs.get(tab.id))) return { status: 'opened', title: first.title, url: watchUrl };
  let playback;
  try {
    [playback] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: tryPlayVideo });
  } catch { return { status: 'opened', title: first.title, url: watchUrl }; }
  checkAbort(signal);
  const result = playback?.result;
  return { status: result?.playing ? 'playing' : 'opened', muted: Boolean(result?.muted), ad: Boolean(result?.ad), title: first.title, url: watchUrl };
}
