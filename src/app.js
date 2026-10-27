// Format: logika interfejsu.
// Stany ekranów (zgodne z projektem w Paper):
//   empty   → 1 Pusty / 5 Przeciąganie
//   queue   → 2 Kolejka
//   running → 3 W trakcie
//   done    → 4 Gotowe (bez błędów) / 6 Błąd (gdy któryś plik się nie udał)
"use strict";

const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);

const app = $("app");
const els = {
  dropzone: $("dropzone"), pickBtn: $("pickBtn"), dragCount: $("dragCount"), overlayCount: $("overlayCount"),
  summary: $("summary"), summaryPercent: $("summaryPercent"), summarySizes: $("summarySizes"), summaryNote: $("summaryNote"),
  queue: $("queue"), queueHead: $("queueHead"), queueTitle: $("queueTitle"), queueAside: $("queueAside"),
  clearBtn: $("clearBtn"), queueList: $("queueList"),
  settings: $("settings"), quality: $("quality"), qualityValue: $("qualityValue"), lossless: $("lossless"),
  progress: $("progress"), segments: $("segments"), progressValue: $("progressValue"),
  actionStatus: $("actionStatus"), actionButtons: $("actionButtons"),
};

/** @type {{path:string,name:string,folder:string,format:string,size:number,status:'pending'|'converting'|'done'|'error',result?:{output:string,before:number,after:number},error?:string}[]} */
let files = [];
let state = "empty";
let runItems = [];
let current = null;
let cancelRequested = false;
let notice = "";
let noticeTimer = null;

const SEGMENTS = 60;
const GRADIENT_SPAN = 41; // zieleń osiągana mniej więcej przy 70% paska

// ---------- Narzędzia ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function plural(n, [one, few, many]) {
  if (n === 1) return one;
  const m10 = n % 10, m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14) ? few : many;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const isImagePath = (p) => /\.(jpe?g|png)$/i.test(p);

const ICON_CHECK = '<svg viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

function flash(message, ms = 4000) {
  notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = ""; render(); }, ms);
  render();
}

// ---------- Pasek postępu: 60 segmentów ----------
(function buildSegments() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < SEGMENTS; i++) {
    const step = Math.min(10, Math.round((i / GRADIENT_SPAN) * 9) + 1);
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.style.setProperty("--c", `var(--color-progress-${step})`);
    frag.appendChild(seg);
  }
  els.segments.appendChild(frag);
})();

function setProgress(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const on = Math.round(r * SEGMENTS);
  [...els.segments.children].forEach((seg, i) => seg.classList.toggle("on", i < on));
  const pct = Math.round(r * 100);
  els.progressValue.textContent = pct + "%";
  els.segments.setAttribute("aria-valuenow", String(pct));
}

function progressRatio() {
  const total = sum(runItems, (f) => f.size) || 1;
  const done = sum(runItems, (f) => (f.status === "done" || f.status === "error" ? f.size : f.status === "converting" ? f.size * 0.5 : 0));
  return done / total;
}

// ---------- Ustawienia ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("format.settings") || "{}");
    if (Number.isFinite(s.quality)) els.quality.value = String(Math.min(100, Math.max(1, s.quality)));
    if (typeof s.lossless === "boolean") els.lossless.checked = s.lossless;
  } catch { /* ignoruj uszkodzone ustawienia */ }
  syncQuality();
}
function saveSettings() {
  try { localStorage.setItem("format.settings", JSON.stringify({ quality: Number(els.quality.value), lossless: els.lossless.checked })); } catch { /* brak localStorage */ }
}
function syncQuality() {
  const v = Number(els.quality.value);
  els.qualityValue.textContent = String(v);
  els.quality.style.setProperty("--fill", ((v - 1) / 99) * 100 + "%");
}
els.quality.addEventListener("input", () => { syncQuality(); saveSettings(); });
els.lossless.addEventListener("change", saveSettings);

