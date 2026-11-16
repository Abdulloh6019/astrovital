"""Crew-entered vital readings replace synthetic ones until cleared."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from astro_medical.api import create_app


class ManualVitalsTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.c = TestClient(create_app(Path(folder.name) / "db.sqlite3", background=False))
        self.c.__enter__()
        self.addCleanup(lambda: (self.c.__exit__(None, None, None), folder.cleanup()))

    def member(self, status, cid="C01"):
        return next(p for p in status["crew"] if p["crew_id"] == cid)

    def test_manual_value_overrides_and_triggers_rules(self):
        s = self.c.post("/api/crew/C01/vitals", json={"values": {"glucose": 48, "heart_rate": 140}}).json()
        p = self.member(s)
        self.assertEqual(p["vitals"]["glucose"]["value"], 48)
        self.assertTrue(p["vitals"]["glucose"]["sensor_id"].startswith("MANUAL-"))
        self.assertEqual(sorted(p["manual"]), ["glucose", "heart_rate"])
        codes = {a["code"] for a in s["active_alerts"] if a["subject_id"] == "C01"}
        self.assertTrue({"LOW_GLUCOSE", "HIGH_HEART_RATE"} <= codes)
        # stays on later samples
        s = self.c.post("/api/step").json()
        self.assertEqual(self.member(s)["vitals"]["glucose"]["value"], 48)
        events = self.c.get("/api/events?limit=20").json()["items"]
        self.assertTrue(any(e["event_type"] == "MANUAL_VITALS" for e in events))

    def test_clear_returns_to_sensor(self):
        self.c.post("/api/crew/C01/vitals", json={"values": {"spo2": 85}})
        s = self.c.delete("/api/crew/C01/vitals").json()
        p = self.member(s)
        self.assertEqual(p["manual"], [])
        self.assertGreater(p["vitals"]["spo2"]["value"], 95)

    def test_single_field_can_be_reset(self):
        self.c.post("/api/crew/C01/vitals", json={"values": {"spo2": 85, "fatigue": 90}})
        s = self.c.post("/api/crew/C01/vitals", json={"values": {"spo2": None}}).json()
        self.assertEqual(self.member(s)["manual"], ["fatigue"])

    def test_dose_reading_resets_accumulation(self):
        s = self.c.post("/api/crew/C02/vitals", json={"values": {"rad_dose_total": 300}}).json()
        v = self.member(s, "C02")["vitals"]["rad_dose_total"]["value"]
        self.assertTrue(300 <= v < 301)

    def test_manual_reading_replaces_missing_sensor(self):
        self.c.post("/api/scenario", json={"scenario": "sensor_fault"})
        s = self.c.post("/api/crew/C01/vitals", json={"values": {"spo2": 97}}).json()
        self.assertEqual(self.member(s)["vitals"]["spo2"]["value"], 97)

    def test_validation(self):
        self.assertEqual(self.c.post("/api/crew/C01/vitals", json={"values": {"spo2": 140}}).status_code, 422)
        self.assertEqual(self.c.post("/api/crew/C01/vitals", json={"values": {"magic": 1}}).status_code, 422)
        self.assertEqual(self.c.post("/api/crew/C99/vitals", json={"values": {"spo2": 90}}).status_code, 404)
        self.assertIn('id="manualForm"', self.c.get("/").text)


if __name__ == "__main__":
    unittest.main()
