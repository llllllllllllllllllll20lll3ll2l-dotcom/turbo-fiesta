import test from 'node:test';
import assert from 'node:assert/strict';
import { openYouTubeMusic, findVideoCandidates, clickVideoCandidate } from '../extension/youtube.mjs';

function browserMock(candidates = [], playback = { playing: true, ad: false }) {
  const calls = { created: [], updated: [], scripts: [] };
  const tab = { id: 17, url: '', status: 'complete' };
  const api = {
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async create(options) { calls.created.push(options); tab.url = options.url; return { ...tab }; },
      async update(id, options) { calls.updated.push({ id, ...options }); tab.url = options.url; return { ...tab }; },
      async get() { return { ...tab }; }
    },
    scripting: {
      async executeScript(options) {
        calls.scripts.push(options);
        if (options.func.name === 'findVideoCandidates') return [{ result: candidates }];
        if (options.func.name === 'clickVideoCandidate') {
          tab.url = `https://www.youtube.com/watch?v=${options.args[0]}`;
          return [{ result: { clicked: true } }];
        }
        return [{ result: playback }];
      }
    }
  };
  return { api, calls };
}

test('new YouTube lockup cards are found through watch links', async () => {
  const oldDocument = globalThis.document;
  const heading = { textContent: 'РУССКАЯ ДИСКОТЕКА 2000-Х' };
  const card = { querySelector: () => heading };
  const link = {
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    closest: selector => selector.startsWith('ytd-ad-slot') ? null : card,
    getAttribute: () => null,
    textContent: ''
  };
  const scope = { querySelectorAll: () => [link] };
  globalThis.document = { querySelector: () => scope };
  try {
    const videos = await findVideoCandidates();
    assert.deepEqual(videos, [{ href: link.href, title: heading.textContent }]);
  } finally { globalThis.document = oldDocument; }
});

test('agent pointer is drawn and clicks the chosen search result', async () => {
  const oldDocument = globalThis.document;
  const oldInnerWidth = globalThis.innerWidth;
  const oldInnerHeight = globalThis.innerHeight;
  let clicked = false;
  let cursorDrawn = false;
  const link = {
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    scrollIntoView() {},
    getBoundingClientRect() { return { left: 140, top: 200, width: 180, height: 40 }; },
    click() { clicked = true; }
  };
  const el = () => ({ style: {}, setAttribute() {}, append() {}, attachShadow() { return { append() {} }; }, getBoundingClientRect() {}, remove() {} });
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [link], createElement: el, createElementNS: el, documentElement: { append() { cursorDrawn = true; } } };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  try {
    assert.deepEqual(await clickVideoCandidate('dQw4w9WgXcQ'), { clicked: true });
    assert.equal(cursorDrawn, true);
    assert.equal(clicked, true);
  } finally {
    globalThis.document = oldDocument;
    globalThis.innerWidth = oldInnerWidth;
    globalThis.innerHeight = oldInnerHeight;
  }
});

test('search request opens only YouTube, without injecting scripts', async () => {
  const { api, calls } = browserMock();
  const result = await openYouTubeMusic({ query: 'хиты 2000-х', play: false }, api);
  assert.equal(result.status, 'search');
  assert.equal(new URL(calls.created[0].url).hostname, 'www.youtube.com');
  assert.equal(calls.scripts.length, 0);
  assert.equal(calls.updated.length, 0);
});

test('play request rejects malicious results and plays a valid video', async () => {
  const { api, calls } = browserMock([
    { href: 'https://evil.example/watch?v=dQw4w9WgXcQ', title: 'Malicious' },
    { href: '/watch?v=dQw4w9WgXcQ&list=foo', title: 'Музыка 2000-х' }
  ]);
  const result = await openYouTubeMusic({ query: 'музыка 2000-х', play: true }, api);
  assert.equal(result.status, 'playing');
  assert.equal(calls.updated.length, 0);
  assert.equal(calls.scripts[1].func.name, 'clickVideoCandidate');
  assert.equal(calls.scripts[1].args[0], 'dQw4w9WgXcQ');
  assert.equal(result.title, 'Музыка 2000-х');
  assert.equal(calls.scripts.length, 3);
});

test('when results are unavailable, leave search results open and do not claim playback', async () => {
  const { api, calls } = browserMock([]);
  const result = await openYouTubeMusic({ query: 'музыка 2000-х', play: true }, api);
  assert.equal(result.status, 'search');
  assert.equal(calls.updated.length, 0);
});

test('does not claim playback when site refuses autoplay', async () => {
  const { api } = browserMock([{ href: '/watch?v=dQw4w9WgXcQ', title: 'Хиты' }], { playing: false });
  const result = await openYouTubeMusic({ query: 'хиты', play: true }, api);
  assert.equal(result.status, 'opened');
});
