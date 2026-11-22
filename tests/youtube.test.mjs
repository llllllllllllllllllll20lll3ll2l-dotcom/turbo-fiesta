import test from 'node:test';
import assert from 'node:assert/strict';
import { openYouTubeMusic } from '../extension/youtube.mjs';

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
        return [{ result: calls.scripts.length === 1 ? candidates : playback }];
      }
    }
  };
  return { api, calls };
}

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
  assert.equal(calls.updated[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(result.title, 'Музыка 2000-х');
  assert.equal(calls.scripts.length, 2);
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
