"use strict";
// v0.4.0 — persistent right-side offline AI assistant (DEMO, not medically validated).
(() => {
  const el = id => document.getElementById(id);
  const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const TOPIC_NAMES = {muhit: "Kabina muhiti", ovqat: "Ovqat / suv", sensor: "Sensor xatosi", parvoz: "Parvoz / faoliyat"};
  const STATE_NAMES = {mos: "Ehtimoliy sabab", qarshi: "Rad etilgan", noma_lum: "Ma’lumot yo‘q"};
  const STATE_CLASS = {mos: "attention", qarshi: "", noma_lum: "unknown"};
  const ACTION_TEXT = {
    CHECK_CABIN: ["Kabina havosini tekshirish", "Muhit (havo, CO₂, ventilyatsiya) sabab bo‘lishi mumkin."],
    CHECK_INTAKE: ["Ovqat / suvni tekshirish", "Umumiy ovqat yoki suv manbai sabab bo‘lishi mumkin."],
    VERIFY_SENSOR: ["Sensorni qayta o‘lchash", "Ko‘rsatkich qurilma xatosi bo‘lishi mumkin."],
    CHECK_FLIGHT: ["Parvoz / faoliyat bilan bog‘liqlikni ko‘rish", "Holat, yuklama yoki parvoz bosqichi sabab bo‘lishi mumkin."],
    ASK_CONTEXT: ["Qo‘shimcha ma’lumot kerak", "Hech bir sabab yetarli dalil bilan tasdiqlanmadi."],
    REVIEW_CONFLICT: ["Mutaxassis ko‘rib chiqsin", "Bir nechta sabab bir vaqtda mos keldi."],
    REVIEW_MODEL_OUTPUT: ["Qo‘lda tekshiring", "Ba’zi qaydlarda model ishonchi past."],
  };
  const SPECIFIC = new Set(["CHECK_CABIN", "CHECK_INTAKE", "VERIFY_SENSOR", "CHECK_FLIGHT"]);
  let polling = null, status = null;

  async function call(url, method = "GET", payload) {
    const options = {method, headers: {"Content-Type": "application/json"}};
    if (payload !== undefined) options.body = JSON.stringify(payload);
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.detail && (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail))) || `HTTP ${res.status}`);
    return data;
  }

  function setOpen(open, focus = false) {
    document.body.classList.toggle("ai-open", open);
    el("aiReopen").hidden = open;
    try { localStorage.setItem("astromed.aiOpen", open ? "1" : "0"); } catch (_) {}
    if (open && focus) el("aiRecords").focus({preventScroll: true});
  }

  function renderStatus(s) {
    status = s;
    const pill = el("aiStatusPill"), side = el("aiSidebarStatus");
    let text, cls;
    const kaggle = s.mode === "kaggle";
    el("aiModeTag").textContent = kaggle ? "KAGGLE" : "LOKAL";
    el("aiModeTag").className = "mini-pill " + (kaggle ? (s.error ? "critical" : "") : "unknown");
    if (kaggle && document.activeElement !== el("aiRemoteUrl")) el("aiRemoteUrl").value = s.remote_url || "";
    if (kaggle && s.error) { text = "Kaggle bilan aloqa yo‘q"; cls = "critical"; }
    else if (kaggle && s.loaded) { text = `Kaggle GPU · tayyor · chegara ${s.threshold}`; cls = ""; }
    else if (kaggle && s.loading) { text = "Kaggle: model yuklanmoqda…"; cls = "attention"; }
    else if (kaggle) { text = "Kaggle ulangan · model hali yuklanmagan"; cls = "attention"; }
    else if (!s.available) { text = "Model o‘rnatilmagan"; cls = "unknown"; }
    else if (s.error) { text = "Xato: model yuklanmadi"; cls = "critical"; }
    else if (s.loading) { text = "Model yuklanmoqda…"; cls = "attention"; }
    else if (s.loaded) { text = `Tayyor · chegara ${s.threshold}`; cls = ""; }
    else { text = "O‘rnatilgan · hali yuklanmagan"; cls = "attention"; }
    pill.textContent = text;
    pill.className = "mini-pill " + cls;
    if (side) side.textContent = kaggle ? (s.error ? "KAGGLE: ALOQA YO‘Q" : s.loaded ? "KAGGLE GPU · TAYYOR" : "KAGGLE ULANGAN") : !s.available ? "O‘RNATILMAGAN" : s.loaded ? "TAYYOR (DEMO)" : "O‘RNATILGAN (DEMO)";
    el("aiLoadButton").hidden = !(s.available && !s.loaded && !s.loading);
    el("aiRun").disabled = !s.available;
    if (!s.available && !el("aiResult").dataset.filled) {
      const missing = Object.entries(s.files || {}).filter(([, ok]) => !ok).map(([k]) => k).join(", ");
      el("aiResult").innerHTML = `<div class="empty">AI modeli bu kompyuterga hali o‘rnatilmagan (${safe(missing)}).<br>Yoki yuqoridagi “Kaggle GPU ulanishi” ga server manzilini qo‘ying.<br>O‘rnatish: <code>run_windows.bat --setup-ai</code><br>Batafsil: README → “AstroAI”.</div>`;
    }
    if (s.error && !el("aiResult").dataset.filled) el("aiResult").innerHTML = `<div class="empty">${safe(s.error)}</div>`;
    if (!kaggle && s.available && !s.error && el("aiResult").dataset.filled !== "1" && /Kaggle|o‘rnatilmagan/.test(el("aiResult").textContent)) el("aiResult").innerHTML = `<div class="empty">Qaydlarni kiriting va “Tahlil qilish”ni bosing.</div>`;
  }

  async function refreshStatus() {
    try { renderStatus(await call("/api/ai/status")); } catch (_) { el("aiStatusPill").textContent = "Server bilan aloqa yo‘q"; }
  }

  function parseRecords(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Kamida bitta qayd kiriting.");
    if (lines.length > 12) throw new Error("Ko‘pi bilan 12 ta qayd.");
    const records = {};
    lines.forEach((line, i) => {
      const m = line.match(/^([A-Za-z0-9_-]{1,12})\s*[:)]\s*(.+)$/);  // "E3: matn" format ham qabul qilinadi
      records[m ? m[1] : `Q${i + 1}`] = m ? m[2] : line;
    });
    return records;
  }

  function renderResult(r, auto) {
    const [title, note] = ACTION_TEXT[r.harakat] || [r.harakat, ""];
    const actCls = SPECIFIC.has(r.harakat) ? "" : r.harakat === "ASK_CONTEXT" ? "ask" : "review";
    const topics = Object.entries(r.ehtimollar).map(([topic, item]) => {
      const ref = (item.dalil || [])[0];
      const rec = ref && r.qaydlar[ref];
      const conf = item.ishonch != null ? ` · ${Math.round(item.ishonch * 100)}%` : "";
      return `<div class="ai-topic"><span class="t">${safe(TOPIC_NAMES[topic] || topic)}</span>
        <span class="mini-pill ${STATE_CLASS[item.holat] || ""}">${safe(STATE_NAMES[item.holat] || item.holat)}${conf}</span>
        ${rec ? `<span class="why">Dalil ${safe(ref)}: ${safe(rec.matn)}</span>` : ""}</div>`;
    }).join("");
    const low = r.past_ishonch && r.past_ishonch.length
      ? `<div class="ai-action review"><small>Past ishonch</small><b>${safe(r.past_ishonch.join(", "))}</b><small>Bu qaydlar bo‘yicha xulosa chiqarilmadi.</small></div>` : "";
    const records = Object.entries(r.qaydlar).map(([ref, q]) =>
      `<li><b>${safe(ref)}</b> → ${safe(q.sinf)} (${Math.round(q.ishonch * 100)}%)<br>${safe(q.matn)}<br><em>EN: ${safe(q.tarjima)}</em></li>`).join("");
    el("aiResult").dataset.filled = "1";
    const autoHead = auto ? `<div class="ai-auto-head"><span class="mini-pill ${auto.level === "critical" ? "critical" : "attention"}">AVTO · ${auto.level === "critical" ? "XAVF" : "E’TIBOR"}</span> <small>${safe(new Date(auto.finished * 1000).toLocaleTimeString("uz-UZ"))} · ${Object.keys(auto.records).length} qayd · jurnalga yozildi</small></div>` : "";
    el("aiResult").innerHTML = autoHead + `
      <div class="ai-action ${actCls}"><small>Tavsiya etilgan ko‘rib chiqish</small><b>${safe(title)}</b><small>${safe(note)}</small></div>
      ${low}${topics}
      <details class="ai-records"><summary>Har bir qayd tafsiloti · ${safe(r.sekund)} s</summary><ul>${records}</ul></details>
      <p class="ai-warning">${safe(r.ogohlantirish)}</p>`;
  }

  function showProgress(job) {
    el("aiProgress").hidden = false;
    el("aiBar").style.width = `${Math.round((job.progress || 0) * 100)}%`;
    const secs = Math.round((Date.now() - showProgress.started) / 1000);
    el("aiStage").textContent = `${job.stage || "…"} · ${secs} s`;
  }

  async function run() {
    let records;
    try { records = parseRecords(el("aiRecords").value); } catch (err) { el("aiResult").innerHTML = `<div class="empty">${safe(err.message)}</div>`; return; }
    el("aiRun").disabled = true;
    manualBusy = true;
    showProgress.started = Date.now();
    try {
      const job = await call("/api/ai/analyze", "POST", {records});
      showProgress(job);
      clearInterval(polling);
      polling = setInterval(async () => {
        try {
          const j = await call(`/api/ai/jobs/${encodeURIComponent(job.job_id)}`);
          showProgress(j);
          if (j.status === "done" || j.status === "error") {
            clearInterval(polling);
            manualBusy = false;
            el("aiProgress").hidden = true;
            el("aiRun").disabled = false;
            if (j.status === "done") renderResult(j.result);
            else el("aiResult").innerHTML = `<div class="empty">Tahlil bajarilmadi: ${safe(j.error)}</div>`;
            refreshStatus();
          }
        } catch (err) {
          clearInterval(polling); manualBusy = false; el("aiProgress").hidden = true; el("aiRun").disabled = false;
          el("aiResult").innerHTML = `<div class="empty">${safe(err.message)}</div>`;
        }
      }, 1500);
    } catch (err) {
      manualBusy = false;
      el("aiRun").disabled = false;
      el("aiResult").innerHTML = `<div class="empty">${safe(err.message)}</div>`;
    }
  }

  async function setRemote(url) {
    el("aiRemoteSave").disabled = true;
    try {
      const s = await call("/api/ai/remote", "POST", {url});
      delete el("aiResult").dataset.filled;
      el("aiResult").innerHTML = `<div class="empty">${url ? "Kaggle serveriga ulandi. Endi “Tahlil qilish” Kaggle GPU’da bajariladi." : "Kaggle uzildi. Laptopdagi model ishlatiladi."}</div>`;
      renderStatus(s);
      if (url && !s.loaded && !s.loading) { try { renderStatus(await call("/api/ai/load", "POST")); } catch (_) {} }
    } catch (err) {
      el("aiResult").innerHTML = `<div class="empty">Ulanmadi: ${safe(err.message)}</div>`;
    } finally { el("aiRemoteSave").disabled = false; }
  }
  el("aiRemoteSave").addEventListener("click", () => {
    const url = el("aiRemoteUrl").value.trim();
    if (!url) { el("aiResult").innerHTML = `<div class="empty">Avval Kaggle server manzilini kiriting.</div>`; return; }
    setRemote(url);
  });
  el("aiRemoteClear").addEventListener("click", () => { el("aiRemoteUrl").value = ""; setRemote(""); });
  setInterval(() => { if (status && (status.mode === "kaggle" || status.loading)) refreshStatus(); }, 15000);

  // ---- automatic analysis while the mission is at risk (runs on the server) ----
  let autoShown = null, manualBusy = false;
  function fillRecords(records) {
    el("aiRecords").value = Object.entries(records).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  async function pollAuto() {
    let a;
    try { a = await call("/api/ai/auto"); } catch (_) { return; }
    el("aiAutoToggle").checked = a.enabled;
    const tag = el("aiAutoTag");
    if (!a.enabled) { tag.textContent = "O‘CHIQ"; tag.className = "mini-pill unknown"; }
    else if (!a.available) { tag.textContent = "MODEL YO‘Q"; tag.className = "mini-pill unknown"; }
    else if (a.current) { tag.textContent = "TAHLIL QILMOQDA"; tag.className = "mini-pill attention"; }
    else { tag.textContent = "KUZATMOQDA"; tag.className = "mini-pill"; }
    if (manualBusy) return;
    if (a.current && autoShown !== a.current.job_id + ":run") {
      autoShown = a.current.job_id + ":run";
      setOpen(true);
      fillRecords(a.current.records);
      showProgress.started = a.current.started * 1000;
    }
    if (a.current) { showProgress({stage: "AVTO: " + (a.current.stage || "navbatda"), progress: a.current.progress}); return; }
    if (a.last && autoShown !== a.last.job_id + ":done") {
      const fresh = autoShown && autoShown.startsWith(a.last.job_id);
      autoShown = a.last.job_id + ":done";
      el("aiProgress").hidden = true;
      if (!fresh && Date.now() / 1000 - a.last.finished > 120) return;  // old result from before page load
      fillRecords(a.last.records);
      if (a.last.status === "done") renderResult(a.last.result, a.last);
      else el("aiResult").innerHTML = `<div class="empty">Avtomatik tahlil bajarilmadi: ${safe(a.last.error)}</div>`;
    }
  }
  el("aiAutoToggle").addEventListener("change", async () => {
    try { await call("/api/ai/auto", "POST", {enabled: el("aiAutoToggle").checked}); } catch (_) {}
    pollAuto();
  });
  setInterval(pollAuto, 4000);
  pollAuto();

  el("aiCollapse").addEventListener("click", () => setOpen(false));
  el("aiReopen").addEventListener("click", () => setOpen(true, true));
  el("aiRun").addEventListener("click", run);
  el("aiClear").addEventListener("click", () => { el("aiRecords").value = ""; el("aiRecords").focus(); });
  el("aiDemo").addEventListener("click", async () => {
    try {
      const {records} = await call("/api/ai/demo");
      el("aiRecords").value = Object.entries(records).map(([k, v]) => `${k}: ${v}`).join("\n");
    } catch (err) { el("aiResult").innerHTML = `<div class="empty">${safe(err.message)}</div>`; }
  });
  el("aiLoadButton").addEventListener("click", async () => {
    try { renderStatus(await call("/api/ai/load", "POST")); } catch (err) { el("aiResult").innerHTML = `<div class="empty">${safe(err.message)}</div>`; }
    const t = setInterval(async () => { await refreshStatus(); if (status && !status.loading) clearInterval(t); }, 3000);
  });
  let startOpen = true;
  try { startOpen = localStorage.getItem("astromed.aiOpen") !== "0"; } catch (_) {}
  setOpen(startOpen && window.innerWidth > 790);
  refreshStatus();
})();
