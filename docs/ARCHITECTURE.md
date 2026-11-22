# Архитектура Aura

## Поток данных

```
Пользователь → Чат-попап → Порт 'agent' → Service worker (runAgent)
                                              │
                                              ├─ chrome.* → вкладки/курсор
                                              │
                                              └─ локальная Ollama (127.0.0.1:11434, /api/chat)
                                                 ↓
                                              parseAction → переключатель → газовый цикл (≤8 шагов)
                                                 ↓
                                              'answer' → в чат + в историю

Формы: runFillForm = profile (мгновенно) + массовый вызов модели → chrome.tabs.sendMessage
```

## Модули

### `src/lib/` — чистые модули (без браузера)

| Модуль | Назначение |
|---|---|
| `agent.js` | `parseAction` (JSON-экстрактор), `buildSearchUrl`, `isAllowedUrl`, `buildPrompt`, `actionLabel` |
| `ollama.js` | `checkOllama` (/api/tags), `chatOnce` (/api/chat), `findInTabs` |
| `fields.js` | Классификация полей (по имени/id/placeholder), `fieldPlan`, `valueFor` |
| `page.js` | `summarizePage`, `pageRelevance` |

### `src/content/content.js` — страница

- Извлечение контента: `title`, `url`, `innerText` (≤6000 симв.), формы и поля (`i`, `tag`, `type`, `name`, `id`, `label`, `value`, `options`)
- Заполнение: `fill-fields` — setFieldValue с соблюдением React/Vue (native setter), `input`+`change` events
- AI-курсор: div + lerp + `mousemove` — 14px кружочек, чёрный с белым outline, `z-index: 2147483647`, pulse-анимация

### `src/background/background.js` — service worker

- `runAgent(goal)` — до MAX_STEPS итераций: сборка сообщений, запрос к Ollama, `parseAction`, переключательная обработка
- `runFillForm(profile, settings)` — profile → AI → `fill-fields`
- `findInOpenTabs(query)` — итерация по вкладкам + `findInTabs`
- Порт `agent` → события `step`/`answer`/`error`/`done`/`status`/`fill-result`

### `src/popup/` — темная чат UI

- Вкладки: Чат / Вкладки / Настройки
- Чат: история из `chrome.storage.local['aura-chat']`, чипы быстрых команд, спиннер, «■ Стоп»
- Вкладки: поиск по открытых, открыть URL, закрыть активную
- Настройки: Ollama URL/модель, движок, автозаполнение, профиль

## Почему MV3 + ES-module service worker

- React/Vue/SPA — `<all_frames>` не включаем (страница 1фреймовый, textarea/select только в 1 фрейме)
- Ollama — HTTP-клиент, без CORS-заголовов (host_permissions в manifest)
- Без внешних зависимостей в проде — нативная ES-модульная система MV3

## Безопасность

- Никаких данных наружу — только 127.0.0.1
- `password`/`hidden`/`submit` — никогда не заполняются
- Формы НЕ отправляются — только поля заполняются
- URL для открытия — только http/https
- Контентный скрипт не делает `eval`/innerHTML
