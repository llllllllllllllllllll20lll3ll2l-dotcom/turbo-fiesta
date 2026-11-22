#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Юнит-тесты ядра WheelRing (без графики).

Запуск:  python3 -m unittest discover -s tests -v
Или:     python3 tests/test_ring_core.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ring_core import (
    contrast_text,
    default_data,
    default_data_path,
    load_data,
    normalize_data,
    ring_segments,
    save_data,
    segment_position,
    status_text,
)


class RingGeometryTests(unittest.TestCase):
    def test_empty_ring(self):
        self.assertEqual(ring_segments(0), [])

    def test_single_segment_is_full_circle(self):
        segs = ring_segments(1)
        self.assertEqual(len(segs), 1)
        self.assertAlmostEqual(segs[0]["extent"], 360.0)

    def test_segments_cover_circle_with_gaps(self):
        for n in (2, 3, 5, 8, 13):
            segs = ring_segments(n)
            self.assertEqual(len(segs), n)
            total = sum(s["extent"] for s in segs)
            self.assertAlmostEqual(total, 360.0 - 5.0 * n, places=1)

    def test_segment_angles_are_increasing(self):
        segs = ring_segments(5)
        starts = [s["start"] for s in segs]
        self.assertEqual(starts, sorted(starts))

    def test_first_segment_centers_on_top(self):
        # первый блок начинается сверху (центр кольца 270° в системе tkinter)
        for n in (3, 6, 8):
            segs = ring_segments(n)
            self.assertAlmostEqual(segs[0]["mid"] % 360.0, 270.0, places=1)

    def test_segments_have_contrast_text_and_colors(self):
        for n in (1, 7):
            for seg in ring_segments(n):
                self.assertRegex(seg["color"], r"^#[0-9a-f]{6}$")
                self.assertIn(seg["text_color"], ("#10131a", "#ffffff"))

    def test_segment_position_uses_tk_angles(self):
        x, y = segment_position(100.0, 50.0, 10.0, 270.0)
        self.assertAlmostEqual(x, 100.0, places=1)  # 0 = 3 часа, сверху (270°) — центр у y-5.5
        self.assertAlmostEqual(y, 50.0 - 10.0, places=1)


class DataModelTests(unittest.TestCase):
    def test_default_data_is_valid(self):
        data = default_data()
        self.assertEqual(data["interval"], 600)
        self.assertGreaterEqual(len(data["steps"]), 1)
        for step in data["steps"]:
            self.assertIn(step["type"], ("app", "cmd"))
            self.assertTrue(step["value"].strip())

    def test_normalize_clamps_interval(self):
        data = normalize_data({"interval": 10, "steps": []})
        self.assertEqual(data["interval"], 50)
        data = normalize_data({"interval": 10_000_000, "steps": []})
        self.assertEqual(data["interval"], 60000)
        data = normalize_data({"interval": "bad", "steps": []})
        self.assertEqual(data["interval"], 600)

    def test_normalize_rejects_bad_step_types(self):
        data = normalize_data({
            "steps": [
                {"name": "A", "type": "virus", "value": "x"},
                {"name": "B", "type": "cmd", "value": "y"},
                "garbage",
                {"name": "", "type": "app", "value": ""},
            ]
        })
        self.assertEqual(data["steps"][0]["type"], "app")   # невалидный тип → app
        self.assertEqual(data["steps"][1]["type"], "cmd")
        self.assertEqual(len(data["steps"]), 3)             # мусор отброшен

    def test_empty_state_is_stable(self):
        data = normalize_data({})
        self.assertEqual(data["steps"], [])
        self.assertEqual(data["interval"], 600)

    def test_status_text_modes(self):
        self.assertEqual(status_text([], None)[0], "0")
        steps = [{"name": "A", "type": "app", "value": "a"},
                 {"name": "B", "type": "cmd", "value": "b"}]
        line1, line2 = status_text(steps, 1)
        self.assertIn("2", line1)
        self.assertEqual(line2, "B")
        line1, _ = status_text(steps, None)
        self.assertEqual(line1, "Обзор")
        # хвост длинного имени сокращается
        long_name = status_text(
            [{"name": "X" * 100, "type": "app", "value": "y"}], 0)[1]
        self.assertLessEqual(len(long_name), 34)


class SaveLoadTests(unittest.TestCase):
    def test_roundtrip_preserves_data(self):
        data = default_data()
        data["interval"] = 1234
        data["steps"][0]["name"] = "Мой банкомат"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sequence.json"
            save_data(data, path)
            with path.open("r", encoding="utf-8") as fh:
                raw = json.load(fh)
            self.assertEqual(raw["interval"], 1234)
            self.assertEqual(raw["steps"][0]["name"], "Мой банкомат")
            loaded = load_data(path)
            self.assertEqual(loaded["interval"], 1234)
            self.assertEqual(loaded["steps"][0]["name"], "Мой банкомат")

    def test_load_missing_file_returns_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            loaded = load_data(Path(tmp) / "sequence.json")
            self.assertEqual(loaded["steps"], default_data()["steps"])

    def test_load_corrupt_file_returns_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sequence.json"
            path.write_text("{ not valid json", encoding="utf-8")
            loaded = load_data(path)
            self.assertEqual(loaded["steps"], default_data()["steps"])

    def test_default_data_path_points_to_appdata(self):
        self.assertTrue(Path(default_data_path()).name == "sequence.json")

    def test_contrast_text_on_light_dark(self):
        self.assertEqual(contrast_text("#eab308"), "#10131a")
        self.assertEqual(contrast_text("#3b82f6"), "#ffffff")


if __name__ == "__main__":
    unittest.main()
