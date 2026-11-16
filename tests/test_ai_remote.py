"""Kaggle mode: the laptop UI forwards AI analyses to a Kaggle GPU server."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from astro_medical.ai_engine import AIEngine
from astro_medical.ai_remote import HybridEngine, RemoteError, create_ai_server
from astro_medical.api import create_app
from tests.test_ai import FakeEngine, wait_job

KAGGLE = "https://demo-kaggle.trycloudflare.com"


def bridge(server_client, alive=lambda: True):
    """HTTP function that routes the laptop's requests into the fake Kaggle server."""
    def http(method, url, payload=None, timeout=10):
        if not alive():
            raise RemoteError("Kaggle serveriga ulanib bo'lmadi: offline")
        path = url[len(KAGGLE):]
        res = server_client.request(method, path, json=payload)
        if res.status_code >= 400:
            raise RemoteError(f"Kaggle server xatosi {res.status_code}")
        return res.json()
    return http


class RemoteModeTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.kaggle = TestClient(create_ai_server(FakeEngine()))
        self.online = True
        local = FakeEngine(available=False)  # laptop has no model installed
        self.engine = HybridEngine(local, Path(self.folder.name) / "ai_remote.json",
                                   http=bridge(self.kaggle, lambda: self.online))
        self.app = TestClient(create_app(Path(self.folder.name) / "db.sqlite3", background=False, ai_engine=self.engine))
        self.app.__enter__()
        self.addCleanup(lambda: self.app.__exit__(None, None, None))

    def test_local_mode_until_url_saved(self):
        s = self.app.get("/api/ai/status").json()
        self.assertEqual(s["mode"], "local")
        self.assertFalse(s["available"])
        self.assertEqual(self.app.post("/api/ai/analyze", json={"records": {"E1": "x"}}).status_code, 409)

    def test_analysis_runs_on_kaggle(self):
        s = self.app.post("/api/ai/remote", json={"url": KAGGLE + "/"}).json()
        self.assertEqual(s["mode"], "kaggle")
        self.assertEqual(s["remote_url"], KAGGLE)
        self.engine.remote.poll_seconds = 0.01
        job = self.app.post("/api/ai/analyze", json={"records": {
            "E1": "A02 bosh aylanishini qayd etdi.", "E2": "LAB modulida ventilyatsiya o'chdi."}}).json()
        done = wait_job(self.app, job["job_id"])
        self.assertEqual(done["status"], "done", done)
        self.assertEqual(done["result"]["harakat"], "CHECK_CABIN")
        self.assertEqual(done["result"]["manba"], "Kaggle GPU")

    def test_url_is_remembered_and_can_be_cleared(self):
        self.app.post("/api/ai/remote", json={"url": KAGGLE})
        again = HybridEngine(FakeEngine(available=False), Path(self.folder.name) / "ai_remote.json",
                             http=bridge(self.kaggle))
        self.assertEqual(again.status()["remote_url"], KAGGLE)
        self.assertEqual(self.app.post("/api/ai/remote", json={"url": ""}).json()["mode"], "local")

    def test_bad_or_unreachable_url_is_rejected(self):
        self.assertEqual(self.app.post("/api/ai/remote", json={"url": "ftp://x"}).status_code, 422)
        self.online = False
        res = self.app.post("/api/ai/remote", json={"url": KAGGLE})
        self.assertEqual(res.status_code, 502)
        self.assertEqual(self.app.get("/api/ai/status").json()["mode"], "local")

    def test_kaggle_going_offline_is_reported(self):
        self.app.post("/api/ai/remote", json={"url": KAGGLE})
        self.online = False
        s = self.app.get("/api/ai/status").json()
        self.assertEqual(s["mode"], "kaggle")
        self.assertIn("ulanib bo'lmadi", s["error"])

    def test_panel_has_kaggle_box(self):
        html = self.app.get("/").text
        for marker in ('id="aiRemoteUrl"', 'id="aiRemoteSave"', 'id="aiModeTag"'):
            self.assertIn(marker, html)

    def test_cuda_engine_uses_fp16(self):
        self.assertEqual(AIEngine(device="cuda").quantization, "fp16")
        self.assertEqual(AIEngine(device="cuda").status()["device"], "cuda")


if __name__ == "__main__":
    unittest.main()