// ---------- Renderowanie ----------
function rowHtml(f, compact) {
  const isActive = f.status === "converting";
  const isError = f.status === "error";
  let sizeCell = formatSize(f.size);
  let statusCell;
  let statusClass = "";

  if (f.status === "pending") {
    statusCell = "Oczekuje";
  } else if (isActive) {
    statusCell = "Konwertuję"; statusClass = "is-active";
  } else if (isError) {
    statusCell = ICON_ERROR + "<span>Błąd</span>"; statusClass = "is-error";
  } else if (compact && f.result) {
    const saving = 1 - f.result.after / f.result.before;
    sizeCell = `${formatSize(f.result.before)} → ${formatSize(f.result.after)}`;
    statusCell = (saving >= 0 ? "−" : "+") + Math.abs(Math.round(saving * 100)) + "%"; statusClass = "is-saving";
  } else {
    statusCell = ICON_CHECK + "<span>Gotowe</span>"; statusClass = "is-done";
  }

  const name = f.status === "done" && f.result ? f.result.output.split(/[\\/]/).pop() : f.name;
  const sub = isError ? `<span class="name-sub is-error">${esc(f.error || "Nie udało się przekonwertować")}</span>` : `<span class="name-sub">${esc(f.folder)}</span>`;
  const remove = state === "queue" && f.status === "pending"
    ? `<button class="remove" type="button" data-remove="${esc(f.path)}" aria-label="Usuń ${esc(f.name)} z listy">${ICON_REMOVE}</button>`
    : "<span></span>";

  return `<div class="row${isActive ? " is-active" : ""}${isError ? " is-error" : ""}">
    <div class="thumb"></div>
    <div class="name"><span class="name-main">${esc(name)}</span>${sub}</div>
    <span class="fmt">${f.format}</span>
    <span class="size">${esc(sizeCell)}</span>
    <span class="status ${statusClass}">${statusCell}</span>
    ${remove}
  </div>`;
}

function buttonsFor(st, hasErr, hasSuccess) {
  const btn = (cls, id, label, disabled = false) => `<button class="btn ${cls}" id="${id}" type="button"${disabled ? " disabled" : ""}>${label}</button>`;
  if (st === "empty") return btn("btn-primary", "startBtn", "Rozpocznij", true);
  if (st === "queue") return btn("btn-primary", "startBtn", "Rozpocznij");
  if (st === "running") return btn("btn-secondary", "cancelBtn", "Anuluj");
  if (hasErr) return (hasSuccess ? btn("btn-secondary", "revealBtn", "Pokaż w folderze") : "") + btn("btn-primary", "retryBtn", "Spróbuj ponownie");
  return btn("btn-secondary", "againBtn", "Konwertuj kolejne") + btn("btn-primary", "revealBtn", "Pokaż w folderze");
}

function render() {
  app.dataset.state = state;
  const hasErr = files.some((f) => f.status === "error");
  const okFiles = files.filter((f) => f.status === "done" && f.result);
  const compact = state === "done" && !hasErr;
  const showQueue = state !== "empty";
  const showSummary = compact && okFiles.length > 0;

  els.dropzone.hidden = state !== "empty";
  els.queue.hidden = !showQueue;
  els.summary.hidden = !showSummary;
  els.settings.hidden = state === "running" || state === "done";
  els.progress.hidden = state !== "running";

  // Podsumowanie (ekran 4)
  if (showSummary) {
    const before = sum(okFiles, (f) => f.result.before);
    const after = sum(okFiles, (f) => f.result.after);
    els.summaryPercent.textContent = Math.max(0, Math.round((1 - after / before) * 100)) + "%";
    els.summarySizes.textContent = `${formatSize(before)} → ${formatSize(after)}`;
    els.summaryNote.textContent = `Zapisano ${okFiles.length} ${plural(okFiles.length, ["plik", "pliki", "plików"])} WebP obok oryginałów`;
  }

  // Nagłówek listy
  els.queueHead.hidden = compact;
  els.clearBtn.hidden = state !== "queue";
  els.queueAside.hidden = !(state === "running" || (state === "done" && hasErr));
  if (state === "queue") {
    els.queueTitle.textContent = `${files.length} ${plural(files.length, ["plik", "pliki", "plików"])}, ${formatSize(sum(files, (f) => f.size))}`;
  } else if (state === "running") {
    const finished = files.filter((f) => f.status === "done" || f.status === "error").length;
    els.queueTitle.textContent = `Konwersja: ${finished} z ${runItems.length}`;
    els.queueAside.textContent = "Zapis obok oryginałów";
    els.queueAside.classList.remove("is-error");
  } else if (state === "done" && hasErr) {
    const errCount = files.filter((f) => f.status === "error").length;
    els.queueTitle.textContent = `Zakończono: ${okFiles.length} z ${files.length}`;
    els.queueAside.textContent = `${errCount} ${plural(errCount, ["błąd", "błędy", "błędów"])}`;
    els.queueAside.classList.add("is-error");
  }

  // Lista
  if (showQueue) els.queueList.innerHTML = files.map((f) => rowHtml(f, compact)).join("");

  // Postęp
  if (state === "running") setProgress(progressRatio());

  // Pasek akcji
  let status = "";
  let statusErr = false;
  if (notice) status = notice;
  else if (state === "empty") status = "Brak plików w kolejce";
  else if (state === "queue") {
    const n = files.filter((f) => f.status === "pending").length;
    status = `${n} ${plural(n, ["plik gotowy", "pliki gotowe", "plików gotowych"])} do konwersji`;
  } else if (state === "running") {
    const idx = current ? runItems.indexOf(current) + 1 : runItems.length;
    status = `Konwertuję plik ${idx} z ${runItems.length}`;
  } else if (state === "done" && hasErr) {
    const n = files.filter((f) => f.status === "error").length;
    status = `${n} ${plural(n, ["plik nie został przekonwertowany", "pliki nie zostały przekonwertowane", "plików nie zostało przekonwertowanych"])}`;
    statusErr = true;
  }
  els.actionStatus.textContent = status;
  els.actionStatus.classList.toggle("is-error", statusErr);
  els.actionButtons.innerHTML = buttonsFor(state, hasErr, okFiles.length > 0);
}

