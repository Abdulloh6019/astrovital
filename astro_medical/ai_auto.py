"""Automatic AI review when the mission is at risk (DEMO, not medically validated).

Every monitoring step the server checks the mission level. While it is
"attention" or "critical", the current alerts, symptoms, shared findings and
equipment faults are turned into short Uzbek records and analysed by the AI
assistant (local model or Kaggle GPU). A new analysis starts only when the
situation changes; finished results are written to the event journal.
"""
from __future__ import annotations

import threading
import time

from .ai_engine import MAX_RECORD_CHARS, MAX_RECORDS

RISK_LEVELS = ("attention", "critical")
SYSTEM_NAMES = {"scrubber_ok": "CO₂ tozalash uskunasi", "hab_fan_ok": "HAB ventilyatori"}
ACTION_NAMES = {
    "CHECK_CABIN": "kabina havosini tekshirish", "CHECK_INTAKE": "ovqat/suvni tekshirish",
    "VERIFY_SENSOR": "sensorni qayta o'lchash", "CHECK_FLIGHT": "parvoz/faoliyat bilan bog'liqlikni ko'rish",
    "ASK_CONTEXT": "qo'shimcha ma'lumot kerak", "REVIEW_CONFLICT": "mutaxassis ko'rib chiqsin",
    "REVIEW_MODEL_OUTPUT": "past ishonch — qo'lda tekshirish",
}


def _clip(text: str) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= MAX_RECORD_CHARS else text[:MAX_RECORD_CHARS - 1] + "…"


def build_records(status: dict) -> dict[str, str]:
    """Turn the live mission picture into at most 12 short Uzbek crew-log records."""
    crew = {p["crew_id"]: p for p in status.get("crew", [])}
    zones = {z["zone_id"]: z for z in status.get("zones", [])}
    labels = status.get("symptom_labels", {})
    lines: list[str] = []

    for f in status.get("shared_findings", []):
        evidence = "; ".join(f.get("evidence", [])[:3])
        lines.append(f"Umumiy holat: {f['title']}. {f.get('interpretation', '')} Dalil: {evidence}")
    alerts = sorted(status.get("active_alerts", []), key=lambda a: a.get("severity") != "critical")
    for a in alerts:
        if a.get("scope") == "crew" and a.get("subject_id") in crew:
            p = crew[a["subject_id"]]
            lines.append(f"{p['name']} ({p['crew_id']}, {p['zone_id']} moduli): {a['title']}. {a.get('description', '')}")
        elif a.get("scope") == "zone":
            name = zones.get(a.get("subject_id"), {}).get("name", a.get("subject_id"))
            lines.append(f"{name} ({a.get('subject_id')}): {a['title']}. {a.get('description', '')}")
        else:
            lines.append(f"{a['title']}. {a.get('description', '')}")
    for p in crew.values():
        for s in p.get("symptoms", []):
            lines.append(f"{p['name']} ({p['zone_id']} moduli) {labels.get(s, s).lower()} haqida xabar berdi.")
    for key, point in (status.get("mission", {}).get("systems") or {}).items():
        if isinstance(point, dict) and point.get("value") == 0:
            lines.append(f"{SYSTEM_NAMES.get(key, key)} nosozlik signali berdi.")

    unique = list(dict.fromkeys(_clip(l) for l in lines if l.strip()))[:MAX_RECORDS]
    return {f"A{i + 1}": text for i, text in enumerate(unique)}


def situation_signature(status: dict) -> tuple:
    # Severity changes are covered by the mission level; short-lived trend alerts are ignored
    # so the same episode is not re-analysed every few seconds.
    alerts = sorted({(a.get("code"), a.get("subject_id")) for a in status.get("active_alerts", [])
                     if not str(a.get("code", "")).startswith("TREND_")})
    findings = sorted(f.get("code") for f in status.get("shared_findings", []))
    symptoms = sorted((p["crew_id"], s) for p in status.get("crew", []) for s in p.get("symptoms", []))
    return (status.get("level"), tuple(alerts), tuple(findings), tuple(symptoms))


class AutoAnalyzer:
    def __init__(self, service, engine, jobs, enabled: bool = True):
        self.service = service
        self.engine = engine
        self.jobs = jobs
        self.enabled = enabled
        self._lock = threading.Lock()
        self.signature: tuple | None = None
        self.current: dict | None = None     # running auto job
        self.last: dict | None = None        # last finished auto job
        self.runs = 0

    def public(self) -> dict:
        def view(item):
            if not item:
                return None
            job = self.jobs.jobs.get(item["job_id"], {})
            return {**item, "status": job.get("status", item.get("status")), "stage": job.get("stage"),
                    "progress": job.get("progress"), "result": job.get("result", item.get("result")),
                    "error": job.get("error", item.get("error"))}
        return {"enabled": self.enabled, "available": bool(self.engine.available), "runs": self.runs,
                "levels": list(RISK_LEVELS), "current": view(self.current), "last": view(self.last)}

    def set_enabled(self, enabled: bool) -> dict:
        self.enabled = bool(enabled)
        if not self.enabled:
            self.signature = None
        return self.public()

    def tick(self, status: dict | None = None) -> dict | None:
        """Called after every monitoring step; returns a newly started job, if any."""
        with self._lock:
            self._collect_finished()
            if not self.enabled or not self.engine.available:
                return None
            status = status or self.service.status()
            if status.get("level") not in RISK_LEVELS:
                self.signature = None          # next risk episode triggers a fresh analysis
                return None
            sig = situation_signature(status)
            if sig == self.signature or self.current:
                return None
            records = build_records(status)
            if not records:
                return None
            job = self.jobs.submit(records)
            self.signature = sig
            self.runs += 1
            self.current = {"job_id": job["job_id"], "started": time.time(), "level": status["level"],
                            "records": records, "status": job["status"]}
            return self.current

    def _collect_finished(self) -> None:
        if not self.current:
            return
        job = self.jobs.jobs.get(self.current["job_id"])
        if not job or job["status"] not in ("done", "error"):
            return
        done = {**self.current, "status": job["status"], "result": job["result"], "error": job["error"],
                "finished": time.time()}
        self.last, self.current = done, None
        self._log(done)

    def _log(self, done: dict) -> None:
        level = "critical" if done["level"] == "critical" else "attention"
        if done["status"] == "done":
            r = done["result"]
            supported = [t for t, v in r.get("ehtimollar", {}).items() if v.get("holat") == "mos"]
            msg = (f"AstroAI avtomatik tahlil ({len(done['records'])} qayd, {r.get('manba', 'lokal model')}): "
                   f"{ACTION_NAMES.get(r.get('harakat'), r.get('harakat'))}"
                   + (f"; ehtimoliy sabab: {', '.join(supported)}" if supported else "")
                   + ". DEMO, tibbiy tasdiqlanmagan.")
            self.service.record_event("AI_ANALYSIS", level, r.get("harakat", "AI"), msg)
        else:
            self.service.record_event("AI_ANALYSIS", "attention", "AI_ERROR",
                                      f"AstroAI avtomatik tahlil bajarilmadi: {done['error']}")
