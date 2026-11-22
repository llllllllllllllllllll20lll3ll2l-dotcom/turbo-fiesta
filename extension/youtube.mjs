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
    const finish = (error) => {
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

function isYouTubeTab(tab) {
  try {
    const url = new URL(tab?.url || '');
    return url.protocol === 'https:' && url.hostname === 'www.youtube.com';
  } catch { return false; }
}

// Runs in the YouTube search tab. Returns only visible candidate links; no page commands are executed.
async function findVideoCandidates() {
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    const nodes = document.querySelectorAll('ytd-video-renderer a#video-title[href], ytd-rich-item-renderer a#video-title[href]');
    const videos = Array.from(nodes).slice(0, 12).filter(node => node.getClientRects().length > 0).map(node => ({
      href: node.href,
      title: (node.getAttribute('title') || node.textContent || '').trim().slice(0, 160)
    }));
    if (videos.length) return videos;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return [];
}

// Browser autoplay policy may refuse play(). In that case the user can click Play in the opened tab.
async function tryPlayVideo() {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const video = document.querySelector('video.html5-main-video, video');
    if (video) {
      if (video.paused) {
        try {
          await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
        } catch { /* Autoplay is restricted by the site or browser. */ }
      }
      return { playing: !video.paused, ad: Boolean(document.querySelector('.html5-video-player.ad-showing')), title: document.title.slice(0, 160) };
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return { playing: false, ad: false, title: document.title.slice(0, 160) };
}

export async function openYouTubeMusic(intent, api = chrome, signal, onProgress = () => {}) {
  if (!intent?.query || typeof intent.query !== 'string') throw new Error('Не указано, что искать на YouTube.');
  checkAbort(signal);
  // The query is encoded as a parameter; destination and video links are restricted to YouTube.
  const searchUrl = `${YOUTUBE}/results?search_query=${encodeURIComponent(intent.query.slice(0, 110))}`;
  onProgress('Открываю поиск YouTube…');
  const tab = await api.tabs.create({ url: searchUrl, active: true });
  if (!tab?.id) throw new Error('Не удалось открыть вкладку YouTube.');
  if (!intent.play) return { status: 'search', url: searchUrl };
  await waitForLoaded(api, tab.id, signal);
  const loaded = await api.tabs.get(tab.id);
  if (!isYouTubeTab(loaded)) return { status: 'search', url: searchUrl };
  onProgress('Ищу подходящее видео…');
  let results;
  try {
    [results] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: findVideoCandidates });
  } catch { return { status: 'search', url: searchUrl }; }
  checkAbort(signal);
  const first = results?.result?.find(item => youtubeWatchUrl(item.href));
  if (!first) return { status: 'search', url: searchUrl };
  const watchUrl = youtubeWatchUrl(first.href);
  onProgress('Открываю видео…');
  await api.tabs.update(tab.id, { url: watchUrl, active: true });
  await waitForLoaded(api, tab.id, signal);
  if (!isYouTubeTab(await api.tabs.get(tab.id))) return { status: 'opened', title: first.title, url: watchUrl };
  let playback;
  try {
    [playback] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: tryPlayVideo });
  } catch { return { status: 'opened', title: first.title, url: watchUrl }; }
  checkAbort(signal);
  const playing = Boolean(playback?.result?.playing);
  return { status: playing ? 'playing' : 'opened', ad: Boolean(playback?.result?.ad), title: first.title, url: watchUrl };
}