// ---------- Akcje ----------
async function addPaths(paths) {
  if (state === "running" || !paths || !paths.length) return;
  let found;
  try {
    found = await T.core.invoke("inspect_paths", { paths });
  } catch (e) {
    flash("Nie udało się odczytać plików: " + e);
    return;
  }
  if (state === "done") { files = []; }
  const known = new Set(files.map((f) => f.path));
  let added = 0;
  for (const f of found) {
    if (known.has(f.path)) continue;
    files.push({ ...f, status: "pending" });
    known.add(f.path);
    added++;
  }
  state = files.length ? "queue" : "empty";
  if (!added) flash(found.length ? "Te pliki są już na liście" : "Nie znaleziono plików JPG ani PNG");
  else render();
}

async function pickFiles() {
  try {
    const selected = await T.dialog.open({ multiple: true, filters: [{ name: "Obrazy", extensions: ["jpg", "jpeg", "png"] }] });
    if (selected) await addPaths(Array.isArray(selected) ? selected : [selected]);
  } catch (e) {
    flash("Nie udało się otworzyć okna wyboru plików");
  }
}

async function start() {
  const items = files.filter((f) => f.status === "pending");
  if (!items.length) return;
  runItems = items;
  cancelRequested = false;
  state = "running";
  render();

  const quality = Number(els.quality.value);
  const lossless = els.lossless.checked;
  for (const f of items) {
    if (cancelRequested) break;
    f.status = "converting";
    current = f;
    render();
    try {
      f.result = await T.core.invoke("convert_file", { path: f.path, quality, lossless });
      f.status = "done";
    } catch (e) {
      f.status = "error";
      f.error = String(e);
    }
    render();
  }
  current = null;
  state = files.some((f) => f.status === "pending") ? "queue" : "done";
  render();
}

function retryFailed() {
  files.forEach((f) => { if (f.status === "error") { f.status = "pending"; delete f.error; } });
  start();
}

async function reveal() {
  const first = files.find((f) => f.status === "done" && f.result);
  if (!first) return;
  try { await T.opener.revealItemInDir(first.result.output); }
  catch { flash("Nie udało się pokazać pliku w folderze"); }
}

function reset() {
  files = []; runItems = []; current = null; state = "empty";
  render();
}

// Delegacja zdarzeń (przyciski są renderowane dynamicznie)
els.actionButtons.addEventListener("click", (e) => {
  const id = e.target.closest("button")?.id;
  if (id === "startBtn") start();
  else if (id === "cancelBtn") { cancelRequested = true; flash("Kończę bieżący plik i zatrzymuję", 2500); }
  else if (id === "retryBtn") retryFailed();
  else if (id === "revealBtn") reveal();
  else if (id === "againBtn") reset();
});
els.queueList.addEventListener("click", (e) => {
  const path = e.target.closest("[data-remove]")?.dataset.remove;
  if (!path) return;
  files = files.filter((f) => f.path !== path);
  state = files.length ? "queue" : "empty";
  render();
});
els.clearBtn.addEventListener("click", reset);
els.pickBtn.addEventListener("click", pickFiles);

// ---------- Przeciąganie i upuszczanie (zdarzenia okna Tauri, dają pełne ścieżki) ----------
function setDragging(on, paths) {
  app.classList.toggle("is-dragging", on);
  if (on && paths) {
    const n = paths.length;
    const label = paths.every(isImagePath)
      ? `${n} ${plural(n, ["plik", "pliki", "plików"])}: JPG i PNG`
      : `${n} ${plural(n, ["element", "elementy", "elementów"])}`;
    els.dragCount.textContent = label;
    els.overlayCount.textContent = label;
  }
}

async function initDragDrop() {
  await T.webview.getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter") { if (state !== "running") setDragging(true, p.paths); }
    else if (p.type === "over") { if (state !== "running") app.classList.add("is-dragging"); }
    else if (p.type === "drop") { setDragging(false); addPaths(p.paths); }
    else { setDragging(false); } // "leave"
  });
}

// ---------- Start ----------
loadSettings();
render();
if (!T) {
  els.actionStatus.textContent = "Uruchom aplikację przez Tauri: npm run dev";
  els.pickBtn.disabled = true;
} else {
  initDragDrop().catch((e) => console.error("Nie udało się włączyć przeciągania plików", e));
}
