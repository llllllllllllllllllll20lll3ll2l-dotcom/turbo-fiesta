// Тесты lib/ollama.js + lib/fields.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOllama, ollamaTagsUrl, ollamaChatUrl, findInTabs } from '../src/lib/ollama.js';
import {
  classifyField, profileKeyFor, profileValueFor, fieldPlan, valueFor, isFillable,
  FIELD_TYPES,
} from '../src/lib/fields.js';

test('ollamaTagsUrl / ollamaChatUrl: нормализация', () => {
  assert.equal(ollamaTagsUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434/api/tags');
  assert.equal(ollamaChatUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434/api/chat');
});

test('checkOllama: сервер недоступен', async () => {
  const r = await checkOllama('http://127.0.0.1:11434', async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('checkOllama: список моделей', async () => {
  const fake = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'qwen2.5:3b' }, { name: 'llama3:8b' }] }),
  });
  const r = await checkOllama('http://x', fake);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['qwen2.5:3b', 'llama3:8b']);
});

test('checkOllama: HTTP-ошибка', async () => {
  const fake = async () => ({ ok: false, status: 500 });
  const r = await checkOllama('http://x', fake);
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
});

test('findInTabs: поиск по словам', async () => {
  const tabs = [
    { id: 1, title: 'Форум', url: 'https://forum.ru', text: 'Привет, как дела? Какой у вас дом?' },
    { id: 2, title: 'Вики', url: 'https://wiki.ru', text: 'Википедия — свободная энциклопедия' },
    { id: 3, title: 'Маркет', url: 'https://shop.ru', text: 'Купить микроволновку недорого' },
  ];
  const r = await findInTabs({ tabs, query: 'микроволновку' });
  assert.equal(r.length, 1);
  assert.equal(r[0].tabId, 3);
});

test('findInTabs: пустые/отсутствующие вкладки', async () => {
  const tabs = [{ id: 1, title: 'Лист', url: '', text: '' }];
  assert.equal((await findInTabs({ tabs, query: 'что-нибудь' })).length, 0);
});

test('findInTabs: ничего не найдено', async () => {
  const tabs = [{ id: 1, title: 'A', url: 'u', text: 'zzz' }];
  assert.equal((await findInTabs({ tabs, query: 'zzz' })).length, 1);
  assert.equal((await findInTabs({ tabs, query: 'qqq' })).length, 0);
});

test('classifyField: email/phone/age/birth/city/address/website/occupation/name/notes', () => {
  assert.equal(classifyField('E-mail'), FIELD_TYPES.EMAIL);
  assert.equal(classifyField('Телефон'), FIELD_TYPES.PHONE);
  assert.equal(classifyField('Возраст'), FIELD_TYPES.AGE);
  assert.equal(classifyField('Дата рождения'), FIELD_TYPES.BIRTHDATE);
  assert.equal(classifyField('Город'), FIELD_TYPES.CITY);
  assert.equal(classifyField('Адрес'), FIELD_TYPES.ADDRESS);
  assert.equal(classifyField('Сайт'), FIELD_TYPES.WEBSITE);
  assert.equal(classifyField('Должность'), FIELD_TYPES.OCCUPATION);
  assert.equal(classifyField('Имя'), FIELD_TYPES.FIRST_NAME);
  assert.equal(classifyField('Фамилия'), FIELD_TYPES.LAST_NAME);
  assert.equal(classifyField('О себе'), FIELD_TYPES.NOTES);
  assert.equal(classifyField(''), FIELD_TYPES.UNKNOWN);
});

test('profileKeyFor / profileValueFor', () => {
  assert.equal(profileKeyFor(FIELD_TYPES.EMAIL), 'email');
  assert.equal(profileKeyFor(FIELD_TYPES.PHONE), 'phone');
  assert.equal(profileKeyFor(FIELD_TYPES.TEXT), null);
  const profile = { email: 'a@b.c', phone: '+7 900' };
  assert.equal(profileValueFor(profile, FIELD_TYPES.EMAIL), 'a@b.c');
  assert.equal(profileValueFor(profile, FIELD_TYPES.AGE), null);
});

test('fieldPlan: пароль не заполняем, пустой → fillable', () => {
  const profile = { first_name: 'Иван', phone: '+7 900' };
  const password = { type: 'password', label: 'пароль', value: '' };
  assert.equal(fieldPlan(password, profile).canFill, false);

  const emptyText = { type: 'text', label: 'имя', value: '' };
  const plan = fieldPlan(emptyText, profile);
  assert.equal(plan.canFill, true);
  assert.equal(plan.needsProfile, true);
  assert.equal(plan.needsAi, false);

  const filled = { type: 'text', label: 'имя', value: 'уже' };
  assert.equal(fieldPlan(filled, profile).canFill, false);
});

test('valueFor: first_name/last_name → из профиля', () => {
  const profile = { first_name: 'Иван', last_name: 'Петров', name: 'Иван Петров' };
  const first = { type: 'text', label: 'Имя', value: '' };
  assert.equal(valueFor(first, profile), 'Иван');
  const last = { type: 'text', label: 'Фамилия', value: '' };
  assert.equal(valueFor(last, profile), 'Петров');
  const unknown = { type: 'text', label: 'Комментарий', value: '' };
  assert.equal(valueFor(unknown, profile), null); // требует AI
});

test('isFillable: текстовые и скрытые поля', () => {
  assert.equal(isFillable({ type: 'text', value: '' }), true);
  assert.equal(isFillable({ type: 'hidden', value: '' }), false);
  assert.equal(isFillable({ type: 'password', value: '' }), false);
  assert.equal(isFillable({ type: 'text', value: 'уже' }), false);
});
