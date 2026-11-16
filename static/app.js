"use strict";
// AstroVital v0.4.0 — AstroVital-style glass-cockpit UI on the unchanged AstroVital API.
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
// [key, title, scale min, scale max, nominal low, nominal high, caution low, caution high]
// Bands mirror the DEMO rule thresholds in rules.py; they are display aids, not diagnosis.
const vitalSpecs = [
  ["heart_rate","Yurak urishi",30,170,50,115,40,135],
  ["spo2","Qondagi kislorod SpO₂",80,100,94,100,90,100],
  ["systolic_bp","Sistolik bosim",70,200,95,160,85,180],
  ["diastolic_bp","Diastolik bosim",40,120,60,90,50,100],
  ["body_temp","Tana harorati",33,41,35.5,38.5,34,40],
  ["resp_rate","Nafas tezligi",4,36,10,23,7,30],
  ["ecg_irregular","EKG: noto‘g‘ri urishlar",0,20,0,6,0,12],
  ["hrv","Yurak ritmi o‘zgaruvchanligi (HRV)",0,80,25,80,15,80],
  ["glucose","Qondagi glyukoza",40,300,70,180,54,250],
  ["fatigue","Charchoq indeksi",0,100,0,60,0,80],
  ["sleep_hours","Oxirgi uyqu",0,10,6,10,4.5,10],
  ["rad_dose_rate","Radiatsiya dozasi tezligi",0,15,0,1,0,10]
];
const MANUAL_FIELDS = [
  ["heart_rate","Puls","bpm",1],["spo2","SpO₂","%",0.1],["systolic_bp","Sistolik","mmHg",1],["diastolic_bp","Diastolik","mmHg",1],
  ["body_temp","Harorat","°C",0.1],["resp_rate","Nafas","/min",1],["ecg_irregular","EKG noto‘g‘ri","/min",1],["hrv","HRV","ms",1],
  ["glucose","Glyukoza","mg/dL",1],["fatigue","Charchoq","/100",1],["sleep_hours","Uyqu","soat",0.1],
  ["rad_dose_rate","Doza tezligi","mSv/kun",0.01],["rad_dose_total","Jami doza","mSv",0.1]
];
let manualFor = null;
function renderManual(person) {
  if (manualFor !== person.crew_id) {
    manualFor = person.crew_id;
    $("manualFields").innerHTML = MANUAL_FIELDS.map(([k,label,unit,step]) =>
      `<label class="mfield" data-key="${k}"><span>${esc(label)} <small>${esc(unit)}</small></span>
        <input type="number" step="${step}" inputmode="decimal" name="${k}" /></label>`).join("");
  }
  const manual = new Set(person.manual || []);
  MANUAL_FIELDS.forEach(([k]) => {
    const box = $("manualFields").querySelector(`[data-key="${k}"]`);
    box.classList.toggle("on", manual.has(k));
    box.querySelector("input").placeholder = showNum(person.vitals[k], k === "rad_dose_rate" ? 2 : 1);
  });
  $("manualState").textContent = manual.size ? `Qo‘lda: ${manual.size} ta` : "Sensor";
  $("manualState").className = "mini-pill " + (manual.size ? "attention" : "unknown");
}
const CAREER_LIMIT = 600; // mSv, DEMO career limit (shown for orientation only)
const cabinSpecs = [
  ["o2_partial","O₂ bosimi"], ["co2_partial","CO₂ bosimi"], ["pressure","Kabina bosimi"],
  ["temperature","Harorat"], ["humidity","Namlik"], ["radiation","Radiatsiya"]
];
const levelNames = {normal:"Barqaror",attention:"E’tibor",critical:"Xavf",unknown:"Noma’lum"};
const levelNum = {normal:0,attention:1,critical:2,unknown:1};
const sevNum = s => s === "critical" ? 2 : 1;
let state = null;
let selectedCrew = null;
let initialized = false;
let inFlight = false;
let activeView = 'overview';
let lastCrewSignature = '';
let viewLoadEpoch = 0;
let refreshTimer = null;
let refreshAfterFlight = false;
const viewGroups = {
  overview: 'overview', 'crew-section':'crew', individual:'crew',
  shared:'environment', zones:'environment', emergency:'emergency',
  alerts:'history', events:'history'
};
const viewDetails = {
  overview:['Missiya holati','Hozirgi holat va birinchi navbatdagi tekshiruvlar'],
  'crew-section':['Ekipaj a’zolari','Ekipaj tarkibi va umumiy sog‘liq holati'],
  individual:['Tibbiy ko‘rsatkichlar','Tanlangan kosmonavtning individual ko‘rsatkichlari va trendlari'],
  shared:['Umumiy sababni tekshirish','Ekipaj, kabina va texnik holatlarning kesishma tahlili'],
  zones:['Kabina modullari','HAB/LAB atmosferasi va uskunalari'],
  emergency:['Favqulodda yordam','DEMO protokollar va lokal hodisalar boshqaruvi'],
  alerts:['Faol ogohlantirishlar','Sensor va tahlil qoidalari yaratgan signallar'],
  events:['Hodisalar tarixi','SQLite jurnali va kosmonavt ismlari']
};
const groupTabs = {
  crew: [['crew-section','Ekipaj ro‘yxati'],['individual','Tibbiy ko‘rsatkichlar']],
  environment: [['shared','Umumiy sabab'],['zones','Kabina va uskunalar']],
  history: [['alerts','Ogohlantirishlar'],['events','Hodisalar tarixi']]
};

