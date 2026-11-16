"""Run the AI assistant on a Kaggle GPU while the AstroVital UI stays on the laptop.

Kaggle side:  ``create_ai_server(engine)`` exposes only the /api/ai/* routes.
Laptop side:  ``HybridEngine`` forwards analyses to that server when a URL is
set in the AI panel, and falls back to the local offline model otherwise.
Only the crew records typed into the AI panel are sent to Kaggle.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from .ai_engine import AIEngine, JobManager, validate_records

HttpFn = Callable[[str, str, dict | None, float], dict]


class RemoteError(RuntimeError):
    pass


def urllib_http(method: str, url: str, payload: dict | None = None, timeout: float = 15) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "AstroVital/0.4"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode()).get("detail")
        except Exception:
            detail = None
        raise RemoteError(f"Kaggle server xatosi {exc.code}: {detail or exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RemoteError(f"Kaggle serveriga ulanib bo'lmadi: {getattr(exc, 'reason', exc)}") from exc


def clean_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Manzil https://... ko'rinishida bo'lishi kerak")
    return url


class RemoteEngine:
    """Same interface as AIEngine, but the work happens on the Kaggle server."""

    def __init__(self, url: str, http: HttpFn = urllib_http, poll_seconds: float = 1.0, max_wait: float = 600):
        self.url = clean_url(url)
        self.http = http
        self.poll_seconds = poll_seconds
        self.max_wait = max_wait
        self.error: str | None = None
        self.last: dict = {}

    @property
    def available(self) -> bool:
        return True

    @property
    def loaded(self) -> bool:
        return bool(self.last.get("loaded"))

    @property
    def loading(self) -> bool:
        return bool(self.last.get("loading"))

    def status(self) -> dict:
        try:
            self.last = self.http("GET", self.url + "/api/ai/status", None, 10)
            self.error = self.last.get("error")
        except RemoteError as exc:
            self.last, self.error = {}, str(exc)
        return {**self.last, "available": True, "loaded": self.loaded, "loading": self.loading,
                "error": self.error, "mode": "kaggle", "remote_url": self.url,
                "medical_approval": "NOT_VALIDATED"}

    def load(self) -> None:
        self.last = self.http("POST", self.url + "/api/ai/load", None, 15)

    def analyze(self, records: dict, progress: Callable[[str, float], None] | None = None) -> dict:
        records = validate_records(records)
        progress = progress or (lambda *_: None)
        progress("Kaggle serveriga yuborilmoqda", 0.03)
        job = self.http("POST", self.url + "/api/ai/analyze", {"records": records}, 30)
        start = time.time()
        while True:
            if time.time() - start > self.max_wait:
                raise RemoteError("Kaggle serveri javob bermadi (vaqt tugadi)")
            job = self.http("GET", f"{self.url}/api/ai/jobs/{job['job_id']}", None, 15)
            if job["status"] == "done":
                result = job["result"]
                result["manba"] = "Kaggle GPU"
                return result
            if job["status"] == "error":
                raise RemoteError(job.get("error") or "Kaggle'da tahlil bajarilmadi")
            progress("Kaggle: " + (job.get("stage") or "kutilmoqda"), max(0.05, float(job.get("progress") or 0)))
            time.sleep(self.poll_seconds)


class HybridEngine:
    """Local offline model by default; Kaggle when a server URL is saved."""

    def __init__(self, local: AIEngine | None = None, settings_path: Path | None = None, http: HttpFn = urllib_http):
        self.local = local or AIEngine()
        self.settings_path = Path(settings_path) if settings_path else None
        self.http = http
        self.remote: RemoteEngine | None = None
        if self.settings_path and self.settings_path.is_file():
            try:
                url = json.loads(self.settings_path.read_text(encoding="utf-8")).get("remote_url")
                if url:
                    self.remote = RemoteEngine(url, http=http)
            except (ValueError, OSError):
                self.remote = None

    @property
    def active(self):
        return self.remote or self.local

    @property
    def available(self) -> bool:
        return self.active.available

    @property
    def loaded(self) -> bool:
        return self.active.loaded

    @property
    def loading(self) -> bool:
        return self.active.loading

    def status(self) -> dict:
        if self.remote:
            return self.remote.status()
        return {**self.local.status(), "mode": "local", "remote_url": None}

    def load(self) -> None:
        self.active.load()

    def analyze(self, records: dict, progress=None) -> dict:
        return self.active.analyze(records, progress)

    def set_remote(self, url: str | None) -> dict:
        """Save (or clear with an empty url) the Kaggle server address and test it."""
        if not url:
            self.remote = None
            self._save(None)
            return self.status()
        remote = RemoteEngine(url, http=self.http)
        remote.http("GET", remote.url + "/api/ai/status", None, 10)  # raises RemoteError if unreachable
        self.remote = remote
        self._save(remote.url)
        return self.status()

    def _save(self, url: str | None) -> None:
        if self.settings_path:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            self.settings_path.write_text(json.dumps({"remote_url": url}), encoding="utf-8")


try:  # module level so FastAPI can resolve the annotation (future annotations are strings)
    from pydantic import BaseModel, Field

    class AnalyzeRequest(BaseModel):
        records: dict[str, str] = Field(min_length=1, max_length=12)
except ImportError:  # pragma: no cover
    AnalyzeRequest = None


def create_ai_server(engine: AIEngine):
    """Minimal FastAPI app for the Kaggle notebook: only the AI routes."""
    import threading
    from fastapi import FastAPI, HTTPException

    jobs = JobManager(engine)
    app = FastAPI(title="AstroAI server (Kaggle, DEMO)")

    @app.get("/")
    def root():
        return {"service": "AstroAI", "status": engine.status()}

    @app.get("/api/ai/status")
    def status():
        return engine.status()

    @app.post("/api/ai/load", status_code=202)
    def load():
        if not engine.loaded and not engine.loading:
            threading.Thread(target=lambda: _quiet(engine.load), daemon=True).start()
        return engine.status()

    @app.post("/api/ai/analyze", status_code=202)
    def analyze(payload: AnalyzeRequest):
        try:
            return jobs.submit(payload.records)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/ai/jobs/{job_id}")
    def job(job_id: str):
        try:
            return jobs.get(job_id)
        except KeyError:
            raise HTTPException(404, "AI vazifasi topilmadi")

    return app


def _quiet(fn):
    try:
        fn()
    except Exception:
        pass
