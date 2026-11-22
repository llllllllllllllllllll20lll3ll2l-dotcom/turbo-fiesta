// Тесты lib/agent.js + lib/page.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAction, buildSearchUrl, isAllowedUrl, buildPrompt, actionLabel,
} from '../src/lib/agent.js';
import { summarizePage, pageRelevance, isBlank } from '../src/lib/page.js';

test('parseAction: голый JSON', () => {
  const a = parseAction('{"action":"answer","params":{"text":"Привет"}}');
  assert.equal(a.action, 'answer');
  assert.equal(a.params.text, 'Привет');
});

test('parseAction: JSON в кодблоке', () => {
  const a = parseAction('Теперь скажу:\n```json\n{"action":"done"}\n```');
  assert.equal(a.action, 'done');
});

test('parseAction: JSON внутри текста', () => {
  const a = parseAction('Давайте начнём. {"action":"read_page"}');
  assert.equal(a.action, 'read_page');
});

test('parseAction: невалидный текст', () => {
  assert.equal(parseAction('просто текст без JSON'), null);
  assert.equal(parseAction(''), null);
  assert.equal(parseAction(null), null);
});

test('parseAction: неизвестное действие', () => {
  assert.equal(parseAction('{"action":"hack"}'), null);
});

test('parseAction: URL-подобное значение в params', () => {
  const a = parseAction('{"action":"open_tab","params":{"url":"https://example.com/x?a=1&b=2"}}');
  assert.equal(a.action, 'open_tab');
  assert.equal(a.params.url, 'https://example.com/x?a=1&b=2');
});

test('buildSearchUrl: yandex и google, пустое запроса', () => {
  assert.equal(buildSearchUrl('yandex', 'погода'), 'https://yandex.ru/search/?text=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0');
  assert.equal(buildSearchUrl('google', 'weather'), 'https://www.google.com/search?q=weather');
  assert.equal(buildSearchUrl('yandex', '  '), null);
});

test('isAllowedUrl: http/https только', () => {
  assert.equal(isAllowedUrl('https://example.com/a'), true);
  assert.equal(isAllowedUrl('http://example.com'), true);
  assert.equal(isAllowedUrl('chrome://extensions'), false);
  assert.equal(isAllowedUrl('not-a-url'), false);
});

test('buildPrompt: содержит задачу и контекст', () => {
  const p = buildPrompt({
    goal: 'заполнить форму',
    page: { title: 'Регистрация', url: 'https://x.ru', text: 'Заполните поля' },
    lastResult: 'страница прочитана',
  });
  assert.match(p, /заполнить форму/);
  assert.match(p, /Регистрация/);
  assert.match(p, /страница прочитана/);
  assert.match(p, /action/);
});

test('buildPrompt: без страницы — без page-блока', () => {
  const p = buildPrompt({ goal: 'что делать' });
  assert.match(p, /что делать/);
  assert.match(p, /пуст/i);
});

test('actionLabel: все типы', () => {
  assert.match(actionLabel('search_web', { query: 'погода' }), /Поиск/);
  assert.match(actionLabel('fill_form', {}), /формы/);
  assert.equal(actionLabel('done', {}), 'Завершено');
  assert.equal(actionLabel('неизвестно', {}), 'неизвестно');
});

test('summarizePage: обрезает и сериализует', () => {
  const s = summarizePage({
    title: 'A'.repeat(300),
    url: 'https://x.ru/' + 'b'.repeat(300),
    text: 'C'.repeat(5000),
    forms: [{}, {}, {}],
    fields: Array.from({ length: 50 }, (_, i) => ({ i: i + 1, tag: 'input', type: 'text', name: `f${i}`, value: `v${i}` })),
  });
  assert.equal(s.title.length, 120);
  assert.equal(s.url.length, 200);
  assert.equal(s.text.length, 2500);
  assert.equal(s.forms.length, 3);
  assert.equal(s.fields.length, 40);
});

test('pageRelevance: считает совпадения', () => {
  assert.equal(pageRelevance('погода в Москве', 'погода'), 1);
  assert.equal(pageRelevance('погода в Москве', 'погода москве'), 2);
  assert.equal(pageRelevance('привет', 'москва'), 0);
  assert.equal(pageRelevance('', 'погода'), 0);
});

test('isBlank: пустые строки', () => {
  assert.equal(isBlank(''), true);
  assert.equal(isBlank('   '), true);
  assert.equal(isBlank('a'), false);
});
