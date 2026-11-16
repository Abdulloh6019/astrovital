"""Automatic AI review while the mission is at risk."""
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from astro_medical.ai_auto import build_records, situation_signature
from astro_medical.api import create_app
from tests.test_ai import FakeEngine


def wait_auto(client, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        a = client.get("/api/ai/auto").json()
        if a["last"] and not a["current"]:
            return a
        time.sleep(0.05)
    raise AssertionError("auto analysis did not finish")


class AutoAnalysisTests(unittest.TestCase):
    def make(self, engine):
        folder = TemporaryDirectory()
        client = TestClient(create_app(Path(folder.name) / "db.sqlite3", background=False, ai_engine=engine))
        client.__enter__()
        self.addCleanup(lambda: (client.__exit__(None, None, None), folder.cleanup()))
        return client

    def test_normal_mission_does_not_trigger(self):
        c = self.make(FakeEngine())
        c.post("/api/scenario", json={"scenario": "normal"})
        c.post("/api/step")
        a = c.get("/api/ai/auto").json()
        self.assertTrue(a["enabled"])
        self.assertEqual(a["runs"], 0)

    def test_risk_triggers_analysis_and_journal_entry(self):
        c = self.make(FakeEngine())
        c.post("/api/scenario", json={"scenario": "combined"})
        for _ in range(4):
            c.post("/api/step")
        a = wait_auto(c)
        self.assertGreaterEqual(a["runs"], 1)
        self.assertEqual(a["last"]["status"], "done")
        self.assertLessEqual(len(a["last"]["records"]), 12)
        c.post("/api/step")  # collects the finished job and writes the journal entry
        events = c.get("/api/events?limit=60").json()["items"]
        self.assertTrue(any(e["event_type"] == "AI_ANALYSIS" for e in events))

    def test_same_situation_is_not_reanalysed(self):
        c = self.make(FakeEngine())
        c.post("/api/scenario", json={"scenario": "shared_co2"})
        for _ in range(10):  # let the scenario ramp up and settle
            c.post("/api/step")
        first = wait_auto(c)["runs"]
        for _ in range(3):
            c.post("/api/step")
        self.assertEqual(wait_auto(c)["runs"], first)

    def test_can_be_switched_off(self):
        c = self.make(FakeEngine())
        self.assertFalse(c.post("/api/ai/auto", json={"enabled": False}).json()["enabled"])
        c.post("/api/scenario", json={"scenario": "combined"})
        for _ in range(3):
            c.post("/api/step")
        self.assertEqual(c.get("/api/ai/auto").json()["runs"], 0)

    def test_no_model_no_analysis(self):
        c = self.make(FakeEngine(available=False))
        c.post("/api/scenario", json={"scenario": "combined"})
        c.post("/api/step")
        a = c.get("/api/ai/auto").json()
        self.assertFalse(a["available"])
        self.assertEqual(a["runs"], 0)

    def test_records_cover_all_data_sources(self):
        status = {
            "level": "critical", "symptom_labels": {"dizziness": "Bosh aylanishi"},
            "crew": [{"crew_id": "C01", "name": "Aziza", "zone_id": "LAB", "symptoms": ["dizziness"]}],
            "zones": [{"zone_id": "LAB", "name": "Laboratoriya moduli"}],
            "active_alerts": [
                {"code": "LOW_SPO2", "severity": "critical", "title": "SpO₂ pasayishi", "description": "87 %", "scope": "crew", "subject_id": "C01"},
                {"code": "HIGH_CO2", "severity": "attention", "title": "CO₂ ko‘payishi", "description": "0.5 kPa", "scope": "zone", "subject_id": "LAB"}],
            "shared_findings": [{"code": "X", "title": "Umumiy sabab", "interpretation": "Muhit", "evidence": ["a", "b"]}],
            "mission": {"systems": {"scrubber_ok": {"value": 0}}},
        }
        text = " | ".join(build_records(status).values())
        for part in ("Umumiy holat", "Aziza", "Laboratoriya moduli", "bosh aylanishi", "CO₂ tozalash"):
            self.assertIn(part, text)
        many = dict(status, active_alerts=status["active_alerts"] * 20)
        recs = build_records(many)
        self.assertLessEqual(len(recs), 12)
        self.assertTrue(all(len(v) <= 500 for v in recs.values()))
        self.assertNotEqual(situation_signature(status), situation_signature(dict(status, level="attention")))

    def test_panel_has_auto_toggle(self):
        c = self.make(FakeEngine())
        self.assertIn('id="aiAutoToggle"', c.get("/").text)


if __name__ == "__main__":
    unittest.main()
