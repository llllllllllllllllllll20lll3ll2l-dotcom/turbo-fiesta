#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WheelRing — ядро без графики.

Всё, что не зависит от tkinter/Windows, лежит здесь:
  • модель данных последовательности (блок = приложение или команда),
  • загрузка/сохранение JSON,
  • геометрия кольца сегментов (для круговой диаграммы).

Используется и главным оверлеем (wheel_ring.py), и тестами.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

APP_NAME = "WheelRing"
APP_VERSION = "1.0.0"

# Палитрa сегментов кольца (по кругу)
PALETTE = [
    "#ef4444",  # red
    "#f97316",  # orange
    "#eab308",  # yellow
    "#22c55e",  # green
    "#06b6d4",  # cyan
    "#3b82f6",  # blue
    "#8b5cf6",  # violet
    "#ec4899",  # pink
]

VALID_TYPES = ("app", "cmd")

DEFAULT_INTERVAL_MS = 600
MIN_INTERVAL_MS = 50
MAX_INTERVAL_MS = 60000


# ------------------------------------------------------------------ данные

def default_data() -> dict:
    """Начальное состояние — три демо-шага."""
    return normalize_data({
        "interval": DEFAULT_INTERVAL_MS,
        "steps": [
            {"name": "Блокнот",     "type": "app", "value": "notepad.exe"},
            {"name": "Калькулятор", "type": "app", "value": "calc.exe"},
            {"name": "Команда",     "type": "cmd", "value": "echo WheelRing: команда выполнена"},
        ],
    })


def _normalize_step(item):
    if not isinstance(item, dict):
        return None
    typ = item.get("type", "app")
    if typ not in VALID_TYPES:
        typ = "app"
    return {
        "name":  str(item.get("name", "")).strip()[:60],
        "type":  typ,
        "value": str(item.get("value", "")).strip()[:400],
    }


def normalize_data(raw) -> dict:
    """Приводит произвольное JSON-состояние к валидному виду."""
    if not isinstance(raw, dict):
        raw = {}

    try:
        interval = int(raw.get("interval", DEFAULT_INTERVAL_MS))
    except (TypeError, ValueError):
        interval = DEFAULT_INTERVAL_MS
    interval = max(MIN_INTERVAL_MS, min(interval, MAX_INTERVAL_MS))

    steps_raw = raw.get("steps", [])
    steps = []
    if isinstance(steps_raw, list):
        for item in steps_raw:
            step = _normalize_step(item)
            if step is not None:
                steps.append(step)

    return {"interval": interval, "steps": steps}


def default_data_path() -> Path:
    """%APPDATA%/WheelRing/sequence.json (или ~/Documents/WheelRing/...)."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        base = Path(appdata)
    else:
        base = Path.home() / "Documents"
    return base / APP_NAME / "sequence.json"


def load_data(path) -> dict:
    """Загружает состояние; при любой ошибке — демо-данные."""
    try:
        with Path(path).open("r", encoding="utf-8") as fh:
            return normalize_data(json.load(fh))
    except Exception:
        return default_data()


def save_data(state, path) -> None:
    """Атомарно сохраняет состояние (через временный файл)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(normalize_data(state), fh, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# ----------------------------------------------------------- геометрия кольца

def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return 0.0
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


def contrast_text(hex_color: str) -> str:
    """Тёмный или светлый цвет текста, читаемый поверх сегмента."""
    return "#10131a" if _luminance(hex_color) > 140 else "#ffffff"


def ring_segments(n: int):
    """
    Геометрия кольца для n блоков.

    Возвращает список диктовок:
      start   — угол начала в градусах (0 = 3 часа, по часовой стрелке, как в tkinter)
      extent  — угловую меру сегмента
      color   — цвет заливки
      mid     — угол середины (для подписи)
      text_color — цвет подписи (контрастный)
    Кольцо размечено равномерно; первый блок начинается сверху.
    """
    if not isinstance(n, int) or n <= 0:
        return []
    seg = 360.0 / n
    gap = 5.0 if n >= 2 else 0.0
    extent = max(seg - gap, 1.0)
    result = []
    for i in range(n):
        start = 270.0 - seg / 2.0 + i * seg + gap / 2.0
        color = PALETTE[i % len(PALETTE)]
        result.append({
            "start":     start,
            "extent":    extent,
            "color":     color,
            "mid":       start + extent / 2.0,
            "text_color": contrast_text(color),
        })
    return result


def segment_position(cx: float, cy: float, radius: float, angle_deg: float):
    """Координаты точки на кольце: угол 0 = 3 часа, идут по часовой стрелке."""
    rad = math.radians(angle_deg)
    return cx + radius * math.cos(rad), cy + radius * math.sin(rad)


def status_text(steps, sel, hint=""):
    """Текст в центре кольца."""
    n = len(steps)
    if n == 0:
        return "0", "Нет блоков\nдобавьте первый шаг"
    if sel is not None and 0 <= sel < n:
        step = steps[sel]
        name = step.get("name") or step.get("value") or "Блок"
        if len(name) > 34:
            name = name[:33] + "…"
        return f"Шаг {sel + 1} из {n}", name
    return "Обзор", f"Шагов: {n}\nВыберите блок для редактирования"
