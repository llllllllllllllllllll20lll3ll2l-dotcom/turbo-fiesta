import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, OLLAMA_URL, PAGE_LIMIT, SELECTION_LIMIT, splitJsonLines, localModelNames, makeMessages, safeHistory } from '../extension/core.mjs';

test('Ollama endpoint remains loopback-only', () => {
  assert.equal(OLLAMA_URL, 'http://127.0.0.1:11434');
  assert.equal(DEFAULT_MODEL, 'qwen3:4b-instruct-2507-q4_K_M');
});

test('model picker excludes Ollama cloud models', () => {
  assert.deepEqual(localModelNames([
    { name: 'qwen3:4b-instruct-2507-q4_K_M' },
    { name: 'gemma4:cloud' },
    { model: 'qwen2.5:3b' }
  ]), ['qwen3:4b-instruct-2507-q4_K_M', 'qwen2.5:3b']);
});

test('stream parser handles messages split across network reads', () => {
  const a = splitJsonLines('', '{"message":{"content":"При');
  assert.deepEqual(a.events, []);
  const b = splitJsonLines(a.rest, 'вет"}}\n{"done":true}\n');
  assert.deepEqual(b.events, [{ message: { content: 'Привет' } }, { done: true }]);
  assert.equal(b.rest, '');
});

test('stream parser handles final event without trailing newline', () => {
  const { events, rest } = splitJsonLines('', '{"done":true}', true);
  assert.deepEqual(events, [{ done: true }]);
  assert.equal(rest, '');
});

test('page context is transient and truncated', () => {
  const history = [{ role: 'user', content: 'Здравствуйте' }];
  const messages = makeMessages(history, 'Перескажи', { kind: 'page', title: 'Статья', url: 'https://example.com/', text: 'Я'.repeat(PAGE_LIMIT + 10) });
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /Контекст веб-страницы/);
  assert.match(messages.at(-1).content, /Контекст обрезан/);
  assert.ok(messages.at(-1).content.length < PAGE_LIMIT + 600);
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'Здравствуйте');
  assert.match(messages[0].content, /недоверенными данными/);
});

test('selection uses a smaller context budget', () => {
  const result = makeMessages([], 'Объясни', { kind: 'selection', text: 'A'.repeat(SELECTION_LIMIT + 20) });
  assert.equal((result.at(-1).content.match(/A/g) || []).length, SELECTION_LIMIT);
});

test('stored chat history rejects malformed entries and limits count', () => {
  const input = [{ role: 'system', content: 'malicious' }, { role: 'user', content: null }, ...Array.from({ length: 35 }, (_, n) => ({ role: 'assistant', content: String(n) }))];
  const result = safeHistory(input);
  assert.equal(result.length, 30);
  assert.equal(result[0].content, '5');
  assert.equal(result.at(-1).content, '34');
});
