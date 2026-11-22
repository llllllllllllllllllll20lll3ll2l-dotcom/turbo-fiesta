#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WheelRing — круговой оверлей для Windows.

Нажатие колёсика мыши в любой точке экрана открывает/скрывает оверлей.
В оверлее — круговая «диаграмма» из сегментов (блоков):
  • каждый блок — приложение (notepad.exe, chrome.exe, путь к .exe)
    или полная команда (start notepad, cmd /c copy …, echo …).
Оверлей хранит последовательность в %APPDATA%/WheelRing/sequence.json
и по кнопке «Запустить» запускает шаги по очереди с интервалом.

Управление:
  колёсико мыши  — показать/скрыть оверлей
  Esc            — скрыть оверлей
  клик по сегменту — выбрать блок
  Delete / Del   — удалить выбранный блок
  Enter          — запустить последовательность
  стрелки вверх/вниз — выбрать предыдущий/следующий блок
  двойной клик по шапке — не запускает ничего (только перетаскивание)

Зависимости: только стандартная библиотека (tkinter + ctypes).
Требуется Windows 10/11.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from ring_core import (
    default_data_path,
    load_data,
    ring_segments,
    save_data,
    segment_position,
    status_text,
)

APP_NAME = "WheelRing"
IS_WINDOWS = sys.platform == "win32"

# ------------------------------------------------------------------ Win32

user32 = None
if IS_WINDOWS:
    try:
        user32 = ctypes.windll.user32
        user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
        user32.GetWindowLongW.restype = ctypes.c_long
        user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
        user32.SetWindowLongW.restype = ctypes.c_long
        user32.SetLayeredWindowAttributes.argtypes = [
            ctypes.c_void_p, ctypes.c_uint, ctypes.c_ubyte, ctypes.c_uint,
        ]
        user32.SetLayeredWindowAttributes.restype = ctypes.c_int
        user32.SetWindowsHookExW.argtypes = [
            ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
        ]
        user32.SetWindowsHookExW.restype = ctypes.c_void_p
        user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
        user32.UnhookWindowsHookEx.restype = ctypes.c_int
        user32.CallNextHookEx.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_size_t, ctypes.c_void_p,
        ]
        user32.CallNextHookEx.restype = ctypes.c_ssize_t
    except Exception:
        user32 = None

WH_MOUSE_LL = 14
WM_MOUSEWHEEL = 0x020A
WM_MOUSEHWHEEL = 0x020E
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
LWA_ALPHA = 0x00000002
HOOK_DEBOUNCE = 0.45  # секунд, защита от дрожания колёсика


class LowLevelWheelHook:
    """Глобальный низкоуровневый хук мыши — срабатывает во всех окнах."""

    def __init__(self, callback):
        self._callback = callback
        self._hook = None
        self._proc = None  # держим ссылку, иначе хук разрушится

    def install(self):
        if user32 is None:
            raise RuntimeError("функции Win32 недоступны")

        def low_level_mouse_proc(n_code, w_param, l_param):
            try:
                if n_code >= 0 and w_param in (WM_MOUSEWHEEL, WM_MOUSEHWHEEL):
                    self._callback()
            finally:
                pass
            return user32.CallNextHookEx(None, n_code, w_param, l_param)

        self._proc = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t, ctypes.c_int, ctypes.c_size_t, ctypes.c_void_p
        )(low_level_mouse_proc)
        self._hook = user32.SetWindowsHookExW(WH_MOUSE_LL, self._proc, None, 0)
        if not self._hook:
            raise ctypes.WinError(ctypes.get_last_error())

    def uninstall(self):
        if self._hook and user32 is not None:
            try:
                user32.UnhookWindowsHookEx(self._hook)
            except Exception:
                pass
            self._hook = None


# ------------------------------------------------------------------ стиль

PANEL_BG   = "#161922"
TITLE_BG   = "#10131b"
PANEL_EDGE = "#2c3242"
TEXT_FG    = "#e9ecf3"
MUTED      = "#8b93a7"
INPUT_BG   = "#0e1016"
INPUT_FG   = "#f0f2f8"
BTN_BG     = "#242a3c"
BTN_HOVER  = "#2f364a"
ACCENT     = "#38bdf8"
BTN_RUN    = "#0284c7"
BTN_RUN_H  = "#0ea5e9"
BTN_STOP   = "#7f1d1d"
BTN_STOP_H = "#991b1b"
HUB_BG     = "#0d0f15"
OK_GREEN   = "#4ade80"
WARN_AMBER = "#fbbf24"
ERR_RED    = "#f87171"