async function api(url, method="GET", payload) {
  const options = {method, headers:{"Content-Type":"application/json"}};
  if (payload !== undefined) options.body = JSON.stringify(payload);
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return await res.json();
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => $("toast").classList.add("hidden"), 4400);
}
const numberOf = point => point && point.quality === "good" && typeof point.value === "number" ? point.value : null;
const showNum = (point, digits) => {
  const value = numberOf(point);
  return value === null ? "—" : Number(value.toFixed(digits ?? 1)).toLocaleString("uz-UZ");
};
const pct = (v, lo, hi) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
function rangeBar(v, lo, hi, nLo, nHi, cLo, cHi) {
  const marker = v === null ? "" : `<b style="left:${pct(v, lo, hi).toFixed(1)}%"></b>`;
  return `<div class="range"><i class="c" style="left:${pct(cLo,lo,hi)}%;right:${100-pct(cHi,lo,hi)}%"></i>
    <i class="n" style="left:${pct(nLo,lo,hi)}%;right:${100-pct(nHi,lo,hi)}%"></i>${marker}</div>`;
}
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Small count-up animation for headline numbers (skipped when reduced motion is requested).
function countTo(el, to) {
  const from = Number(el.dataset.v ?? el.textContent) || 0;
  el.dataset.v = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = String(to); return; }
  const start = performance.now(), dur = 500;
  const step = now => {
    const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * e));
    if (t < 1 && el.dataset.v == to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function alertButtons(a) {
  return `<span class="row acts"><button class="link-button" type="button" data-protocol="${esc(a.protocol_id)}">Yo‘riqnoma ↗</button>
    <button class="btn small" type="button" data-start-protocol="${esc(a.protocol_id)}" data-start-crew="${esc(a.scope==='crew'?a.subject_id:'')}" data-start-zones="${esc(a.scope==='zone'?a.subject_id:'')}" data-start-code="${esc(a.code)}">+ Hodisa</button></span>`;
}
function todoItems(alerts, status) {
  if (!alerts.length) return `<li class="todo-empty">Faol ogohlantirish yo‘q. Kuzatuv davom etmoqda.</li>`;
  const names = Object.fromEntries((status?.crew || []).map(p => [p.crew_id, p.name]));
  return alerts.slice(0, 8).map(a => `<li data-level="${sevNum(a.severity)}"><div>
      <div class="what">${esc(names[a.subject_id] || a.subject_id)} · ${a.severity === "critical" ? "Xavf" : "E’tibor"}</div>
      <div class="say"><b>${esc(a.title)}</b> — ${esc(a.description)}</div>${alertButtons(a)}</div></li>`).join("");
}

function renderCrewNav(crew) {
  const ids = new Set(crew.map(p=>p.crew_id));
  if (!ids.has(selectedCrew)) selectedCrew = crew[0]?.crew_id ?? null;
  $("crewNav").innerHTML = crew.map(p => `<button type="button" data-crew="${esc(p.crew_id)}" aria-pressed="${p.crew_id===selectedCrew}">
      <span class="pip" style="background:var(--${p.level==='critical'?'warning':p.level==='attention'?'caution':'nominal'})"></span>
      <span class="who">${esc(p.name)}</span><span class="score">${p.active_alert_count}</span>
      <span class="role">${esc(p.crew_id)} · ${esc(p.zone_id)}</span></button>`).join("");
}
function renderCrew(crew) {
  $("crewGrid").innerHTML = crew.length ? crew.map(p => `<li class="${p.crew_id===selectedCrew?'editing':''}">
      <div class="c-head"><span class="c-name">${esc(p.name)}</span><span class="tag" data-level="${levelNum[p.level]??1}">${esc(levelNames[p.level] || p.level)}</span></div>
      <div class="c-meta">${esc(p.crew_id)} · ${esc(p.zone_id)} · ${p.active_alert_count} ogohlantirish</div>
      <div class="c-tags"><span class="tagc">♡ ${showNum(p.vitals.heart_rate,0)} bpm</span><span class="tagc">SpO₂ ${showNum(p.vitals.spo2,1)} %</span>
        <span class="tagc">☢ ${showNum(p.vitals.rad_dose_total,0)} mSv</span><span class="tagc">Glyukoza ${showNum(p.vitals.glucose,0)}</span>
        ${(p.symptoms||[]).map(s=>`<span class="tagc alg">${esc(state?.symptom_labels?.[s]||s)}</span>`).join("")}</div>
      <div class="row"><button class="btn" type="button" data-crew="${esc(p.crew_id)}" data-open="individual">Ko‘rsatkichlar</button>
        <button class="btn" type="button" data-crew="${esc(p.crew_id)}">Tanlash</button></div></li>`).join("")
    : `<li class="todo-empty">Ekipaj ro‘yxati bo‘sh. O‘ngdagi forma orqali qo‘shing.</li>`;
}
function renderMetrics(person, alerts) {
  if (!person) { $("vitalGrid").innerHTML = `<div class="empty">Ekipaj a’zosi tanlanmagan.</div>`; return; }
  $("individualTitle").textContent = person.name + " — tibbiy monitoring";
  $("individualZone").textContent = person.crew_id + " · " + person.zone_id;
  const mine = alerts.filter(a=>a.scope==="crew" && a.subject_id===person.crew_id);
  const flagged = {
    spo2:["LOW_SPO2","TREND_SPO2_DOWN"], heart_rate:["HIGH_HEART_RATE","TREND_HR_UP"],
    resp_rate:["HIGH_RESP_RATE","LOW_RESP_RATE","TREND_RR_UP"], systolic_bp:["HIGH_BP","LOW_BP"],
    body_temp:["HIGH_BODY_TEMP","LOW_BODY_TEMP"],
    ecg_irregular:["ECG_IRREGULAR"], hrv:["LOW_HRV"], glucose:["LOW_GLUCOSE","HIGH_GLUCOSE"],
    fatigue:["HIGH_FATIGUE"], sleep_hours:["LOW_SLEEP"], rad_dose_rate:["HIGH_DOSE_RATE"]
  };
  $("vitalGrid").innerHTML = vitalSpecs.map(([key, title, lo, hi, nLo, nHi, cLo, cHi])=>{
    const item = person.vitals[key], v = numberOf(item);
    const hits = mine.filter(a=>(flagged[key]||[]).includes(a.code));
    const level = hits.length ? Math.max(...hits.map(a=>sevNum(a.severity))) : 0;
    return `<div class="strip" data-level="${level}">
      <div><span class="name">${esc(title)}</span><span class="src ${(item?.sensor_id||"").startsWith("MANUAL-")?"manual":""}">${(item?.sensor_id||"").startsWith("MANUAL-") ? "✎ qo‘lda kiritilgan" : esc(item?.sensor_id || "sensor yo‘q")}${v===null?" · signal yo‘q":""}</span></div>
      <div class="val">${showNum(item, 1)}<small>${esc(item?.unit)}</small></div>
      ${rangeBar(v, lo, hi, nLo, nHi, cLo, cHi)}
      <span class="src">${hits.map(a=>esc(a.title)).join(", ") || "sinov chegarasida"}</span></div>`;
  }).join("");
  $("personAlerts").innerHTML = todoItems(mine, state);
  renderManual(person);
  const dose = numberOf(person.vitals.rad_dose_total), rate = numberOf(person.vitals.rad_dose_rate);
  const doseLevel = mine.some(a=>a.code==="CAREER_DOSE"&&a.severity==="critical") ? 2 : mine.some(a=>a.code==="CAREER_DOSE") ? 1 : 0;
  $("doseCard").dataset.level = doseLevel;
  $("doseCard").innerHTML = dose === null ? `<div class="empty">Dozimetr ma’lumoti yo‘q.</div>` : `
    <div class="readout"><span class="big" id="doseNum">${dose.toFixed(1)}</span><span class="unit">mSv jami</span>
      <span class="tag" data-level="${doseLevel}">${["Me’yor","Limitga yaqin","Limitdan oshdi"][doseLevel]}</span></div>
    <div class="meter"><i style="width:${Math.min(100, dose / CAREER_LIMIT * 100).toFixed(1)}%"></i><b style="left:75%"></b></div>
    <div class="meter-foot"><span>0</span><span>450 (75%)</span><span>${CAREER_LIMIT} mSv</span></div>
    <p class="sub">Hozirgi tezlik: <b>${rate === null ? "—" : rate.toFixed(2)} mSv/kun</b> · limitgacha ${Math.max(0, CAREER_LIMIT - dose).toFixed(0)} mSv qoldi. Har namuna = 1 missiya soati (DEMO).</p>`;
  const current = new Set(person.symptoms || []);
  $("symptomList").innerHTML = Object.entries(state?.symptom_labels || {}).map(([v,label]) =>
    `<label><input type="checkbox" value="${esc(v)}" ${current.has(v)?"checked":""}> ${esc(label)}</label>`).join("");
}
function readout(z, key, digits, lo, nHi, cHi) {
  const p = z.sensors[key], v = numberOf(p);
  const level = v === null ? 1 : v >= cHi ? 2 : v >= nHi ? 1 : 0;
  return `<div class="readout"><span class="big">${showNum(p, digits)}</span><span class="unit">${esc(p?.unit)} · ${esc(z.zone_id)}</span>
    <span class="tag" data-level="${level}">${v===null?"Signal yo‘q":["Me’yor","E’tibor","Xavf"][level]}</span></div>
    ${rangeBar(v, lo, cHi * 1.3, lo, nHi, lo, cHi)}`;
}
function renderOverview(status) {
  const n = status.active_alerts.length, lvl = levelNum[status.level] ?? 1;
  $("overallBox").dataset.level = lvl; $("todo").dataset.level = lvl;
  countTo($("overallNum"), n);
  $("overall").textContent = levelNames[status.level] || status.level;
  $("tape").innerHTML = Array.from({length:20},(_,i)=>`<i class="${i < Math.min(20, n*2) ? "on" : ""}"></i>`).join("");
  countTo($("crewCount"), status.crew.length);
  countTo($("sharedCount"), status.shared_findings.length);
  $("earthLinkText").textContent = status.earth_link ? "MAVJUD" : "UZILGAN";
  countTo($("outboxCount"), status.pending_outbox);
  $("todoList").innerHTML = todoItems(status.active_alerts, status);
  $("cabinCo2").innerHTML = status.zones.map(z => readout(z, "co2_partial", 3, 0, .40, .70)).join("");
  $("cabinRad").innerHTML = status.zones.map(z => readout(z, "radiation", 0, 0, 50, 400)).join("");
}
function renderZones(zones, systems) {
  $("zoneGrid").innerHTML = zones.map(z => `<div class="bezel mcard">
    <div class="row between"><h2>${esc(z.zone_id)} · ${esc(z.name)}</h2><span class="tag" data-level="${levelNum[z.level]??1}">${esc(levelNames[z.level] || z.level)}</span></div>
    <div class="screen kv">${cabinSpecs.map(([key,title])=>{
      const p=z.sensors[key];return `<div><span>${esc(title)}</span><b>${showNum(p, key === "co2_partial" ? 3 : 1)} <small>${esc(p?.unit)}</small></b></div>`;
    }).join("")}</div><p class="note">${z.active_alert_count} ta faol ogohlantirish</p></div>`).join("");
  $("systemStrip").innerHTML = Object.entries(systems).map(([key,p])=>{
    const v=numberOf(p), label=key === "scrubber_ok" ? "CO₂ tozalash" : key === "hab_fan_ok" ? "HAB ventilyator" : key;
    const level=v===0 ? 2 : v===1 ? 0 : 1;
    return `<div><span>${esc(label)}</span><span class="tag" data-level="${level}">${v===0 ? "NOSOZLIK SIGNALI" : v===1 ? "SIM: OK" : "NOMA’LUM"}</span></div>`;
  }).join("");
}
function renderFindings(items) {
  $("findingList").innerHTML = items.length ? items.map(f => `
    <div class="bezel finding" data-level="${levelNum[f.level]??1}">
      <div class="row between"><h2>${esc(f.title)}</h2><span class="tag" data-level="${levelNum[f.level]??1}">${esc(levelNames[f.level] || f.level)}</span></div>
      <p>${esc(f.interpretation)}</p>
      <p class="sub">EKIPAJ: ${esc(f.affected_crew.join(", ") || "—")} · MODUL: ${esc(f.affected_zones.join(", ") || "—")}</p>
      <ul class="screen ev">${f.evidence.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
      <p class="sub">NOANIQLIK: ${esc(f.uncertainties.join(" "))}</p>
      <div class="row acts"><button class="link-button" type="button" data-protocol="${esc(f.protocol_id)}">Yo‘riqnoma ↗</button>
      <button class="btn small" type="button" data-start-protocol="${esc(f.protocol_id)}" data-start-crew="${esc(f.affected_crew.join(','))}" data-start-zones="${esc(f.affected_zones.join(','))}" data-start-code="${esc(f.code)}">+ Hodisa yaratish</button></div>
    </div>`).join("") : `<div class="bezel"><div class="empty">Bir nechta kosmonavtda o‘xshash xavfli signal hozircha topilmadi.<br>Bu muhit yoki kema tizimlarining mutlaq xavfsizligini anglatmaydi.</div></div>`;
}
function renderAlerts(alerts) {
  $("alertsCount").textContent = `${alerts.length} ta`;
  $("alertList").innerHTML = alerts.length ? alerts.slice(0, 35).map(a=>`
    <div class="bezel finding" data-level="${sevNum(a.severity)}">
      <div class="row between"><h2>${esc(a.subject_id)} · ${esc(a.title)}</h2><span class="tag" data-level="${sevNum(a.severity)}">${a.severity==="critical"?"Xavf":"E’tibor"}</span></div>
      <p>${esc(a.description)}</p>${alertButtons(a)}</div>`).join("")
    : `<div class="bezel"><div class="empty">Hozir faol sinov ogohlantirishi yo‘q.</div></div>`;
}
function renderEvents(items) {
  $("eventList").innerHTML = items.length ? items.slice(0, 40).map(e => {
    // Event names are snapshots saved at occurrence time; never use today's roster.
    const actor = e.scope === "crew"
      ? (e.subject_name ? `${e.subject_name} (${e.subject_id})` : `Ismi noma’lum (${e.subject_id})`)
      : e.scope === "zone" ? `${e.subject_name || e.subject_id} (${e.subject_id})` : "Umumiy tizim";
    const affected = Array.isArray(e.affected_crew) ? e.affected_crew : [];
    const lvl = e.severity === "critical" ? 2 : e.severity === "attention" ? 1 : 0;
    return `<li data-level="${lvl}"><span class="t">${esc(new Date(e.created_at).toLocaleTimeString("uz-UZ"))}</span>
      <span class="x">●</span><span><span class="m">${esc(e.event_type)} · ${esc(actor)}</span><br>${esc(e.message)}${
      affected.length ? `<br><small class="sub">Ta’sirlangan: ${affected.map(p => `${esc(p.name)} (${esc(p.crew_id)})`).join(", ")}</small>` : ""}</span></li>`;
  }).join("") : `<li class="todo-empty">Hodisalar yo‘q</li>`;
}
function plot(canvasId, history, key, color, minY, maxY) {
  const canvas = $(canvasId), rect=canvas.getBoundingClientRect(), w=rect.width;
  if (!w) return;
  const h=rect.height||74, dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const l=30,t=6,r=6,b=6,drawW=w-l-r,drawH=h-t-b;
  ctx.font="10px "+cssVar("--font");ctx.lineWidth=1;ctx.strokeStyle=cssVar("--line-soft");ctx.fillStyle=cssVar("--faint");
  for(let i=0;i<=2;i++) {
    const y=t+i*drawH/2;ctx.beginPath();ctx.moveTo(l,y);ctx.lineTo(w-r,y);ctx.stroke();
    ctx.fillText(String(Math.round(maxY-(maxY-minY)*i/2)),2,y+4);
  }
  const vals=history.map(d=>numberOf(d.vitals?.[key]));
  if(vals.length<2)return;
  let started=false;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;
  vals.forEach((v,i)=>{
    if(v===null){started=false;return;}
    const x=l+(i*drawW/Math.max(vals.length-1,1));
    const y=Math.max(t,Math.min(t+drawH,t+drawH-(v-minY)/(maxY-minY)*drawH));
    if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);
  });ctx.stroke();
}
function renderScenarios(status) {
  const box = $("scenario");
  if (!box.dataset.ready) {
    box.innerHTML = Object.entries(status.scenarios).map(([v,label])=>`<button type="button" data-scenario="${esc(v)}">${esc(label)}</button>`).join("");
    box.dataset.ready = "1";
  }
  box.querySelectorAll("[data-scenario]").forEach(b => b.classList.toggle("active", b.dataset.scenario === status.mission.scenario));
}
function updateGlobalStatus(status) {
  const signature = JSON.stringify(status.crew.map(p=>[p.crew_id,p.name,p.zone_id,p.level,p.active_alert_count]));
  if (signature !== lastCrewSignature || !status.crew.some(p=>p.crew_id===selectedCrew)) { renderCrewNav(status.crew); lastCrewSignature = signature; }
  const hasCrit = status.active_alerts.some(a=>a.severity==="critical");
  const hasAtt = status.active_alerts.some(a=>a.severity!=="critical");
  const alarm = $("alarm");
  alarm.dataset.warning = hasCrit ? "on" : "off";
  alarm.dataset.caution = hasAtt || status.level === "attention" ? "on" : "off";
  alarm.dataset.blink = hasCrit || hasAtt ? "on" : "off";
  $("connectionTag").textContent = status.earth_link ? "Yer aloqasi (DEMO)" : "Offline rejim";
  $("toggleLink").dataset.state = status.earth_link ? "ok" : "lost";
  $("toggleLink").title = status.earth_link ? "Bosing: aloqani uzish (sinov)" : "Bosing: aloqani tiklash (sinov)";
  $("lastSeen").textContent = "Namuna: " + new Date(status.mission.timestamp).toLocaleTimeString("uz-UZ");
  $("globalRisk").textContent = "Missiya: " + (levelNames[status.level] || status.level);
  $("globalRisk").dataset.level = levelNum[status.level] ?? 1;
  $("navAlertCount").textContent = String(status.active_alerts.length);
  $("navAlertCount").classList.toggle('has-alerts', status.active_alerts.length > 0);
  renderScenarios(status);
}
async function renderActiveView(status) {
  const view=activeView;
  const epoch=++viewLoadEpoch;
  switch(view){
    case 'overview': renderOverview(status); break;
    case 'crew-section': renderCrew(status.crew); break;
    case 'individual': {
      renderMetrics(status.crew.find(p=>p.crew_id===selectedCrew),status.active_alerts);
      if(!selectedCrew) break;
      const history=await api(`/api/crew/${encodeURIComponent(selectedCrew)}/history?limit=60`);
      if(view!==activeView || epoch!==viewLoadEpoch) return;
      plot('hrChart',history.items,'heart_rate',cssVar('--accent'),40,170);
      plot('spo2Chart',history.items,'spo2',cssVar('--accent'),75,101);
      break;
    }
    case 'shared': renderFindings(status.shared_findings); break;
    case 'zones': renderZones(status.zones,status.mission.systems); break;
    case 'alerts': renderAlerts(status.active_alerts); break;
    case 'events': {
      const events=await api('/api/events?limit=40');
      if(view===activeView && epoch===viewLoadEpoch) renderEvents(events.items);
      break;
    }
    case 'emergency':
      syncCaseSelectors(status);
      await ensureStage3();
      break;
  }
}
async function refresh() {
  if(inFlight) return;
  inFlight=true;
  try{
    const status=await api('/api/status');
    state=status;
    initialized=true;
    updateGlobalStatus(status);
    // Monitoring is independent on the server; only the visible page is rendered.
    await renderActiveView(status);
  }catch(err){
    $('globalRisk').textContent='Ma’lumot yangilanmadi';
    $('globalRisk').dataset.level='1';
    toast('Yangilashda xato: '+err.message);
  }finally{
    inFlight=false;
    if(refreshAfterFlight){refreshAfterFlight=false;void refresh();}
  }
}
function closeMobileNav(){
  $('mainNav').classList.remove('nav-open');
  $('mobileMenuButton').setAttribute('aria-expanded','false');
}
function activateView() {
  const id=decodeURIComponent(location.hash.replace(/^#/,''));
  const next=Object.prototype.hasOwnProperty.call(viewGroups,id)?id:'overview';
  const changed=activeView!==next;
  activeView=next;
  const group=viewGroups[next];
  document.querySelectorAll('[data-view]').forEach(el=>{el.hidden=el.dataset.view!==next;});
  document.querySelectorAll('#mainNav a[data-primary]').forEach(el=>{
    if(el.dataset.primary===group)el.setAttribute('aria-current','page');
    else el.removeAttribute('aria-current');
  });
  const tabs=groupTabs[group] || [];
  $('subNav').hidden=tabs.length===0;
  $('subNav').innerHTML=tabs.map(([id,name])=>`<a href="#${id}" ${id===next?'aria-current="page"':''}>${esc(name)}</a>`).join('');
  $('pageTitle').textContent=viewDetails[next][0];
  $('pageDescription').textContent=viewDetails[next][1];
  closeMobileNav();
  if(changed){
    viewLoadEpoch++;
    window.scrollTo(0,0);
    $('pageTitle').focus({preventScroll:true});
  }
  if(state){
    if(inFlight) refreshAfterFlight=true;
    else refresh();
  }
}
function pollingInterval(){return document.hidden ? 20000 : 4000;}
function scheduleNextRefresh(){
  if(refreshTimer)clearTimeout(refreshTimer);
  refreshTimer=setTimeout(async()=>{
    await refresh();
    if(refreshAfterFlight){refreshAfterFlight=false;await refresh();}
    scheduleNextRefresh();
  },pollingInterval());
}
async function command(url,payload,method="POST") {
  try { await api(url,method,payload); await refresh(); }
  catch(err){toast("Amal bajarilmadi: "+err.message);}
}
async function openPlaybook(id) {
  try {
    const p=await api("/api/playbooks/"+encodeURIComponent(id));
    $("protocolTitle").textContent=p.title;
    $("protocolSteps").innerHTML=p.steps.map(x=>`<li><span class="say">${esc(x)}</span></li>`).join("");
    $("protocolModal").classList.remove("hidden");
  } catch(err){toast("Yo‘riqnoma topilmadi: "+err.message);}
}
function selectCrew(id, open) {
  selectedCrew = id; lastCrewSignature = '';
  if (open) location.hash = "#" + open;
  if (state) { renderCrewNav(state.crew); if (!inFlight) renderActiveView(state); else refreshAfterFlight = true; }
}
$("crewNav").addEventListener("click",e=>{
  const b=e.target.closest("[data-crew]"); if(b) selectCrew(b.dataset.crew, activeView==="overview" ? "individual" : null);
});
$("crewGrid").addEventListener("click",e=>{
  const b=e.target.closest("[data-crew]"); if(b) selectCrew(b.dataset.crew, b.dataset.open || null);
});
$("scenario").addEventListener("click",e=>{
  const b=e.target.closest("[data-scenario]"); if(b) command("/api/scenario",{scenario:b.dataset.scenario});
});
$("symptomList").addEventListener("change",()=>{
  if(!selectedCrew) return;
  const symptoms=[...$("symptomList").querySelectorAll("input:checked")].map(i=>i.value);
  command(`/api/crew/${encodeURIComponent(selectedCrew)}/symptoms`,{symptoms});
});
$("sendToAi").addEventListener("click",()=>{
  const person=state?.crew.find(p=>p.crew_id===selectedCrew); if(!person) return;
  const lines=[];
  (person.symptoms||[]).forEach(s=>lines.push(`${person.name} ${state.symptom_labels[s]||s} haqida xabar berdi.`));
  state.active_alerts.filter(a=>a.subject_id===person.crew_id || (a.scope==="zone" && a.subject_id===person.zone_id))
    .forEach(a=>lines.push(`${a.subject_id}: ${a.title}. ${a.description}`));
  if(!lines.length) lines.push(`${person.name} hozircha shikoyat qilmadi, ko‘rsatkichlar sinov chegarasida.`);
  $("aiRecords").value=lines.slice(0,12).map((l,i)=>`R${i+1}: ${l.slice(0,480)}`).join("\n");
  document.body.classList.add("ai-open"); $("aiReopen").hidden=true;
  $("aiRecords").focus({preventScroll:true});
  toast("Qaydlar AstroAI panelga qo‘yildi. “Tahlil qilish”ni bosing.");
});
$("manualForm").addEventListener("submit",async e=>{
  e.preventDefault(); if(!selectedCrew) return;
  const values={};
  for(const input of $("manualFields").querySelectorAll("input")){
    if(input.value.trim()!=="") values[input.name]=Number(input.value);
  }
  if(!Object.keys(values).length){ toast("Kamida bitta qiymat kiriting"); return; }
  try{
    await api(`/api/crew/${encodeURIComponent(selectedCrew)}/vitals`,"POST",{values});
    $("manualFields").querySelectorAll("input").forEach(i=>i.value="");
    toast("Qo‘lda kiritilgan qiymatlar saqlandi"); await refresh();
  }catch(err){ toast("Saqlanmadi: "+err.message); }
});
$("manualClear").addEventListener("click",()=>{
  if(selectedCrew) command(`/api/crew/${encodeURIComponent(selectedCrew)}/vitals`,undefined,"DELETE");
});
$("toggleLink").addEventListener("click",()=>{if(state)command("/api/link",{available:!state.earth_link});});
$("forceStep").addEventListener("click",()=>command("/api/step",{}));
$("crewAddForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const name=$("newCrewName").value.trim();
  if(!name)return;
  try {
    const result=await api("/api/crew","POST",{name,zone_id:$("newCrewZone").value});
    selectedCrew=result.crew[result.crew.length-1].crew_id; lastCrewSignature='';
    $("newCrewName").value="";await refresh();
  }catch(err){toast("Ekipaj qo‘shilmadi: "+err.message);}
});
$("removeCrew").addEventListener("click",()=>{
  if(!selectedCrew)return;
  if(!window.confirm(`${selectedCrew} ekipaj ro‘yxatidan chiqarilsinmi? (Faqat DEMO)`))return;
  command(`/api/crew/${encodeURIComponent(selectedCrew)}`,undefined,"DELETE");
});
document.querySelector("main").addEventListener("click",e=>{
  const start=e.target.closest("[data-start-protocol]");
  if(start) { beginCase(start.dataset.startProtocol, start.dataset.startCrew.split(",").filter(Boolean),
                        start.dataset.startZones.split(",").filter(Boolean), start.dataset.startCode); return; }
  const b=e.target.closest("[data-protocol]");if(b)openPlaybook(b.dataset.protocol);
});
function closeModal(){$("protocolModal").classList.add("hidden");}
$("closeModal").addEventListener("click",closeModal);
$("closeModalBottom").addEventListener("click",closeModal);
$("protocolModal").addEventListener("click",e=>{if(e.target.id==="protocolModal")closeModal();});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();});
let resizeTimer;
window.addEventListener('resize',()=>{
  if(activeView!=='individual'||!state)return;
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{if(!inFlight)renderActiveView(state);},200);
});
$("themeToggle").addEventListener("click",()=>{
  const dark=document.documentElement.dataset.theme!=="dark";
  if(dark)document.documentElement.dataset.theme="dark"; else delete document.documentElement.dataset.theme;
  try{localStorage.setItem("astromed.theme",dark?"dark":"light");}catch(_){}
  if(state && activeView==="individual" && !inFlight) renderActiveView(state);
});
$("sideToggle").addEventListener("click",()=>{
  const mini=document.documentElement.classList.toggle("side-mini");
  try{localStorage.setItem("astromed.side",mini?"mini":"full");}catch(_){}
});
function tickClock(){ $("clock").textContent=new Date().toLocaleTimeString("uz-UZ",{hour12:false}); }
setInterval(tickClock,1000); tickClock();
window.addEventListener('hashchange',activateView);
document.addEventListener('visibilitychange',()=>{scheduleNextRefresh();if(!document.hidden)refresh();});
$('mobileMenuButton').addEventListener('click',()=>{
  const expanded=$('mobileMenuButton').getAttribute('aria-expanded')==='true';
  $('mobileMenuButton').setAttribute('aria-expanded',String(!expanded));
  $('mainNav').classList.toggle('nav-open',!expanded);
});