WIN_W = 880
WIN_H = 580
CANVAS_SIDE = 470
R_OUTER = 198
HUB_R = 150

FONT_BODY = ("Segoe UI", 11)
FONT_SM = ("Segoe UI", 9)
FONT_MD = ("Segoe UI", 10)
FONT_NUM = ("Segoe UI", 14, "bold")
FONT_TITLE = ("Segoe UI", 14, "bold")
FONT_HUB = ("Segoe UI", 16, "bold")
FONT_SUBB = ("Segoe UI", 10)


def _style_theme(root):
    st = ttk.Style(root)
    try:
        st.theme_use("clam")
    except tk.TclError:
        pass

    st.configure("TFrame", background=PANEL_BG)
    st.configure("TLabel", background=PANEL_BG, foreground=TEXT_FG, font=FONT_BODY)
    st.configure("Heading.TLabel", background=PANEL_BG, foreground=ACCENT,
                 font=("Segoe UI", 10, "bold"))
    st.configure("Hint.TLabel", background=PANEL_BG, foreground=MUTED, font=FONT_SM)

    st.configure("TEntry", fieldbackground=INPUT_BG, background=INPUT_BG,
                 foreground=INPUT_FG, bordercolor=PANEL_EDGE, lightcolor=PANEL_EDGE,
                 darkcolor=PANEL_EDGE, insertcolor=INPUT_FG, font=FONT_BODY)
    st.map("TEntry", fieldbackground=[("focus", INPUT_BG)])

    st.configure("TCombobox", fieldbackground=INPUT_BG, background=INPUT_BG,
                 foreground=TEXT_FG, bordercolor=PANEL_EDGE, arrowcolor=TEXT_FG,
                 lightcolor=PANEL_BG, darkcolor=PANEL_BG, selectbackground=INPUT_BG,
                 selectforeground=TEXT_FG, font=FONT_BODY)

    st.configure("TButton", background=BTN_BG, foreground=TEXT_FG,
                 bordercolor=PANEL_EDGE, lightcolor=BTN_BG, darkcolor=BTN_BG,
                 padding=(10, 6), font=("Segoe UI", 10))
    st.map("TButton",
           background=[("active", BTN_HOVER), ("pressed", BTN_HOVER), ("disabled", PANEL_BG)],
           foreground=[("disabled", "#5b6376")])

    st.configure("Accent.TButton", background=BTN_RUN, foreground="#ffffff",
                 padding=(12, 8), font=("Segoe UI", 11, "bold"))
    st.map("Accent.TButton",
           background=[("active", BTN_RUN_H), ("pressed", BTN_RUN_H), ("disabled", "#1d232f")],
           foreground=[("disabled", "#5b6376")])

    st.configure("Danger.TButton", background=BTN_STOP, foreground="#ffffff",
                 padding=(10, 6), font=("Segoe UI", 10))
    st.map("Danger.TButton",
           background=[("active", BTN_STOP_H), ("pressed", BTN_STOP_H), ("disabled", "#1d232f")],
           foreground=[("disabled", "#5b6376")])


# ------------------------------------------------------------------ приложение

class WheelRingApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.withdraw()
        self.title(APP_NAME)
        self.overrideredirect(True)
        self.resizable(False, False)
        self.configure(bg=PANEL_BG)
        try:
            self.attributes("-topmost", True)
        except tk.TclError:
            pass

        _style_theme(self)
        self._apply_layered_alpha()

        # данные
        self._data_path = default_data_path()
        self._data = load_data(self._data_path)
        self._sel = 0 if self._data["steps"] else None
        self._running = False
        self._cancel = False
        self._run_timer = None
        self._run_index = 0
        self._current_run = None
        self._visible = False
        self._centered = False
        self._last_wheel = 0.0
        self._drag_start = None
        self._drag_geo = None

        # создаём файл последовательности при первом запуске
        try:
            save_data(self._data, self._data_path)
        except Exception:
            pass

        self._build_ui()
        self._install_hook()
        self._bind_keys()
        self._redraw_ring()
        self._fill_fields()
        self._update_count()
        self.protocol("WM_DELETE_WINDOW", self._hide)

    # ---------------------------------------------------------- окно

    def _apply_layered_alpha(self, alpha=246):
        if user32 is None:
            return
        try:
            hwnd = self.winfo_id()
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            if not (style & WS_EX_LAYERED):
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED)
            user32.SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA)
        except Exception:
            pass

    def _center(self):
        try:
            sw = self.winfo_screenwidth()
            sh = self.winfo_screenheight()
            x = (sw - WIN_W) // 2
            y = (sh - WIN_H) // 2
            self.geometry(f"{WIN_W}x{WIN_H}+{x}+{y}")
        except Exception:
            self.geometry(f"{WIN_W}x{WIN_H}")
        self._centered = True

    def _show(self):
        if self._visible:
            return
        self._visible = True
        if not self._centered:
            self._center()
        try:
            self.deiconify()
            self.lift()
            self.attributes("-topmost", True)
            self.focus_force()
        except Exception:
            pass
        self._redraw_ring()

    def _hide(self):
        if not self._visible:
            return
        self._visible = False
        try:
            self.withdraw()
        except Exception:
            pass

    def _toggle(self):
        if self._visible:
            self._hide()
        else:
            self._show()

    def _on_wheel(self):
        now = time.time()
        if now - self._last_wheel < HOOK_DEBOUNCE:
            return
        self._last_wheel = now
        try:
            self._toggle()
        except Exception:
            pass

    def _quit(self):
        try:
            self._wheel_hook.uninstall()
        except Exception:
            pass
        try:
            self.destroy()
        except Exception:
            pass
        sys.exit(0)

    # ---------------------------------------------------------- хуки

    def _install_hook(self):
        # вызывается из __init__; хук мыши устанавливается сразу
        try:
            self._wheel_hook = LowLevelWheelHook(self._on_wheel)
            self._wheel_hook.install()
        except Exception as ex:
            self._wheel_hook = None
            # колёсико недоступно — оставляем возможность открыть оверлей повторно
            self._status(f"Колёсико недоступно: {ex}", ERR_RED)

    # ---------------------------------------------------------- drag

    def _drag_start(self, event):
        self._drag_start = (event.x_root, event.y_root)
        self._drag_geo = (self.winfo_x(), self.winfo_y())

    def _drag_move(self, event):
        if self._drag_start is None:
            return
        dx = event.x_root - self._drag_start[0]
        dy = event.y_root - self._drag_start[1]
        self.geometry(f"+{self._drag_geo[0] + dx}+{self._drag_geo[1] + dy}")

    # ---------------------------------------------------------- сборка UI

    def _build_ui(self):
        titlebar = tk.Frame(self, bg=TITLE_BG, height=46)
        titlebar.pack(side="top", fill="x")
        titlebar.pack_propagate(False)

        title_label = tk.Label(titlebar, text="● WheelRing", bg=TITLE_BG,
                               fg=ACCENT, font=FONT_TITLE, cursor="fleur")
        title_label.pack(side="left", padx=(14, 2), pady=10)
        title_label.bind("<ButtonPress-1>", self._drag_start)
        title_label.bind("<B1-Motion>", self._drag_move)

        spacer = tk.Label(titlebar, text="", bg=TITLE_BG, cursor="fleur")
        spacer.pack(side="left", fill="both", expand=True, pady=10)
        spacer.bind("<ButtonPress-1>", self._drag_start)
        spacer.bind("<B1-Motion>", self._drag_move)

        hide_btn = tk.Button(titlebar, text="✕", bg=TITLE_BG, fg=MUTED,
                             activebackground=BTN_HOVER, activeforeground="#ffffff",
                             relief="flat", bd=0, font=("Segoe UI", 13, "bold"),
                             command=self._hide)
        hide_btn.pack(side="right", padx=(0, 6))

        quit_btn = tk.Button(titlebar, text="⏻", bg=TITLE_BG, fg=ERR_RED,
                             activebackground=BTN_HOVER, activeforeground="#ffffff",
                             relief="flat", bd=0, font=("Segoe UI", 13, "bold"),
                             command=self._quit)
        quit_btn.pack(side="right", padx=(0, 8))

        body = tk.Frame(self, bg=PANEL_BG)
        body.pack(fill="both", expand=True, padx=14, pady=(4, 12))

        self._ring = tk.Canvas(body, width=CANVAS_SIDE, height=CANVAS_SIDE,
                               bg=PANEL_BG, highlightthickness=0,
                               cursor="hand2")
        self._ring.pack(side="left", padx=(4, 18), pady=(6, 10))
        self._ring.bind("<Button-1>", self._on_canvas_click)

        editor = ttk.Frame(body, padding=(0, 4))
        editor.pack(side="right", fill="y")
        self._build_editor(editor)

    def _build_editor(self, parent):
        parent.columnconfigure(0, weight=1)

        self._count_label = ttk.Label(parent, text="", style="Heading.TLabel")
        self._count_label.grid(row=0, column=0, sticky="w", pady=(0, 4))

        ttk.Label(parent, text="Тип блока", style="Hint.TLabel").grid(row=1, column=0, sticky="w")
        self._type_box = ttk.Combobox(parent, values=["Приложение", "Команда"],
                                      state="readonly", width=26, font=FONT_BODY)
        self._type_box.grid(row=2, column=0, sticky="ew", pady=(2, 6))
        self._type_box.bind("<<ComboboxSelected>>", lambda e: self._commit_meta())

        ttk.Label(parent, text="Метка", style="Hint.TLabel").grid(row=3, column=0, sticky="w")
        self._name_entry = ttk.Entry(parent, width=32, font=FONT_BODY)
        self._name_entry.grid(row=4, column=0, sticky="ew", pady=(2, 6))
        self._name_entry.bind("<FocusOut>", lambda e: self._commit_meta())
        self._name_entry.bind("<Return>", self._on_entry_enter)

        ttk.Label(parent, text="Значение", style="Hint.TLabel").grid(row=5, column=0, sticky="w")
        self._value_entry = ttk.Entry(parent, width=32, font=FONT_BODY)
        self._value_entry.grid(row=6, column=0, sticky="ew", pady=(2, 4))
        self._value_entry.bind("<FocusOut>", lambda e: self._commit_meta())
        self._value_entry.bind("<Return>", self._on_entry_enter)
        ttk.Label(parent,
                  text="Приложение: notepad.exe, путь к .exe   •   Команда: start chrome, cmd /c …",
                  style="Hint.TLabel", wraplength=340, justify="left").grid(
                  row=7, column=0, sticky="w", pady=(0, 8))

        add_btn = ttk.Button(parent, text="+ Добавить блок",
                             command=self._add_step)
        add_btn.grid(row=8, column=0, sticky="ew", pady=(0, 6))

        row9 = ttk.Frame(parent)
        row9.grid(row=9, column=0, sticky="ew", pady=(0, 6))
        row9.columnconfigure(0, weight=1)
        row9.columnconfigure(1, weight=1)
        self._del_btn = ttk.Button(row9, text="🗑 Удалить",
                                   command=self._delete_step)
        self._del_btn.grid(row=0, column=0, sticky="ew", padx=(0, 3))
        self._move_left_btn = ttk.Button(row9, text="◀ Раньше",
                                         command=lambda: self._move_step(-1))
        self._move_left_btn.grid(row=0, column=1, sticky="ew", padx=(3, 0))

        row10 = ttk.Frame(parent)
        row10.grid(row=10, column=0, sticky="ew", pady=(0, 6))
        row10.columnconfigure(0, weight=1)
        row10.columnconfigure(1, weight=1)
        self._move_right_btn = ttk.Button(row10, text="Позже ▶",
                                          command=lambda: self._move_step(1))
        self._move_right_btn.grid(row=0, column=0, sticky="ew", padx=(0, 3))
        self._clear_btn = ttk.Button(row10, text="Очистить всё",
                                     command=self._clear_all)
        self._clear_btn.grid(row=0, column=1, sticky="ew", padx=(3, 0))

        ttk.Label(parent, text="Интервал между шагами (мс)",
                  style="Hint.TLabel").grid(row=11, column=0, sticky="w")
        self._interval_entry = ttk.Entry(parent, width=12, font=FONT_BODY)
        self._interval_entry.grid(row=12, column=0, sticky="w", pady=(2, 8))
        self._interval_entry.bind("<FocusOut>", lambda e: self._commit_interval())
        self._interval_entry.bind("<Return>", self._on_interval_enter)

        run_frame = ttk.Frame(parent)
        run_frame.grid(row=13, column=0, sticky="ew", pady=(2, 8))
        run_frame.columnconfigure(0, weight=2)
        run_frame.columnconfigure(1, weight=1)
        self._run_btn = ttk.Button(run_frame, text="▶ Запустить",
                                   style="Accent.TButton",
                                   command=self._run_sequence)
        self._run_btn.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self._stop_btn = ttk.Button(run_frame, text="■ Стоп",
                                    style="Danger.TButton",
                                    command=self._stop_run, state="disabled")
        self._stop_btn.grid(row=0, column=1, sticky="ew")

        self._status_label = ttk.Label(parent, text="", style="Hint.TLabel",
                                       wraplength=345, justify="left", anchor="w")
        self._status_label.grid(row=14, column=0, sticky="w", pady=(2, 2))

        self._path_label = ttk.Label(parent,
                                     text=f"Хранение: {self._data_path}",
                                     style="Hint.TLabel", wraplength=345,
                                     justify="left", font=("Segoe UI", 8))
        self._path_label.grid(row=15, column=0, sticky="w", pady=(2, 0))

    def _bind_keys(self):
        self.bind("<Escape>", lambda e: self._hide())
        self.bind("<Return>", self._on_return_key)
        self.bind("<Delete>", self._on_delete_key)
        self.bind("<BackSpace>", self._on_delete_key)
        self.bind("<Up>", self._on_cycle_key)
        self.bind("<Down>", self._on_cycle_key)

    # ---------------------------------------------------------- поля / клавиатура

    def _is_field(self):
        w = self.focus_get()
        if w is None:
            return False
        try:
            cls = w.winfo_class()
        except tk.TclError:
            return False
        return cls in ("Entry", "TEntry", "TCombobox", "Text", "TSpinbox", "Spinbox")

    def _on_entry_enter(self, event):
        self._commit_meta()
        self.focus_force()

    def _on_interval_enter(self, event):
        self._commit_interval()
        self.focus_force()

    def _on_return_key(self, event):
        if self._is_field():
            return
        self._run_sequence()

    def _on_delete_key(self, event):
        if self._is_field():
            return
        self._delete_step()

    def _on_cycle_key(self, event):
        if self._is_field():
            return
        direction = -1 if event.keysym == "Up" else 1
        self._cycle_selection(direction)

    # ---------------------------------------------------------- поля ввода

    def _fill_fields(self):
        steps = self._data["steps"]
        sel = self._sel
        if sel is not None and 0 <= sel < len(steps):
            s = steps[sel]
            self._type_box.set("Приложение" if s["type"] == "app" else "Команда")
            self._name_entry.delete(0, "end")
            self._name_entry.insert(0, s["name"])
            self._value_entry.delete(0, "end")
            self._value_entry.insert(0, s["value"])
        else:
            self._type_box.set("Приложение")
            self._name_entry.delete(0, "end")
            self._value_entry.delete(0, "end")
        self._interval_entry.delete(0, "end")
        self._interval_entry.insert(0, str(self._data["interval"]))

    def _commit_interval(self):
        cur = self._interval_entry.get().strip()
        try:
            value = int(cur)
        except ValueError:
            value = self._data["interval"]
        value = max(50, min(value, 60000))
        self._data["interval"] = value
        self._interval_entry.delete(0, "end")
        self._interval_entry.insert(0, str(value))
        self._save_data()

    def _commit_meta(self):
        steps = self._data["steps"]
        sel = self._sel
        if sel is None or not (0 <= sel < len(steps)):
            return
        s = steps[sel]
        s["type"] = "cmd" if self._type_box.get() == "Команда" else "app"
        s["name"] = self._name_entry.get().strip()[:60]
        s["value"] = self._value_entry.get().strip()[:400]
        self._save_data()
        self._redraw_ring()
        self._update_count()

    # ---------------------------------------------------------- операции

    def _select(self, index):
        self._commit_meta()
        self._sel = index
        self._fill_fields()
        self._redraw_ring()
        self._update_count()

    def _deselect(self):
        self._commit_meta()
        self._sel = None
        self._fill_fields()
        self._redraw_ring()
        self._update_count()

    def _cycle_selection(self, direction):
        steps = self._data["steps"]
        n = len(steps)
        if n == 0:
            return
        if self._sel is None or self._sel >= n:
            self._select(0)
            return
        self._select((self._sel + direction) % n)

    def _add_step(self):
        self._commit_meta()
        steps = self._data["steps"]
        steps.append({"name": f"Шаг {len(steps) + 1}", "type": "app", "value": ""})
        self._sel = len(steps) - 1
        self._save_data()
        self._fill_fields()
        self._redraw_ring()
        self._update_count()
        self._status("Добавлен новый блок — введите его значение", ACCENT)
        self._value_entry.focus_set()

    def _delete_step(self):
        steps = self._data["steps"]
        sel = self._sel
        if sel is None or not (0 <= sel < len(steps)):
            self._status("Выберите блок, который нужно удалить")
            return
        removed = steps.pop(sel)
        self._sel = min(sel, len(steps) - 1) if steps else None
        self._save_data()
        self._fill_fields()
        self._redraw_ring()
        self._update_count()
        self._status(f"Удалён блок «{removed['name'] or removed['value'] or 'без имени'}»")

    def _move_step(self, delta):
        steps = self._data["steps"]
        sel = self._sel
        if sel is None or not (0 <= sel < len(steps)):
            return
        j = sel + delta
        if not (0 <= j < len(steps)):
            return
        self._commit_meta()
        steps[sel], steps[j] = steps[j], steps[sel]
        self._sel = j
        self._save_data()
        self._fill_fields()
        self._redraw_ring()
        self._update_count()

    def _clear_all(self):
        steps = self._data["steps"]
        if not steps:
            return
        if messagebox.askyesno(
            f"{APP_NAME} — очистка",
            f"Удалить все {len(steps)} блоков?\nДействие нельзя отменить.",
            parent=self,
        ):
            self._data["steps"] = []
            self._sel = None
            self._save_data()
            self._fill_fields()
            self._redraw_ring()
            self._update_count()
            self._status("Все блоки удалены", WARN_AMBER)

    # ---------------------------------------------------------- выполнение

    def _run_sequence(self):
        if self._running:
            return
        steps = self._data["steps"]
        self._commit_meta()
        if not steps:
            self._status("Сначала добавьте блоки в диаграмму", ERR_RED)
            return
        bad = [i + 1 for i, s in enumerate(steps) if not s["value"].strip()]
        if bad:
            self._status(f"Заполните поле «Значение»: блоки {', '.join(map(str, bad))}", WARN_AMBER)
            return
        self._running = True
        self._cancel = False
        self._run_index = 0
        self._current_run = 0
        self._sync_run_buttons()
        self._redraw_ring()
        self._status("Запуск последовательности…", ACCENT)
        self._launch_next()

    def _launch_next(self):
        if self._cancel:
            return
        steps = self._data["steps"]
        i = self._run_index
        if i >= len(steps):
            self._finish_run()
            return
        self._current_run = i
        self._redraw_ring()
        step = steps[i]
        try:
            self._launch_step(step)
            self._status(
                f"Запущен блок [{i + 1}/{len(steps)}]: {step['name'] or step['value']}",
                ACCENT,
            )
        except Exception as ex:
            self._status(f"Ошибка запуска блока [{i + 1}/{len(steps)}]: {ex}", ERR_RED)
        self._run_index = i + 1
        interval = max(50, int(self._data["interval"]))
        self._run_timer = self.after(interval, self._launch_next)

    def _finish_run(self):
        self._running = False
        self._current_run = None
        if self._run_timer is not None:
            try:
                self.after_cancel(self._run_timer)
            except Exception:
                pass
            self._run_timer = None
        self._sync_run_buttons()
        self._redraw_ring()
        self._status("✓ Последовательность завершена", OK_GREEN)

    def _stop_run(self):
        if not self._running:
            return
        self._cancel = True
        self._running = False
        self._current_run = None
        if self._run_timer is not None:
            try:
                self.after_cancel(self._run_timer)
            except Exception:
                pass
            self._run_timer = None
        self._sync_run_buttons()
        self._redraw_ring()
        self._status("■ Остановлено вручную", WARN_AMBER)

    def _sync_run_buttons(self):
        self._run_btn.configure(state="disabled" if self._running else "!disabled")
        self._stop_btn.configure(state="!disabled" if self._running else "disabled")

    def _launch_step(self, step):
        value = step["value"].strip()
        if step["type"] == "app":
            path = Path(value)
            if path.is_file():
                start = getattr(os, "startfile", None)  # только на Windows
                if start is not None:
                    try:
                        start(str(path))
                        return
                    except Exception:
                        pass
                subprocess.Popen([str(path)])
                return
            # имя программы или путь с пробелами — через shell
            subprocess.Popen(value, shell=True)
            return
        # полная команда
        subprocess.Popen(value, shell=True)

    # ---------------------------------------------------------- отрисовка

    def _redraw_ring(self):
        canvas = self._ring
        canvas.delete("all")
        steps = self._data["steps"]
        n = len(steps)
        cx = cy = CANVAS_SIDE // 2
        r = R_OUTER

        canvas.create_oval(cx - r, cy - r, cx + r, cy + r,
                           fill="#10131b", outline=PANEL_EDGE, width=1,
                           tags=("disc",))

        segments = ring_segments(n)
        for i, seg in enumerate(segments):
            selected = i == self._sel
            running = i == self._current_run
            width = 8 if running else (5 if selected else 2)
            outline = "#facc15" if running else ("#ffffff" if selected else PANEL_BG)
            canvas.create_arc(cx - r, cy - r, cx + r, cy + r,
                              start=seg["start"], extent=seg["extent"],
                              style=tk.PIESLICE, fill=seg["color"],
                              outline=outline, width=width,
                              tags=(f"seg_{i}",))
            canvas.tag_bind(f"seg_{i}", "<Button-1>", lambda e, i=i: self._select(i))
            mid = seg["mid"]
            x, y = segment_position(cx, cy, (HUB_R + r) / 2, mid)
            font = ("Segoe UI", 15 if n <= 12 else 11, "bold")
            canvas.create_text(x, y, text=str(i + 1), fill=seg["text_color"],
                               font=font, anchor="center", tags=(f"num_{i}",))

        canvas.create_oval(cx - r, cy - r, cx + r, cy + r,
                           fill="", outline="#3a4155", width=1, tags=("border",))
        canvas.create_oval(cx - HUB_R, cy - HUB_R, cx + HUB_R, cy + HUB_R,
                           fill=HUB_BG, outline="#232838", width=2, tags=("hub",))

        line1, line2 = status_text(steps, self._sel)
        canvas.create_text(cx, cy - 20, text=line1, fill=TEXT_FG,
                           font=FONT_HUB, anchor="center", tags=("hubtext1",))
        canvas.create_text(cx, cy + 24, text=line2, fill=MUTED,
                           font=FONT_SUBB, anchor="center", tags=("hubtext2",))

    def _on_canvas_click(self, event):
        items = self._ring.find_overlapping(event.x, event.y)
        has_seg = False
        for item in items:
            for tag in self._ring.gettags(item):
                if tag.startswith("seg_"):
                    has_seg = True
                    break
            if has_seg:
                break
        if not has_seg:
            self._deselect()

    def _status(self, text, color=None):
        self._status_label.configure(text=text, foreground=color or MUTED)

    def _update_count(self):
        n = len(self._data["steps"])
        self._count_label.configure(text=f"Блоков: {n}")

    def _save_data(self):
        try:
            save_data(self._data, self._data_path)
        except Exception:
            pass


def _run():
    if not IS_WINDOWS:
        print("WheelRing — круговой оверлей для Windows.")
        print("На этой платформе оверлей не запустится:")
        print("функции глобального окна Win32 недоступны.")
        print("Чтобы использовать оверлей: Windows 10/11 + Python 3.9+ с tkinter.")
        print("Чтобы собрать EXE:  pip install pyinstaller")
        print("                    pyinstaller --onefile --windowed --name WheelRing wheel_ring.py")
        raise SystemExit(0)

    try:
        app = WheelRingApp()
    except Exception as ex:
        print(f"Не удалось открыть оверлей: {ex}", file=sys.stderr)
        raise SystemExit(1)

    try:
        app.mainloop()
    except Exception as ex:
        print(f"Оверлей остановлен: {ex}", file=sys.stderr)

    try:
        app._wheel_hook.uninstall()
    except Exception:
        pass


if __name__ == "__main__":
    _run()