/* Stage 3: offline DEMO case tracking. Entirely separate from clinical decisions and AI. */
let protocols = [];
let crewSignature = "";
let currentIncidentId = null;
let loadedIncidents = [];
const statusText = {pending:"Kutilmoqda", acknowledged:"Ko‘rib chiqildi", completed:"Bajarildi (DEMO)", blocked:"Bloklangan"};
const approvalNotice = "DEMO / tibbiy tasdiqlanmagan. Bu qadamlar haqiqiy davolash ko‘rsatmasi emas.";
function checkedValues(container) {
  return [...$(container).querySelectorAll('input[type="checkbox"]:checked')].map(el=>el.value);
}
function syncCaseSelectors(data) {
  const signature = JSON.stringify(data.crew.map(p => [p.crew_id,p.name,p.zone_id]));
  if(signature === crewSignature) return;
  const oldCrew=new Set(checkedValues("incidentCrewChoices")), oldZones=new Set(checkedValues("incidentZoneChoices"));
  const oldActor=$('incidentActor').value;
  crewSignature=signature;
  $('incidentCrewChoices').innerHTML=data.crew.map(p => `<label class="check-choice"><input type="checkbox" value="${esc(p.crew_id)}" ${oldCrew.has(p.crew_id)?'checked':''}> ${esc(p.name)} <small>${esc(p.zone_id)}</small></label>`).join('');
  $('incidentZoneChoices').innerHTML=data.zones.map(z => `<label class="check-choice"><input type="checkbox" value="${esc(z.zone_id)}" ${oldZones.has(z.zone_id)?'checked':''}> ${esc(z.zone_id)} <small>${esc(z.name)}</small></label>`).join('');
  $('incidentActor').innerHTML=data.crew.map(p=>`<option value="${esc(p.crew_id)}">${esc(p.name)}</option>`).join('');
  if(data.crew.some(p=>p.crew_id===oldActor))$('incidentActor').value=oldActor;
  if(!checkedValues("incidentCrewChoices").length && selectedCrew) {
    const input=$('incidentCrewChoices').querySelector(`input[value="${CSS.escape(selectedCrew)}"]`);
    if(input)input.checked=true;
  }
}
function caseActorOptions(selected) {
  return (state?.crew||[]).map(p=>`<option value="${esc(p.crew_id)}" ${p.crew_id===selected?'selected':''}>${esc(p.name)}</option>`).join('');
}
function renderProtocolCatalog() {
  $('incidentProtocol').innerHTML = protocols.map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  $('protocolCatalog').innerHTML = protocols.map(p => `<div class="protocol-item">
    <div><strong>${esc(p.title)}</strong><p>${esc(p.description)}</p><span class="proto-version">${esc(p.version)} · ${esc(p.scope)}</span></div>
    <button class="link-button" data-protocol-catalog="${esc(p.id)}" type="button">Ko‘rish</button>
  </div>`).join('');
}
function renderResources(resources) {
  $('resourceList').innerHTML = resources.map(r=>`<div class="resource-item"><span>${esc(r.name)}</span><span class="mini-pill ${r.available?'normal':'attention'}">${r.available?'SIM: BOR':'SIM: YO‘Q'}</span></div>`).join('');
}
let stage3Promise = null;
let stage3Loaded = false;
async function ensureStage3(){
  if(stage3Loaded)return;
  if(stage3Promise)return stage3Promise;
  stage3Promise=(async()=>{
    const [p,r] = await Promise.all([api('/api/protocols'),api('/api/resources')]);
    protocols=p.items;
    renderProtocolCatalog();renderResources(r.items);
    await loadIncidents();
    stage3Loaded=true;
  })();
  try{await stage3Promise;}catch(err){stage3Promise=null;toast('Yordam markazini yuklashda xato: '+err.message);}
}
async function beginCase(protocolId, crewIds=[], zoneIds=[], code='MANUAL_REPORT') {
  location.hash='#emergency';
  if(activeView!=='emergency')activateView();
  await ensureStage3();
  if(state)syncCaseSelectors(state);
  if(!protocols.some(p=>p.id===protocolId)) { toast('Protokol topilmadi'); return; }
  $('incidentProtocol').value=protocolId;
  $('incidentOrigin').value=code || 'MANUAL_REPORT';
  for(const input of $('incidentCrewChoices').querySelectorAll('input'))input.checked=crewIds.includes(input.value);
  for(const input of $('incidentZoneChoices').querySelectorAll('input'))input.checked=zoneIds.includes(input.value);
  if(!crewIds.length && !zoneIds.length && selectedCrew) {
    const input=[...$('incidentCrewChoices').querySelectorAll('input')].find(x=>x.value===selectedCrew);
    if(input)input.checked=true;
  }
  document.getElementById('emergency').scrollIntoView({behavior:'smooth',block:'start'});
  $('incidentProtocol').focus({preventScroll:true});
}
function renderIncidentList(items) {
  loadedIncidents=items;
  const open=items.filter(i=>i.status==='open').length;
  $('caseStats').textContent=`${open} ochiq / ${items.length} jami · SQLite`;
  $('incidentList').innerHTML = items.length ? items.map(i => {
    const people = i.crew_snapshot.map(p=>p.name).join(', ');
    return `<button type="button" class="case-item ${i.id===currentIncidentId?'active':''}" data-case-id="${esc(i.id)}">
      <span class="case-id">${esc(i.id)}</span><span class="mini-pill ${i.status==='open'?'attention':'normal'}">${i.status==='open'?'OCHIQ':'KO‘RIB CHIQILGAN'}</span>
      <strong>${esc(protocols.find(p=>p.id===i.protocol_id)?.title||i.protocol_id)}</strong>
      <span class="case-meta">${esc(people||i.zone_ids.join(', ')||'Umumiy')} · ${esc(new Date(i.created_at).toLocaleString('uz-UZ'))}</span>
    </button>`;
  }).join('') : '<div class="empty">Hali yordam hodisasi yaratilmagan. Protokol tanlab yangi hodisa oching.</div>';
}
async function loadIncidents(preferred=null) {
  const response=await api('/api/incidents?limit=80');
  const items=response.items;
  if(preferred)currentIncidentId=preferred;
  if(currentIncidentId && !items.some(i=>i.id===currentIncidentId)) currentIncidentId=null;
  if(!currentIncidentId && items.length)currentIncidentId=items[0].id;
  renderIncidentList(items);
  if(currentIncidentId)await showIncident(currentIncidentId);
}
async function showIncident(id) {
  try {
    const record=await api('/api/incidents/'+encodeURIComponent(id));
    currentIncidentId=id;
    renderIncidentList(loadedIncidents);
    const people=record.crew_snapshot.map(p=>`${esc(p.name)} (${esc(p.crew_id)})`).join(', ');
    const readOnly=record.status!=='open';
    const steps=record.steps_snapshot.map(s=>{
      const saved=record.steps.find(a=>a.step_index===s.index);
      return `<div class="case-step" data-step="${s.index}">
        <div class="case-step-main"><span class="step-index">${s.index+1}</span><div><strong>${esc(s.title)}</strong>
        <p class="case-meta">Oxirgi holat: <b>${esc(statusText[saved.status]||saved.status)}</b>${saved.actor_name?' · '+esc(saved.actor_name):''}</p></div></div>
        ${readOnly?'':`<div class="case-step-actions"><label>Holat<select data-step-state>
          ${Object.entries(statusText).map(([val,label])=>`<option value="${val}" ${val===saved.status?'selected':''}>${esc(label)}</option>`).join('')}
          </select></label><label>Kim qayd etdi<select data-step-actor>${caseActorOptions(state?.crew[0]?.crew_id)}</select></label>
          <label class="case-step-note">Izoh<input data-step-note maxlength="500" value="${esc(saved.note||'')}" placeholder="Ixtiyoriy qayd" /></label>
          <button type="button" class="button" data-save-step="${s.index}">Saqlash</button></div>`}
        </div>`;
    }).join('');
    const evidence=record.evidence_snapshot;
    const audit=record.audit.map(a=>`<li><time>${esc(new Date(a.created_at).toLocaleString('uz-UZ'))}</time> · ${esc(a.action)} · ${esc(a.actor_name||'—')} </li>`).join('');
    $('caseDetail').innerHTML=`<div class="section-head case-detail-head"><div><div class="eyebrow">INCIDENT WORKFLOW · ${esc(record.approval_snapshot)}</div><h3>${esc(record.id)}</h3></div><span class="mini-pill ${readOnly?'normal':'attention'}">${readOnly?'KO‘RIB CHIQILGAN':'OCHIQ'}</span></div>
      <p class="warning-copy">${esc(approvalNotice)} Protokol versiyasi: <b>${esc(record.protocol_version)}</b>. Kiritilgan harakatlar faqat simulyatsiya jurnaliga yoziladi.</p>
      <div class="case-summary"><div><small>PROTOKOL</small><strong>${esc(protocols.find(p=>p.id===record.protocol_id)?.title||record.protocol_id)}</strong></div>
      <div><small>KOSMONAVTLAR</small><strong>${people||'—'}</strong></div><div><small>MODULLAR</small><strong>${esc(record.zone_ids.join(', ')||'—')}</strong></div>
      <div><small>MANBA</small><strong>${esc(record.origin_code)}</strong></div></div>
      <p class="case-meta">Signal dalili: ${esc(evidence.source||'unknown')} · Sana: ${esc(evidence.timestamp||record.created_at)} · Tibbiy tasdiqlangan: YO‘Q</p>
      ${record.missing_resources.length?`<div class="missing-resources">⚠ DEMO inventarda yetishmaydi: ${esc(record.missing_resources.join(', '))}. Tekshiruvni bloklash yoki resurs holatini qayd etish mumkin, hech bir muolajani avtomatik bajarmang.</div>`:''}
      <div class="section-head"><h3>Tekshiruv qadamlari</h3><span class="subtag">Har qadam alohida audit qilinadi</span></div>
      <div class="case-steps">${steps}</div>
      ${readOnly?'':`<div class="case-review"><label>Qaydni yakunlovchi ekipaj a’zosi <select id="reviewActor">${caseActorOptions(state?.crew[0]?.crew_id)}</select></label>
        <label>Yakuniy qayd <input id="reviewNote" maxlength="500" placeholder="Demo tekshiruv yakunlandi..." /></label>
        <button id="reviewCaseButton" class="button primary" type="button">Tekshiruvni yakunlash</button></div>`}
      <details class="audit-log"><summary>Audit tarixi (${record.audit.length})</summary><ol>${audit}</ol></details>`;
  }catch(err){toast('Hodisani ochishda xato: '+err.message);}
}
$('incidentForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const protocol_id=$('incidentProtocol').value;
  const crew_ids=checkedValues('incidentCrewChoices'), zone_ids=checkedValues('incidentZoneChoices');
  const payload={protocol_id, crew_ids, zone_ids, origin_code:$('incidentOrigin').value||'MANUAL_REPORT',
                actor_id:$('incidentActor').value,note:$('incidentNote').value};
  const btn=$('incidentForm').querySelector('button[type="submit"]');btn.disabled=true;
  try{
    const created=await api('/api/incidents','POST',payload);
    $('incidentNote').value=''; $('incidentOrigin').value='MANUAL_REPORT';
    await loadIncidents(created.id); await refresh();
    document.getElementById('caseDetail').scrollIntoView({behavior:'smooth',block:'start'});
    toast('DEMO hodisa yaratildi: '+created.id);
  }catch(err){toast('Hodisa yaratilmadi: '+err.message);}finally{btn.disabled=false;}
});
$('incidentList').addEventListener('click',e=>{
  const b=e.target.closest('[data-case-id]');if(b)showIncident(b.dataset.caseId);
});
$('caseDetail').addEventListener('click',async e=>{
  const step=e.target.closest('[data-save-step]');
  if(step){
    const row=step.closest('[data-step]'); const index=Number(step.dataset.saveStep);
    step.disabled=true;
    try{
      await api(`/api/incidents/${encodeURIComponent(currentIncidentId)}/steps/${index}`,'PATCH',{
        status:row.querySelector('[data-step-state]').value, actor_id:row.querySelector('[data-step-actor]').value,
        note:row.querySelector('[data-step-note]').value });
      await loadIncidents(currentIncidentId);await refresh();
      toast('Qadam DEMO jurnalga yozildi');
    }catch(err){toast('Saqlanmadi: '+err.message);step.disabled=false;}return;
  }
  if(e.target.closest('#reviewCaseButton')){
    const btn=e.target.closest('button');btn.disabled=true;
    try{
      await api(`/api/incidents/${encodeURIComponent(currentIncidentId)}/review`,'POST',{
        actor_id:$('reviewActor').value,note:$('reviewNote').value});
      await loadIncidents(currentIncidentId);await refresh();toast('Demo tekshiruv yakunlandi');
    }catch(err){toast('Yakunlanmadi: '+err.message);btn.disabled=false;}
  }
});
$('protocolCatalog').addEventListener('click',e=>{
  const b=e.target.closest('[data-protocol-catalog]');if(b)openPlaybook(b.dataset.protocolCatalog);
});
$('reloadIncidents').addEventListener('click',()=>loadIncidents().catch(err=>toast(err.message)));

// Start: first render, then adaptive polling (4 s visible, 20 s hidden). Stage 3 data loads only on the emergency page.
activateView();
refresh().then(scheduleNextRefresh);
