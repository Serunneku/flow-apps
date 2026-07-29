const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/10.13.0";

// --- IndexedDB storage ---
const DB_NAME = "noteflow";
const STORE = "notes";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(note) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Local prefs (theme) ---
const PREF_KEYS = {
  theme: "noteflow.theme",
  sort: "noteflow.sort",
  streakDate: "noteflow.streak.date",
  streakCount: "noteflow.streak.count",
  sound: "noteflow.sound",
  savedSearches: "noteflow.savedSearches",
  thickInk: "noteflow.thickInk",
  folderCovers: "noteflow.folderCovers",
};
const loadPref = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const savePref = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let notes = [];
let currentNote = null;
let searchQuery = "";
let activeFolderFilter = null;
let activeTagFilter = null;
let listView = "active"; // "active" | "archived" | "trash"
let selectionMode = false;
let selectedIds = new Set();

// --- Synthesized sound design (off by default — a note app should never
// make noise without being asked to) ---
let soundEnabled = loadPref(PREF_KEYS.sound, false);
let audioCtx = null;
let ambientFocusNode = null;

function getAudioCtx() {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, type, gainPeak) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(gainPeak ?? 0.05, ctx.currentTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.02);
}

// A very short, soft click — a pen tip touching paper — when a note is created.
function playCreateSound() {
  playTone(680, 0.05, "sine", 0.05);
}

// Two distinct, brief sonic signatures instead of one generic beep: a small
// ascending interval for success, a single lower note for a failure.
function playSaveSound() {
  playTone(520, 0.08, "sine", 0.04);
  setTimeout(() => playTone(780, 0.1, "sine", 0.035), 60);
}

function playErrorSound() {
  playTone(180, 0.18, "triangle", 0.05);
}

// A near-inaudible filtered noise loop for focus mode — the feel of a room
// that's alive rather than a flat digital silence. Opt-in, like every sound
// here, and only ever starts from a real user gesture.
function startAmbientFocusSound() {
  const ctx = getAudioCtx();
  if (!ctx || ambientFocusNode) return;
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 350;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start();
  gain.gain.linearRampToValueAtTime(0.006, ctx.currentTime + 1.2);
  ambientFocusNode = { noise, gain };
}

function stopAmbientFocusSound() {
  if (!ambientFocusNode) return;
  const ctx = getAudioCtx() || audioCtx;
  const { noise, gain } = ambientFocusNode;
  ambientFocusNode = null;
  if (!ctx) return;
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
  setTimeout(() => {
    try {
      noise.stop();
    } catch {
      /* already stopped */
    }
  }, 500);
}

// --- Theme ---
const themeToggle = document.getElementById("theme-toggle");
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_ICON = { auto: "contrast", light: "sun", dark: "moon" };
let theme = loadPref(PREF_KEYS.theme, "auto");

function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeToggle.innerHTML = `<svg class="icon"><use href="#icon-${THEME_ICON[t]}"/></svg>`;
}
applyTheme(theme);
themeToggle.addEventListener("click", (e) => {
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  const commit = () => {
    theme = nextTheme;
    savePref(PREF_KEYS.theme, theme);
    applyTheme(theme);
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reduceMotion) {
    commit();
    return;
  }
  // The theme change reveals itself as a circle expanding from the toggle
  // button, instead of a flat cross-fade — the same "iris" pattern as
  // Android 12/Material You's theme switch.
  const x = e.clientX;
  const y = e.clientY;
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(commit);
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
      { duration: 500, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  });
});

// --- Daily streak (local, based on days with at least one save) ---
const streakBadge = document.getElementById("streak-badge");
const dateKey = (ts) => new Date(ts).toISOString().slice(0, 10);

function updateStreakBadge() {
  const count = loadPref(PREF_KEYS.streakCount, 0);
  streakBadge.classList.toggle("hidden", count < 1);
  if (count >= 1) streakBadge.textContent = `🔥 ${count} jour${count > 1 ? "s" : ""}`;
}

function recordActivityToday() {
  const today = dateKey(Date.now());
  const last = loadPref(PREF_KEYS.streakDate, null);
  if (last === today) return;
  const yesterday = dateKey(Date.now() - 86400000);
  const count = last === yesterday ? loadPref(PREF_KEYS.streakCount, 0) + 1 : 1;
  savePref(PREF_KEYS.streakDate, today);
  savePref(PREF_KEYS.streakCount, count);
  updateStreakBadge();
}
updateStreakBadge();

// --- Overflow menus (list + editor "more" menus) ---
function setupMenu(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panel.classList.contains("hidden");
    document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".menu-wrap .icon-btn[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (willOpen) {
      panel.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });
  panel.addEventListener("click", (e) => {
    if (e.target.closest(".menu-item")) {
      panel.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
  return panel;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) {
    document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".menu-wrap .icon-btn[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".menu-wrap .icon-btn[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
});

// Every icon-only button that has a hover title but no explicit aria-label
// gets one automatically, so screen readers announce it (not just mouse hover).
document.querySelectorAll("button[title]:not([aria-label])").forEach((btn) => {
  btn.setAttribute("aria-label", btn.getAttribute("title"));
});
setupMenu("list-menu-btn", "list-menu");
setupMenu("editor-menu-btn", "editor-menu");

const soundToggleBtn = document.getElementById("sound-toggle-btn");
const soundToggleLabel = document.createTextNode("");
soundToggleBtn.innerHTML = '<svg class="icon"><use href="#icon-sound"/></svg>';
soundToggleBtn.appendChild(soundToggleLabel);
function updateSoundToggleLabel() {
  soundToggleLabel.textContent = soundEnabled ? "Sons : activés" : "Sons : désactivés";
}
updateSoundToggleLabel();
soundToggleBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  savePref(PREF_KEYS.sound, soundEnabled);
  updateSoundToggleLabel();
  if (soundEnabled) playCreateSound();
});

// --- High-contrast "thick ink" mode: a distinct accessibility mode from
// light/dark, for low-vision users — stronger borders/text, grain kept. ---
const contrastToggleBtn = document.getElementById("contrast-toggle-btn");
const contrastToggleLabel = document.createTextNode("");
contrastToggleBtn.innerHTML = '<svg class="icon"><use href="#icon-contrast"/></svg>';
contrastToggleBtn.appendChild(contrastToggleLabel);
let thickInkEnabled = loadPref(PREF_KEYS.thickInk, false);
function applyThickInk() {
  if (thickInkEnabled) document.documentElement.setAttribute("data-thick-ink", "true");
  else document.documentElement.removeAttribute("data-thick-ink");
  contrastToggleLabel.textContent = thickInkEnabled ? "Contraste renforcé : activé" : "Contraste renforcé : désactivé";
}
applyThickInk();
contrastToggleBtn.addEventListener("click", () => {
  thickInkEnabled = !thickInkEnabled;
  savePref(PREF_KEYS.thickInk, thickInkEnabled);
  applyThickInk();
});

// --- Custom dropdowns (native <select> stays as the source of truth; this
// only replaces how it's presented, so all existing "change" logic keeps working) ---
function enhanceSelect(select) {
  const wrap = document.createElement("div");
  wrap.className = "custom-select";
  if (select.id) wrap.dataset.for = select.id;
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("native-select-hidden");
  select.setAttribute("tabindex", "-1");
  select.setAttribute("aria-hidden", "true");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  if (select.title) trigger.title = select.title;
  wrap.appendChild(trigger);

  const list = document.createElement("div");
  list.className = "custom-select-list hidden";
  wrap.appendChild(list);

  function renderOptions() {
    list.innerHTML = "";
    Array.from(select.options).forEach((opt, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "custom-select-option" + (i === select.selectedIndex ? " selected" : "");
      item.textContent = opt.textContent;
      if (opt.style.fontFamily) item.style.fontFamily = opt.style.fontFamily;
      item.addEventListener("click", () => {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        refresh();
        closeList();
      });
      list.appendChild(item);
    });
  }
  function updateTrigger() {
    const opt = select.options[select.selectedIndex];
    trigger.textContent = opt ? opt.textContent : "";
  }
  function closeList() {
    list.classList.add("hidden");
    trigger.classList.remove("open");
  }
  function openList() {
    renderOptions();
    list.classList.remove("hidden");
    trigger.classList.add("open");
  }
  function refresh() {
    updateTrigger();
    if (!list.classList.contains("hidden")) renderOptions();
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".custom-select-list").forEach((l) => {
      if (l !== list) l.classList.add("hidden");
    });
    if (list.classList.contains("hidden")) openList();
    else closeList();
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) closeList();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeList();
  });

  updateTrigger();
  select._customSelectRefresh = refresh;
  return refresh;
}

document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".custom-select-trigger, .custom-select-option")) e.preventDefault();
});

function setPressed(el, state) {
  el.classList.toggle("active", state);
  el.setAttribute("aria-pressed", String(!!state));
}

// Wraps a critical/destructive action's click handler so a second click
// during the async operation is ignored instead of silently double-firing
// (e.g. a bulk delete run twice on a slow device). The button dims briefly
// and re-enables itself once the handler settles.
function guardDoubleClick(el, handler) {
  el.addEventListener("click", async (e) => {
    if (el.disabled) return;
    el.disabled = true;
    el.classList.add("busy-guard");
    try {
      await handler(e);
    } finally {
      setTimeout(() => {
        el.disabled = false;
        el.classList.remove("busy-guard");
      }, 400);
    }
  });
}

// A short burst of gold particles confirming a successful drag-and-drop,
// instead of only the (easy to miss) list re-render.
function spawnGoldDust(x, y) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const count = 8;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.className = "gold-dust";
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 16 + Math.random() * 18;
    dot.style.left = x + "px";
    dot.style.top = y + "px";
    dot.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    dot.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    document.body.appendChild(dot);
    dot.addEventListener("animationend", () => dot.remove());
  }
}

// --- Toast (with optional undo) ---
const toastEl = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastUndo = document.getElementById("toast-undo");
let toastTimer = null;

let toastIsUndoable = false;

function showToast(message, onUndo, options) {
  const { actionLabel, ctrlZ = true } = options || {};
  clearTimeout(toastTimer);
  // toast-text already carries role="status" (an implicit ARIA live
  // region), so every one of these warm, branded messages ("Note
  // verrouillée et chiffrée", not "Error: locked=true") is already
  // announced to screen readers — clearing first forces a re-announcement
  // even when two consecutive actions produce the exact same text.
  toastText.textContent = "";
  void toastText.offsetWidth;
  toastText.textContent = message;
  toastUndo.textContent = actionLabel || "Annuler";
  toastUndo.classList.toggle("hidden", !onUndo);
  toastEl.classList.remove("hidden");
  toastIsUndoable = !!onUndo && ctrlZ;
  toastUndo.onclick = () => {
    if (onUndo) onUndo();
    toastEl.classList.add("hidden");
    clearTimeout(toastTimer);
  };
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 5000);
}

function triggerToastUndo() {
  if (toastEl.classList.contains("hidden") || toastUndo.classList.contains("hidden") || !toastIsUndoable) return false;
  toastUndo.onclick();
  return true;
}

// --- Screens ---
const listScreen = document.getElementById("list-screen");
const editorScreen = document.getElementById("editor-screen");

function showList() {
  // Leaving a locked note's editor always re-locks it in memory too: its
  // plaintext body/drawing/history are dropped and the unlock key forgotten,
  // so reopening it requires the PIN again, exactly like before encryption.
  if (currentNote && currentNote.locked && activeUnlockKey && activeUnlockKey.noteId === currentNote.id) {
    currentNote.html = "";
    currentNote.drawing = null;
    currentNote.history = [];
    activeUnlockKey = null;
  }
  listScreen.classList.add("active");
  editorScreen.classList.remove("active");
  stopAmbientFocusSound();
  renderList();
}

function showEditor() {
  listScreen.classList.remove("active");
  editorScreen.classList.add("active");
}

// --- List rendering ---
const notesListEl = document.getElementById("notes-list");
const notesEmptyEl = document.getElementById("notes-empty");
const searchInput = document.getElementById("search-input");
const folderFiltersEl = document.getElementById("folder-filters");
const sortSelect = document.getElementById("sort-select");
let sortMode = loadPref(PREF_KEYS.sort, "recent");
sortSelect.value = sortMode;
sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value;
  savePref(PREF_KEYS.sort, sortMode);
  renderList();
});
enhanceSelect(sortSelect);

// --- Export / Import ---
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importInput = document.getElementById("import-input");

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `noteflow-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener("click", () => importInput.click());

// iCalendar (.ics) and vCard (.vcf) both fold long lines with a leading
// space/tab continuation — unfold before parsing either format.
function unfoldTextLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .reduce((acc, line) => {
      if ((line.startsWith(" ") || line.startsWith("\t")) && acc.length) {
        acc[acc.length - 1] += line.slice(1);
      } else {
        acc.push(line);
      }
      return acc;
    }, []);
}

function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

async function importIcs(text) {
  const lines = unfoldTextLines(text);
  let count = 0;
  let current = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      current = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (current) {
        const note = newNoteObject();
        note.title = current.summary || "Événement";
        note.folder = "Calendrier";
        const parts = [];
        if (current.dtstart) parts.push(`<p><strong>Début :</strong> ${current.dtstart.toLocaleString("fr-FR")}</p>`);
        if (current.dtend) parts.push(`<p><strong>Fin :</strong> ${current.dtend.toLocaleString("fr-FR")}</p>`);
        if (current.location) parts.push(`<p><strong>Lieu :</strong> ${escapeHtml(current.location)}</p>`);
        if (current.description) parts.push(`<p>${escapeHtml(current.description).replace(/\\n/g, "<br>")}</p>`);
        note.html = parts.join("") || "<p><em>Aucun détail.</em></p>";
        notes.unshift(note);
        await persistNote(note);
        count++;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (key === "SUMMARY") current.summary = value;
    else if (key === "LOCATION") current.location = value;
    else if (key === "DESCRIPTION") current.description = value;
    else if (key === "DTSTART") current.dtstart = parseIcsDate(value);
    else if (key === "DTEND") current.dtend = parseIcsDate(value);
  }
  renderList();
  return count;
}

async function importVcf(text) {
  const lines = unfoldTextLines(text);
  let count = 0;
  let current = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:VCARD")) {
      current = {};
      continue;
    }
    if (line.startsWith("END:VCARD")) {
      if (current) {
        const note = newNoteObject();
        note.title = current.fn || "Contact";
        note.folder = "Contacts";
        const parts = [];
        if (current.tel) parts.push(`<p><strong>Téléphone :</strong> ${escapeHtml(current.tel)}</p>`);
        if (current.email) parts.push(`<p><strong>Email :</strong> ${escapeHtml(current.email)}</p>`);
        if (current.org) parts.push(`<p><strong>Organisation :</strong> ${escapeHtml(current.org)}</p>`);
        note.html = parts.join("") || "<p><em>Aucune information supplémentaire.</em></p>";
        notes.unshift(note);
        await persistNote(note);
        count++;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (key === "FN") current.fn = value;
    else if (key === "TEL") current.tel = value;
    else if (key === "EMAIL") current.email = value;
    else if (key === "ORG") current.org = value.replace(/;/g, " · ");
  }
  renderList();
  return count;
}

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".ics")) {
      const count = await importIcs(await file.text());
      showToast(`${count} note${count > 1 ? "s" : ""} importée${count > 1 ? "s" : ""} depuis le calendrier`);
    } else if (name.endsWith(".vcf")) {
      const count = await importVcf(await file.text());
      showToast(`${count} note${count > 1 ? "s" : ""} importée${count > 1 ? "s" : ""} depuis les contacts`);
    } else if (name.endsWith(".noteflow")) {
      const packet = JSON.parse(await file.text());
      const count = await importEncryptedPacket(packet);
      if (count) showToast("Note déchiffrée et importée");
    } else {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // A single-note export (see "Exporter cette note") is a plain object,
      // not an array — accept both.
      const imported = Array.isArray(parsed) ? parsed : [parsed];
      let added = 0;
      let updated = 0;
      for (const note of imported) {
        if (!note || !note.id) continue;
        const index = notes.findIndex((n) => n.id === note.id);
        if (index === -1) {
          notes.push(note);
          added++;
        } else if ((note.updatedAt || 0) > (notes[index].updatedAt || 0)) {
          notes[index] = note;
          updated++;
        }
        await persistNote(note);
      }
      renderList();
      showToast(`Import terminé : ${added} ajoutée(s), ${updated} mise(s) à jour`);
    }
  } catch (err) {
    showToast("Import impossible : fichier invalide");
  }
  importInput.value = "";
});

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || "").trim();
}

// Parsing HTML for a text preview is the costliest part of rendering the list
// (worse with inline base64 images); cache it per note and only recompute
// when the note's html actually changed since the last render.
const previewCache = new Map();
function getPreview(note) {
  const cached = previewCache.get(note.id);
  if (cached && cached.html === note.html) return cached.text;
  const text = stripHtml(note.html);
  previewCache.set(note.id, { html: note.html, text });
  return text;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} j`;
  return new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// A continuous hue-from-hash (0-360°) can land two folders on hues that
// read as the same color under deuteranopia/protanopia (e.g. a muted red
// next to a muted green). This fixed set is built around the Okabe-Ito
// colorblind-safe palette instead, so any two folders stay visually
// distinguishable regardless of which two hashes collide.
const FOLDER_COLOR_PALETTE = [
  "#8a5f18", "#0072B2", "#009E73", "#D55E00",
  "#5B4FA0", "#CC79A7", "#3A6B8C", "#946A3D",
  "#2E7D6B", "#7A4B8A", "#B08600", "#4A5FA5",
];

function folderColor(folder) {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = folder.charCodeAt(i) + ((hash << 5) - hash);
  return FOLDER_COLOR_PALETTE[Math.abs(hash) % FOLDER_COLOR_PALETTE.length];
}

// A curated, restrained set of "cover" gradients a folder can be assigned to
// on purpose — not an arbitrary color/emoji picker, closer to choosing a
// binding cloth than tagging with a random color.
const FOLDER_COVER_TEXTURES = [
  "linear-gradient(135deg, #8a5f18, #b08600)",
  "linear-gradient(135deg, #0072B2, #4A5FA5)",
  "linear-gradient(135deg, #009E73, #2E7D6B)",
  "linear-gradient(135deg, #D55E00, #946A3D)",
  "linear-gradient(135deg, #5B4FA0, #7A4B8A)",
  "linear-gradient(135deg, #3A6B8C, #4A5FA5)",
];

function loadFolderCovers() {
  return loadPref(PREF_KEYS.folderCovers, {});
}
function saveFolderCovers(map) {
  savePref(PREF_KEYS.folderCovers, map);
}

function folderDisplayColor(folder) {
  const covers = loadFolderCovers();
  const idx = covers[folder];
  return idx !== undefined ? FOLDER_COVER_TEXTURES[idx] : folderColor(folder);
}

function allFolders() {
  return [...new Set(notes.map((n) => n.folder).filter(Boolean))];
}

function allTags() {
  return [...new Set(notes.flatMap((n) => n.tags || []))].sort((a, b) => a.localeCompare(b, "fr"));
}

// --- Global tag manager: rename (or merge, by renaming to an existing tag)
// across every note at once, instead of a tag being stuck forever once typed. ---
const tagManagerBtn = document.getElementById("manage-tags-btn");
const tagManagerPanel = document.getElementById("tag-manager-panel");
const tagManagerListEl = document.getElementById("tag-manager-list");

tagManagerBtn.addEventListener("click", () => {
  const opening = tagManagerPanel.classList.contains("hidden");
  tagManagerPanel.classList.toggle("hidden");
  if (opening) renderTagManager();
});

function renderTagManager() {
  const tags = allTags();
  tagManagerListEl.innerHTML = "";
  if (!tags.length) {
    tagManagerListEl.innerHTML = '<li class="history-empty">Aucun tag pour l\'instant.</li>';
    return;
  }
  tags.forEach((tag) => {
    const count = notes.filter((n) => (n.tags || []).includes(tag)).length;
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("span");
    label.textContent = `#${tag} (${count})`;
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "Renommer";
    renameBtn.addEventListener("click", async () => {
      const next = window.prompt(`Renommer #${tag} en :`, tag);
      if (!next || !next.trim() || next.trim() === tag) return;
      await renameTagEverywhere(tag, next.trim());
      renderTagManager();
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "link-btn danger";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", async () => {
      await renameTagEverywhere(tag, null);
      renderTagManager();
    });
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(label);
    li.appendChild(actions);
    tagManagerListEl.appendChild(li);
  });
}

// newTag === null removes the tag entirely (used by the "Supprimer" action);
// otherwise renaming onto an existing tag merges the two automatically,
// since tags are deduplicated per note.
async function renameTagEverywhere(oldTag, newTag) {
  const affected = notes.filter((n) => (n.tags || []).includes(oldTag));
  for (const note of affected) {
    const set = new Set(note.tags.map((t) => (t === oldTag ? newTag : t)).filter(Boolean));
    note.tags = [...set];
    await persistNote(note);
  }
  renderList();
  showToast(newTag ? `#${oldTag} renommé en #${newTag}` : `#${oldTag} supprimé de ${affected.length} note(s)`);
}

let draggedNoteId = null;

function reorderNotes(targetId) {
  if (!draggedNoteId || draggedNoteId === targetId) return;
  const fromIndex = notes.findIndex((n) => n.id === draggedNoteId);
  const toIndex = notes.findIndex((n) => n.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = notes.splice(fromIndex, 1);
  notes.splice(toIndex, 0, moved);
  notes.forEach((n, i) => {
    n.order = i;
    persistNote(n);
  });
  renderList();
}

function renderFolderFilters() {
  // Folders support "Parent/Enfant" paths: sorting alphabetically naturally
  // groups a parent next to its children, and selecting a parent also shows
  // notes filed one level (or more) below it — a lightweight hierarchy
  // without needing a full collapsible tree widget. Tag chips follow the
  // folder chips in the same row and combine with the folder filter (both
  // can be active together) rather than replacing it.
  const folders = allFolders().sort((a, b) => a.localeCompare(b, "fr"));
  const tags = allTags();
  folderFiltersEl.classList.toggle("hidden", folders.length === 0 && tags.length === 0);
  folderFiltersEl.innerHTML = "";
  folders.forEach((folder) => {
    const parts = folder.split("/");
    const depth = parts.length - 1;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter-chip folder-chip" + (activeFolderFilter === folder ? " active" : "");
    if (depth > 0) chip.style.marginLeft = `${depth * 14}px`;
    // A thicker "spine" for folders holding more notes — like books lined
    // up on a shelf by how full they are.
    const noteCount = notes.filter((n) => !n.deletedAt && (n.folder === folder || (n.folder || "").startsWith(folder + "/"))).length;
    chip.style.borderLeftWidth = `${Math.min(2 + Math.round(noteCount / 2), 8)}px`;
    chip.title = folder;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = (depth > 0 ? "↳ " : "") + parts[parts.length - 1];
    const coverSwatch = document.createElement("span");
    coverSwatch.className = "folder-cover-swatch";
    coverSwatch.style.background = folderDisplayColor(folder);
    coverSwatch.title = "Choisir une couverture pour ce dossier";
    coverSwatch.addEventListener("click", (e) => {
      e.stopPropagation();
      const covers = loadFolderCovers();
      const current = covers[folder] ?? -1;
      covers[folder] = (current + 1) % FOLDER_COVER_TEXTURES.length;
      saveFolderCovers(covers);
      renderFolderFilters();
    });
    chip.appendChild(labelSpan);
    chip.appendChild(coverSwatch);
    chip.addEventListener("click", () => {
      activeFolderFilter = activeFolderFilter === folder ? null : folder;
      renderList();
      // A brief "cover flip" on the list itself when entering/leaving a
      // folder — distinct from the note page-turn, since this is opening a
      // folder's cover rather than a single page.
      notesListEl.classList.remove("folder-flip");
      void notesListEl.offsetWidth;
      notesListEl.classList.add("folder-flip");
    });
    chip.addEventListener("dragover", (e) => e.preventDefault());
    chip.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggedNoteId) return;
      const note = notes.find((n) => n.id === draggedNoteId);
      if (note) {
        note.folder = folder;
        persistNote(note);
        spawnGoldDust(e.clientX, e.clientY);
        renderList();
      }
    });
    folderFiltersEl.appendChild(chip);
  });
  tags.forEach((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter-chip tag-chip" + (activeTagFilter === tag ? " active" : "");
    chip.textContent = "#" + tag;
    chip.addEventListener("click", () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      renderList();
    });
    folderFiltersEl.appendChild(chip);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    "<mark>" + escapeHtml(text.slice(idx, idx + query.length)) + "</mark>" +
    escapeHtml(text.slice(idx + query.length))
  );
}

const viewBanner = document.getElementById("view-banner");
const viewBannerTitle = document.getElementById("view-banner-title");
const viewBannerClose = document.getElementById("view-banner-close");
const VIEW_LABEL = { archived: "Archives", trash: "Corbeille" };

function setListView(view) {
  listView = view;
  activeFolderFilter = null;
  activeTagFilter = null;
  viewBanner.classList.toggle("hidden", view === "active");
  viewBannerTitle.textContent = VIEW_LABEL[view] || "";
  renderList();
}
viewBannerClose.addEventListener("click", () => setListView("active"));
document.getElementById("view-archive-btn").addEventListener("click", () => setListView("archived"));
document.getElementById("view-trash-btn").addEventListener("click", () => setListView("trash"));

// --- Multi-selection (bulk actions on the note list) ---
const selectionBar = document.getElementById("selection-bar");
const selectionCount = document.getElementById("selection-count");

function setSelectionMode(on) {
  selectionMode = on;
  if (!on) selectedIds.clear();
  selectionBar.classList.toggle("hidden", !on);
  renderList();
}

function updateSelectionCount() {
  selectionCount.textContent = `${selectedIds.size} sélectionnée${selectedIds.size > 1 ? "s" : ""}`;
}

function toggleSelect(id, li, checkbox) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  checkbox.checked = selectedIds.has(id);
  li.classList.toggle("selected", selectedIds.has(id));
  updateSelectionCount();
}

document.getElementById("select-mode-btn").addEventListener("click", () => setSelectionMode(true));
document.getElementById("sel-cancel-btn").addEventListener("click", () => setSelectionMode(false));

guardDoubleClick(document.getElementById("sel-archive-btn"), async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  for (const id of ids) {
    const note = notes.find((n) => n.id === id);
    if (note) {
      note.archived = true;
      await persistNote(note);
    }
  }
  showToast(`${ids.length} note${ids.length > 1 ? "s" : ""} archivée${ids.length > 1 ? "s" : ""}`);
  setSelectionMode(false);
});

guardDoubleClick(document.getElementById("sel-delete-btn"), async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const now = Date.now();
  for (const id of ids) {
    const note = notes.find((n) => n.id === id);
    if (note) {
      note.deletedAt = now;
      await persistNote(note);
    }
  }
  showToast(`${ids.length} note${ids.length > 1 ? "s" : ""} déplacée${ids.length > 1 ? "s" : ""} dans la corbeille`, async () => {
    for (const id of ids) {
      const note = notes.find((n) => n.id === id);
      if (note) {
        note.deletedAt = null;
        await persistNote(note);
      }
    }
    renderList();
  });
  setSelectionMode(false);
});

guardDoubleClick(document.getElementById("sel-move-btn"), async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const folder = window.prompt("Déplacer vers quel dossier ?", "");
  if (folder === null) return;
  for (const id of ids) {
    const note = notes.find((n) => n.id === id);
    if (note) {
      note.folder = folder.trim();
      await persistNote(note);
    }
  }
  showToast(`${ids.length} note${ids.length > 1 ? "s" : ""} déplacée${ids.length > 1 ? "s" : ""}`);
  setSelectionMode(false);
});

function renderList() {
  notesListEl.classList.toggle("selection-mode", selectionMode);
  if (selectionMode) updateSelectionCount();
  renderFolderFilters();
  renderSavedSearchChips();
  const query = searchQuery.trim().toLowerCase();
  let visible = notes.filter((n) => {
    if (listView === "trash" && !n.deletedAt) return false;
    if (listView === "archived" && (!n.archived || n.deletedAt)) return false;
    if (listView === "active" && (n.archived || n.deletedAt)) return false;
    if (
      activeFolderFilter &&
      n.folder !== activeFolderFilter &&
      !(n.folder || "").startsWith(activeFolderFilter + "/")
    )
      return false;
    if (activeTagFilter && !(n.tags || []).includes(activeTagFilter)) return false;
    if (query) {
      const haystack = (
        n.title +
        " " +
        (n.folder || "") +
        " " +
        (n.tags || []).join(" ") +
        " " +
        (n.locked ? "" : getPreview(n))
      ).toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  visible.sort((a, b) => {
    if (!!b.pinned - !!a.pinned !== 0) return !!b.pinned - !!a.pinned;
    if (sortMode === "manual") return (a.order ?? 0) - (b.order ?? 0);
    if (sortMode === "title") return (a.title || "").localeCompare(b.title || "", "fr");
    if (sortMode === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });

  notesListEl.classList.toggle("manual-mode", sortMode === "manual");
  notesListEl.innerHTML = "";
  notesEmptyEl.classList.toggle("show", visible.length === 0);

  visible.forEach((note, index) => {
    const li = document.createElement("li");
    li.className = "note-item note-in";
    li.style.animationDelay = `${Math.min(index, 12) * 28}ms`;
    const preview = note.locked
      ? "Note verrouillée"
      : getPreview(note) || (note.drawing && note.drawing.strokes.length ? "Dessin" : "Note vide");
    const badges =
      (note.pinned ? '<svg class="icon note-badge"><use href="#icon-pin"/></svg>' : "") +
      (note.locked ? '<svg class="icon note-badge"><use href="#icon-lock-closed"/></svg>' : "");
    const actions =
      listView === "trash"
        ? '<button class="note-action" data-action="restore" aria-label="Restaurer"><svg class="icon"><use href="#icon-undo"/></svg></button><button class="note-action danger" data-action="purge" aria-label="Supprimer définitivement"><svg class="icon"><use href="#icon-close"/></svg></button>'
        : listView === "archived"
        ? '<button class="note-action" data-action="unarchive" aria-label="Désarchiver"><svg class="icon"><use href="#icon-unarchive"/></svg></button>'
        : '<button class="note-action" data-action="delete" aria-label="Supprimer"><svg class="icon"><use href="#icon-close"/></svg></button>';
    li.innerHTML = `
      <input type="checkbox" class="note-select-checkbox" aria-label="Sélectionner cette note" />
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <div class="note-main">
        <div class="note-title">${badges}<span class="note-title-text"></span></div>
        <div class="note-preview"></div>
        <div class="note-meta">
          <span class="note-date"></span>
        </div>
      </div>
      <div class="note-actions">${actions}</div>
    `;
    if (note.color) li.style.backgroundColor = note.color;
    li.querySelector(".note-title-text").innerHTML = highlightMatch(note.title || "Sans titre", query);
    li.querySelector(".note-preview").innerHTML = note.locked ? preview : highlightMatch(preview, query);
    const dateEl = li.querySelector(".note-date");
    dateEl.textContent = timeAgo(note.updatedAt);
    const exactDate = new Date(note.updatedAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
    dateEl.title = exactDate;
    let longPressTimer = null;
    dateEl.addEventListener("touchstart", () => {
      longPressTimer = setTimeout(() => showToast(exactDate), 500);
    });
    dateEl.addEventListener("touchend", () => clearTimeout(longPressTimer));
    dateEl.addEventListener("touchmove", () => clearTimeout(longPressTimer));
    if (note.reminderAt && note.reminderAt > Date.now()) {
      const rem = document.createElement("span");
      rem.className = "note-reminder-chip";
      rem.innerHTML =
        '<svg class="icon"><use href="#icon-bell"/></svg> ' +
        new Date(note.reminderAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      li.querySelector(".note-meta").appendChild(rem);
    }
    if (note.expiresAt && note.expiresAt > Date.now()) {
      const eph = document.createElement("span");
      eph.className = "note-reminder-chip";
      eph.innerHTML =
        '<svg class="icon"><use href="#icon-clock"/></svg> s\'efface ' +
        new Date(note.expiresAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      li.querySelector(".note-meta").appendChild(eph);
    }
    if (note.folder) {
      const chip = document.createElement("span");
      chip.className = "note-folder-chip";
      chip.style.background = folderDisplayColor(note.folder);
      chip.textContent = note.folder;
      li.querySelector(".note-meta").appendChild(chip);
    }
    (note.tags || []).forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "note-tag-chip";
      chip.textContent = "#" + tag;
      li.querySelector(".note-meta").appendChild(chip);
    });
    const checkbox = li.querySelector(".note-select-checkbox");
    checkbox.checked = selectedIds.has(note.id);
    li.classList.toggle("selected", selectedIds.has(note.id));
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelect(note.id, li, checkbox);
    });
    li.querySelector(".note-main").addEventListener("click", () => {
      if (selectionMode) {
        toggleSelect(note.id, li, checkbox);
        return;
      }
      if (listView === "trash") {
        showToast("Restaure la note pour l'ouvrir");
        return;
      }
      openNote(note.id);
    });
    li.querySelector(".note-actions").addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest(".note-action");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "delete") {
        // A crumple, not a fade — the same physical gesture as throwing a
        // real sheet of paper away, echoing the carnet metaphor.
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          deleteNote(note.id);
        } else {
          li.classList.add("crumple-out");
          li.addEventListener("animationend", () => deleteNote(note.id), { once: true });
        }
      } else if (action === "restore") restoreNote(note.id);
      else if (action === "purge") permanentlyDeleteNote(note.id);
      else if (action === "unarchive") setNoteArchived(note.id, false);
    });
    li.draggable = true;
    li.addEventListener("dragstart", () => {
      draggedNoteId = note.id;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      draggedNoteId = null;
    });
    li.addEventListener("dragover", (e) => {
      if (sortMode !== "manual") return;
      e.preventDefault();
      li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
    li.addEventListener("drop", (e) => {
      if (sortMode !== "manual") return;
      e.preventDefault();
      li.classList.remove("drag-over");
      reorderNotes(note.id);
    });
    notesListEl.appendChild(li);
  });
}

let searchDebounceTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = searchInput.value;
    renderList();
  }, 150);
});

// --- Saved searches: pin the current query + folder/tag filter combo as a
// chip, instead of a whole new "smart folder" concept parallel to real ones ---
const savedSearchChipsEl = document.getElementById("saved-search-chips");
const saveSearchBtn = document.getElementById("save-search-btn");

function loadSavedSearches() {
  return loadPref(PREF_KEYS.savedSearches, []);
}
function persistSavedSearches(list) {
  savePref(PREF_KEYS.savedSearches, list);
}

function renderSavedSearchChips() {
  const saved = loadSavedSearches();
  savedSearchChipsEl.classList.toggle("hidden", saved.length === 0);
  savedSearchChipsEl.innerHTML = "";
  saved.forEach((s) => {
    const chip = document.createElement("span");
    chip.className = "tag-filter-chip saved-search-chip";
    const isActive = searchQuery === s.query && activeFolderFilter === s.folder && activeTagFilter === s.tag;
    chip.classList.toggle("active", isActive);
    const label = document.createElement("button");
    label.type = "button";
    label.textContent = "★ " + s.label;
    label.addEventListener("click", () => {
      searchQuery = s.query || "";
      searchInput.value = searchQuery;
      activeFolderFilter = s.folder || null;
      activeTagFilter = s.tag || null;
      renderList();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-search-remove";
    remove.setAttribute("aria-label", "Supprimer cette recherche enregistrée");
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      persistSavedSearches(loadSavedSearches().filter((x) => x.id !== s.id));
      renderSavedSearchChips();
    });
    chip.appendChild(label);
    chip.appendChild(remove);
    savedSearchChipsEl.appendChild(chip);
  });
}
renderSavedSearchChips();

saveSearchBtn.addEventListener("click", () => {
  if (!searchQuery.trim() && !activeFolderFilter && !activeTagFilter) {
    showToast("Fais d'abord une recherche ou choisis un filtre à enregistrer");
    return;
  }
  const defaultLabel = searchQuery.trim() || activeTagFilter || activeFolderFilter || "Recherche";
  const label = window.prompt("Nom de cette recherche enregistrée :", defaultLabel);
  if (!label) return;
  const saved = loadSavedSearches();
  saved.push({
    id: crypto.randomUUID(),
    label: label.trim(),
    query: searchQuery,
    folder: activeFolderFilter,
    tag: activeTagFilter,
  });
  persistSavedSearches(saved);
  renderSavedSearchChips();
  showToast("Recherche enregistrée");
});

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function deleteNote(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.deletedAt = Date.now();
  await persistNote(note);
  renderList();
  if (navigator.vibrate) navigator.vibrate(10);
  showToast("Note déplacée dans la corbeille", async () => {
    note.deletedAt = null;
    await persistNote(note);
    renderList();
  });
}

async function restoreNote(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.deletedAt = null;
  await persistNote(note);
  renderList();
  showToast("Note restaurée");
}

async function permanentlyDeleteNote(id) {
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) return;
  notes = notes.filter((n) => n.id !== id);
  await removeNoteEverywhere(id);
  renderList();
  // A distinct two-beat pattern for the one delete that can't be undone,
  // instead of the same generic buzz as every other (reversible) action.
  if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
  showToast("Note supprimée définitivement");
}

async function setNoteArchived(id, archived) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.archived = archived;
  await persistNote(note);
  renderList();
  showToast(archived ? "Note archivée" : "Note désarchivée");
}

async function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const toPurge = notes.filter((n) => n.deletedAt && n.deletedAt < cutoff);
  if (!toPurge.length) return;
  notes = notes.filter((n) => !(n.deletedAt && n.deletedAt < cutoff));
  await Promise.all(toPurge.map((n) => removeNoteEverywhere(n.id)));
}

// --- Editor ---
const titleInput = document.getElementById("title-input");
const folderInput = document.getElementById("folder-input");
const tagsInput = document.getElementById("tags-input");
const textEditor = document.getElementById("text-editor");
const backBtn = document.getElementById("back-btn");
const pinBtn = document.getElementById("pin-btn");
const deleteNoteBtn = document.getElementById("delete-note-btn");
const saveIndicator = document.getElementById("save-indicator");
const newNoteBtn = document.getElementById("new-note-btn");
const duplicateNoteBtn = document.getElementById("duplicate-note-btn");
const wordCountEl = document.getElementById("word-count");
const sizeSelect = document.getElementById("size-select");
enhanceSelect(sizeSelect);

function newNoteObject() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    html: "",
    folder: "",
    tags: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    order: notes.length ? Math.min(...notes.map((n) => n.order ?? 0)) - 1 : 0,
    drawing: null,
    pageHeight: 700,
    fontSize: 15,
    locked: false,
    pinCode: null,
    pinSalt: null,
    encBlob: null,
    reminderAt: null,
    expiresAt: null,
    reminderFired: false,
    history: [],
    color: null,
    paperStyle: "blank",
    archived: false,
    deletedAt: null,
  };
}

let displayedWordCount = 0;
let wordCountAnimFrame = null;

function formatWordCount(words, chars) {
  return words ? `${words} mot${words > 1 ? "s" : ""} · ${chars} car.` : "";
}

// The count "rolls" from its previous value to the new one, like an odometer,
// instead of jumping straight to the new number on every keystroke.
function updateWordCount(instant) {
  const text = textEditor.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.length;
  textEditor.classList.toggle("long-note", words > 200);
  bookmarkRibbonEl.classList.toggle("hidden", words <= 200);
  cancelAnimationFrame(wordCountAnimFrame);
  if (instant) {
    displayedWordCount = words;
    wordCountEl.textContent = formatWordCount(words, chars);
    return;
  }
  const startWords = displayedWordCount;
  const startTime = performance.now();
  const duration = 300;
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(startWords + (words - startWords) * eased);
    wordCountEl.textContent = formatWordCount(current, chars);
    if (t < 1) wordCountAnimFrame = requestAnimationFrame(step);
    else displayedWordCount = words;
  };
  wordCountAnimFrame = requestAnimationFrame(step);
}

async function openNote(id) {
  currentNote = notes.find((n) => n.id === id);
  if (!currentNote) return;
  if (currentNote.locked) {
    showLockOverlay();
    return;
  }
  loadNoteIntoEditor();
  showEditor();
}

function parseTags(raw) {
  return [...new Set((raw || "").split(/[,#]/).map((t) => t.trim()).filter(Boolean))];
}

function loadNoteIntoEditor() {
  titleInput.value = currentNote.title || "";
  folderInput.value = currentNote.folder || "";
  tagsInput.value = (currentNote.tags || []).join(", ");
  textEditor.innerHTML = currentNote.html || "";
  refreshTransclusions();
  setPressed(pinBtn, !!currentNote.pinned);
  setLockIcon(!!currentNote.locked);
  setPressed(lockBtn, !!currentNote.locked);
  saveIndicator.textContent = "";
  notePage.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.fontSize = (currentNote.fontSize || 15) + "px";
  sizeSelect.value = String(currentNote.fontSize || 15);
  if (sizeSelect._customSelectRefresh) sizeSelect._customSelectRefresh();
  reminderPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
  backlinksPanel.classList.add("hidden");
  ephemeralPanel.classList.add("hidden");
  colorPanel.classList.add("hidden");
  paperPanel.classList.add("hidden");
  findPanel.classList.add("hidden");
  reminderInput.value = currentNote.reminderAt ? toLocalDatetimeValue(currentNote.reminderAt) : "";
  editorScreen.classList.remove("focus-mode");
  stopAmbientFocusSound();
  notePage.style.backgroundColor = currentNote.color || "";
  notePage.dataset.paper = currentNote.paperStyle || "blank";
  updateNoteColorSelection();
  updatePaperStyleSelection();
  updateArchiveMenuItem();
  updateWordCount(true);
  updatePageFolio();
  notePage.classList.remove("page-turn");
  void notePage.offsetWidth;
  notePage.classList.add("page-turn");
  setMode("text");
  setTimeout(() => {
    initCanvasSize();
    redrawStrokes();
  }, 0);
}

sizeSelect.addEventListener("change", () => {
  const size = Number(sizeSelect.value);
  textEditor.style.fontSize = size + "px";
  currentNote.fontSize = size;
  scheduleSave();
});

duplicateNoteBtn.addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour la dupliquer");
    return;
  }
  flushSave(true);
  const copy = JSON.parse(JSON.stringify(currentNote));
  copy.id = crypto.randomUUID();
  copy.title = (currentNote.title || "Sans titre") + " (copie)";
  copy.pinned = false;
  const now = Date.now();
  copy.createdAt = now;
  copy.updatedAt = now;
  notes.unshift(copy);
  await persistNote(copy);
  currentNote = copy;
  loadNoteIntoEditor();
  showToast("Note dupliquée");
});

// --- Reversible note splitting: one note per H2 heading, each linked back
// to the original via a wikilink (reuses the existing backlinks panel). ---
document.getElementById("split-note-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour la scinder");
    return;
  }
  flushSave(true);
  // childNodes, not children: a fresh note's very first typed line can be a
  // bare top-level text node (no <p> wrapper yet) — .children alone would
  // silently drop it from the "intro" section.
  const children = Array.from(textEditor.childNodes);
  const splitIndices = children.map((el, i) => (el.nodeType === 1 && el.tagName === "H2" ? i : -1)).filter((i) => i >= 0);
  if (!splitIndices.length) {
    showToast("Aucun titre (H2) trouvé pour scinder cette note");
    return;
  }
  const introNodes = children.slice(0, splitIndices[0]);
  const sections = splitIndices.map((startIdx, i) => {
    const endIdx = i + 1 < splitIndices.length ? splitIndices[i + 1] : children.length;
    return children.slice(startIdx, endIdx);
  });
  const originalId = currentNote.id;
  const originalTitle = currentNote.title || "Sans titre";
  const originalHtmlBackup = currentNote.html;
  const createdIds = [];
  const now = Date.now();
  for (const section of sections) {
    const [h2, ...rest] = section;
    const childNote = newNoteObject();
    childNote.title = h2.textContent.trim() || "Sans titre";
    childNote.folder = currentNote.folder;
    childNote.createdAt = now;
    childNote.updatedAt = now;
    const backlinkP = document.createElement("p");
    const a = document.createElement("a");
    a.href = "#";
    a.className = "wikilink";
    a.dataset.noteId = originalId;
    a.textContent = originalTitle;
    backlinkP.appendChild(document.createTextNode("↩ Scindée depuis "));
    backlinkP.appendChild(a);
    const wrapper = document.createElement("div");
    wrapper.appendChild(backlinkP);
    rest.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
    childNote.html = wrapper.innerHTML;
    notes.unshift(childNote);
    await persistNote(childNote);
    createdIds.push(childNote.id);
  }
  const introWrapper = document.createElement("div");
  introNodes.forEach((n) => introWrapper.appendChild(n.cloneNode(true)));
  currentNote.html = introWrapper.innerHTML;
  currentNote.updatedAt = now;
  await persistNote(currentNote);
  textEditor.innerHTML = currentNote.html;
  updateWordCount(true);
  renderList();
  showToast(
    `Note scindée en ${sections.length} nouvelle${sections.length > 1 ? "s" : ""} note${sections.length > 1 ? "s" : ""}`,
    async () => {
      currentNote.html = originalHtmlBackup;
      currentNote.updatedAt = Date.now();
      await persistNote(currentNote);
      for (const id of createdIds) {
        notes = notes.filter((n) => n.id !== id);
        await removeNoteEverywhere(id);
      }
      textEditor.innerHTML = currentNote.html;
      updateWordCount(true);
      renderList();
    }
  );
});

// --- Automatic task extraction: scan free-text sentences for common French
// action-triggering phrases, turn each into a real checkbox — entirely
// local heuristic, no data ever leaves the device. ---
const TASK_PATTERNS = [
  /\bil faut\s+(.+)/i,
  /\bje dois\s+(.+)/i,
  /\bpenser à\s+(.+)/i,
  /\bne pas oublier de\s+(.+)/i,
  /\b(?:todo|à faire)\s*:\s*(.+)/i,
];

document.getElementById("extract-tasks-btn").addEventListener("click", () => {
  const text = textEditor.textContent || "";
  const sentences = text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const found = [];
  sentences.forEach((s) => {
    for (const re of TASK_PATTERNS) {
      const m = s.match(re);
      if (m) {
        found.push((m[1] || s).replace(/[.!]+$/, "").trim());
        break;
      }
    }
  });
  if (!found.length) {
    showToast("Aucune tâche détectée dans le texte");
    return;
  }
  const header = document.createElement("p");
  header.innerHTML = "<strong>Tâches extraites :</strong>";
  const ul = document.createElement("ul");
  ul.className = "checklist";
  found.forEach((task) => {
    const li = makeChecklistLi();
    li.querySelector("span").textContent = task;
    ul.appendChild(li);
  });
  textEditor.appendChild(header);
  textEditor.appendChild(ul);
  scheduleSave();
  updateWordCount();
  showToast(`${found.length} tâche${found.length > 1 ? "s" : ""} extraite${found.length > 1 ? "s" : ""}`);
});

// --- Share / export a single note ---
document.getElementById("share-note-btn").addEventListener("click", async () => {
  const title = titleInput.value.trim() || "Note NoteFlow";
  const text = (titleInput.value.trim() ? title + "\n\n" : "") + textEditor.textContent.trim();
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
    } catch {
      /* user cancelled the native share sheet: nothing to do */
    }
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    showToast("Copié dans le presse-papiers");
  } else {
    showToast("Partage non disponible sur ce navigateur");
  }
});

async function noteForExport(note) {
  if (note.locked && activeUnlockKey && activeUnlockKey.noteId === note.id) {
    const blob = JSON.stringify({ html: note.html, drawing: note.drawing, history: note.history });
    const enc = await encryptString(activeUnlockKey.key, blob);
    return { ...note, html: "", drawing: null, history: [], encBlob: enc };
  }
  return note;
}

document.getElementById("export-note-btn").addEventListener("click", async () => {
  await flushSave(true);
  const exportNote = await noteForExport(currentNote);
  const blob = new Blob([JSON.stringify(exportNote, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(exportNote.title || "note").replace(/[^\w\- ]+/g, "").trim() || "note"}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// A single self-contained HTML file (inline CSS, no external requests) —
// the user hosts it wherever they like; NoteFlow never becomes a publisher.
document.getElementById("export-webpage-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour l'exporter");
    return;
  }
  await flushSave(true);
  const title = escapeHtml(currentNote.title || "Sans titre");
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {
    margin: 0;
    padding: 48px 20px;
    background: #f0e9dc;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
  }
  .page {
    max-width: 640px;
    width: 100%;
    background: #fffdf8;
    color: #17140f;
    border-radius: 16px;
    padding: 40px 36px;
    box-shadow: 0 1px 3px rgba(23,20,15,0.07), 3px 18px 40px rgba(23,20,15,0.11);
    line-height: 1.65;
  }
  h1 { font-size: 26px; margin: 0 0 20px; letter-spacing: -0.01em; }
  h2 { font-size: 19px; margin: 1.2em 0 0.5em; }
  a { color: #8a5f18; }
  img { max-width: 100%; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td { border: 1px solid rgba(23,20,15,0.15); padding: 6px 10px; }
  .footer { margin-top: 32px; font-size: 12px; color: #6e6656; text-align: center; }
</style>
</head>
<body>
  <div class="page">
    <h1>${title}</h1>
    ${currentNote.html || "<p><em>Note vide.</em></p>"}
    <p class="footer">Exporté depuis NoteFlow</p>
  </div>
</body>
</html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(currentNote.title || "note").replace(/[^\w\- ]+/g, "").trim() || "note"}.html`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Page web exportée");
});

// A password-encrypted, self-contained .noteflow file — the honest
// alternative to "share end-to-end with a contact" without a key-exchange
// server: the sender picks a password and passes it along whatever channel
// they already trust (a call, a different app), the recipient imports the
// file and is prompted for that same password.
document.getElementById("share-encrypted-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour la partager");
    return;
  }
  await flushSave(true);
  const password = window.prompt("Mot de passe pour chiffrer ce fichier (à transmettre par un autre canal) :");
  if (!password) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const payload = JSON.stringify({ title: currentNote.title, html: currentNote.html, drawing: currentNote.drawing });
  const enc = await encryptString(key, payload);
  const packet = { format: "noteflow-encrypted-v1", salt: bytesToB64(salt), enc };
  const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(currentNote.title || "note").replace(/[^\w\- ]+/g, "").trim() || "note"}.noteflow`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Fichier chiffré exporté");
});

async function importEncryptedPacket(packet) {
  const password = window.prompt("Mot de passe pour déchiffrer ce fichier :");
  if (!password) return 0;
  try {
    const key = await deriveKey(password, b64ToBytes(packet.salt));
    const payload = JSON.parse(await decryptString(key, packet.enc));
    const note = newNoteObject();
    note.title = payload.title || "Note importée";
    note.html = payload.html || "";
    note.drawing = payload.drawing || null;
    notes.unshift(note);
    await persistNote(note);
    renderList();
    return 1;
  } catch {
    showToast("Mot de passe incorrect ou fichier invalide");
    return 0;
  }
}

newNoteBtn.addEventListener("click", async () => {
  currentNote = newNoteObject();
  notes.unshift(currentNote);
  await persistNote(currentNote);
  playCreateSound();
  loadNoteIntoEditor();
  showEditor();
  titleInput.focus();
});

backBtn.addEventListener("click", () => {
  flushSave(true);
  showList();
});

pinBtn.addEventListener("click", () => {
  currentNote.pinned = !currentNote.pinned;
  setPressed(pinBtn, currentNote.pinned);
  scheduleSave();
});

deleteNoteBtn.addEventListener("click", () => {
  const id = currentNote.id;
  showList();
  deleteNote(id);
});

// --- Archive ---
const archiveBtn = document.getElementById("archive-btn");
function updateArchiveMenuItem() {
  archiveBtn.innerHTML = currentNote.archived
    ? '<svg class="icon"><use href="#icon-unarchive"/></svg>Désarchiver'
    : '<svg class="icon"><use href="#icon-archive"/></svg>Archiver';
}
archiveBtn.addEventListener("click", async () => {
  const archived = !currentNote.archived;
  await setNoteArchived(currentNote.id, archived);
  showList();
});

// --- Print / export to PDF ---
document.getElementById("print-btn").addEventListener("click", () => {
  flushSave(true);
  window.print();
});

// --- Note background color ---
const colorPanel = document.getElementById("color-panel");
const noteColorRow = document.getElementById("note-color-row");
const NOTE_COLORS = [
  { key: null, label: "Aucune" },
  { key: "rgba(255, 214, 10, 0.18)", label: "Jaune" },
  { key: "rgba(255, 149, 0, 0.18)", label: "Orange" },
  { key: "rgba(255, 69, 58, 0.15)", label: "Rouge" },
  { key: "rgba(255, 55, 95, 0.13)", label: "Rose" },
  { key: "rgba(191, 90, 242, 0.15)", label: "Violet" },
  { key: "rgba(10, 132, 255, 0.15)", label: "Bleu" },
  { key: "rgba(52, 199, 89, 0.15)", label: "Vert" },
];
NOTE_COLORS.forEach((c) => {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "color-swatch note-color-swatch";
  swatch.title = c.label;
  swatch.style.background = c.key || "var(--paper)";
  swatch.dataset.color = c.key || "";
  swatch.addEventListener("click", () => {
    currentNote.color = c.key;
    notePage.style.backgroundColor = c.key || "";
    updateNoteColorSelection();
    scheduleSave();
    colorPanel.classList.add("hidden");
  });
  noteColorRow.appendChild(swatch);
});
function updateNoteColorSelection() {
  const current = currentNote.color || "";
  noteColorRow.querySelectorAll(".note-color-swatch").forEach((s) => {
    s.classList.toggle("selected", s.dataset.color === current);
  });
}
document.getElementById("color-btn").addEventListener("click", () => {
  paperPanel.classList.add("hidden");
  colorPanel.classList.toggle("hidden");
});

// --- Paper style ---
const paperPanel = document.getElementById("paper-panel");
const paperStyleRow = document.getElementById("paper-style-row");
const PAPER_STYLES = [
  { key: "blank", label: "Blanc" },
  { key: "lined", label: "Ligné" },
  { key: "grid", label: "Grille" },
  { key: "dots", label: "Points" },
];
PAPER_STYLES.forEach((p) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "paper-style-btn";
  btn.dataset.paper = p.key;
  btn.innerHTML = `<span class="paper-style-preview" data-paper="${p.key}"></span><span>${p.label}</span>`;
  btn.addEventListener("click", () => {
    currentNote.paperStyle = p.key;
    notePage.dataset.paper = p.key;
    updatePaperStyleSelection();
    scheduleSave();
    paperPanel.classList.add("hidden");
  });
  paperStyleRow.appendChild(btn);
});
function updatePaperStyleSelection() {
  const current = currentNote.paperStyle || "blank";
  paperStyleRow.querySelectorAll(".paper-style-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.paper === current);
  });
}
document.getElementById("paper-btn").addEventListener("click", () => {
  colorPanel.classList.add("hidden");
  paperPanel.classList.toggle("hidden");
});

let saveTimer = null;
function scheduleSave() {
  saveIndicator.textContent = "…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(false), 500);
}

// Version history keeps up to 20 full-text snapshots per note. Base64 images
// inline in the html would get duplicated in every single one of them, so
// history snapshots keep the text/formatting but drop embedded images
// (restoring an old version restores the text; the current images stay put).
function stripImagesForHistory(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  div.querySelectorAll("img").forEach((img) => img.remove());
  return div.innerHTML;
}

function pushHistorySnapshot() {
  if (!currentNote.history) currentNote.history = [];
  currentNote.history.push({ title: currentNote.title, html: stripImagesForHistory(currentNote.html), ts: Date.now() });
  if (currentNote.history.length > 20) currentNote.history.shift();
}

async function flushSave(immediate) {
  if (!currentNote) return;
  clearTimeout(saveTimer);
  const newTitle = titleInput.value.trim();
  const newHtml = textEditor.innerHTML;
  if (immediate && (currentNote.html || "") !== newHtml && (currentNote.html || currentNote.title)) {
    pushHistorySnapshot();
  }
  currentNote.title = newTitle;
  currentNote.folder = folderInput.value.trim();
  currentNote.tags = parseTags(tagsInput.value);
  currentNote.html = newHtml;
  currentNote.updatedAt = Date.now();
  try {
    await persistNote(currentNote);
    if (!immediate) {
      saveIndicator.textContent = "Enregistré";
      saveIndicator.classList.remove("ink-dry");
      void saveIndicator.offsetWidth;
      saveIndicator.classList.add("ink-dry");
      playSaveSound();
    }
  } catch (err) {
    console.error("Échec de la sauvegarde", err);
    saveIndicator.textContent = "Erreur";
    playErrorSound();
  }
}

titleInput.addEventListener("input", scheduleSave);
folderInput.addEventListener("change", scheduleSave);
tagsInput.addEventListener("change", scheduleSave);
textEditor.addEventListener("input", () => {
  scheduleSave();
  updateWordCount();
});

let lastKeystrokeTime = 0;
let typingFastTimer = null;
textEditor.addEventListener("input", () => {
  const now = performance.now();
  if (now - lastKeystrokeTime < 250) {
    textEditor.classList.add("typing-fast");
    clearTimeout(typingFastTimer);
    typingFastTimer = setTimeout(() => textEditor.classList.remove("typing-fast"), 400);
  }
  lastKeystrokeTime = now;
});

// --- Mode switch (unified page: text vs draw) ---
const notePage = document.getElementById("note-page");
const bookmarkRibbonEl = document.getElementById("bookmark-ribbon");
const pageScrollEl = document.getElementById("page-scroll");
pageScrollEl.addEventListener("scroll", () => {
  const max = pageScrollEl.scrollHeight - pageScrollEl.clientHeight;
  const depth = max > 0 ? Math.min(1, pageScrollEl.scrollTop / max) : 0;
  notePage.style.setProperty("--scroll-depth", depth.toFixed(2));
});
const modeTextBtn = document.getElementById("mode-text-btn");
const modeDrawBtn = document.getElementById("mode-draw-btn");
const drawToolbar = document.getElementById("draw-toolbar");
const growPageBtn = document.getElementById("grow-page-btn");
const pageFolioEl = document.getElementById("page-folio");

// Easter egg: triple-tap the bottom-right corner of an empty note to fold
// it back like a dog-eared page, revealing a short quote about writing.
const cornerFold = document.getElementById("corner-fold");
const WRITING_QUOTES = [
  "« Il n'y a rien à écrire. Il n'y a qu'à s'asseoir devant une machine à écrire et saigner. » — attribué à Hemingway",
  "« Une page blanche est un champ de bataille. » — Eugène Delacroix",
  "« J'écris pour découvrir ce que je pense. » — Joan Didion",
  "« Le premier jet de tout est mauvais. » — attribué à Hemingway",
  "« Écrire, c'est réécrire. » — proverbe d'atelier",
];
let cornerTapTimes = [];
let writingQuoteEl = null;
cornerFold.addEventListener("click", () => {
  if (textEditor.textContent.trim()) return;
  const now = Date.now();
  cornerTapTimes = cornerTapTimes.filter((t) => now - t < 700);
  cornerTapTimes.push(now);
  if (cornerTapTimes.length < 3) return;
  cornerTapTimes = [];
  const quote = WRITING_QUOTES[Math.floor(Math.random() * WRITING_QUOTES.length)];
  if (!writingQuoteEl) {
    writingQuoteEl = document.createElement("div");
    writingQuoteEl.className = "writing-quote";
    notePage.appendChild(writingQuoteEl);
  }
  writingQuoteEl.textContent = quote;
  writingQuoteEl.classList.remove("show");
  void writingQuoteEl.offsetWidth;
  writingQuoteEl.classList.add("show");
  setTimeout(() => writingQuoteEl.classList.remove("show"), 2000);
});

// Purely decorative folio number, like a bound book — only appears once the
// page has actually been grown at least once via "+ Agrandir la page".
function updatePageFolio() {
  const pages = Math.round((currentNote.pageHeight || 700) / 700);
  pageFolioEl.classList.toggle("hidden", pages <= 1);
  pageFolioEl.textContent = pages > 1 ? String(pages) : "";
}

function setMode(mode) {
  notePage.classList.toggle("mode-text", mode === "text");
  notePage.classList.toggle("mode-draw", mode === "draw");
  setPressed(modeTextBtn, mode === "text");
  setPressed(modeDrawBtn, mode === "draw");
  document.getElementById("format-toolbar").classList.toggle("hidden", mode !== "text");
  drawToolbar.classList.toggle("hidden", mode !== "draw");
  drawHint.classList.toggle("hidden", mode !== "draw");
  textEditor.contentEditable = mode === "text" ? "true" : "false";
  if (mode === "text") setTimeout(() => textEditor.focus(), 0);
}

modeTextBtn.addEventListener("click", () => setMode("text"));
modeDrawBtn.addEventListener("click", () => setMode("draw"));

// --- Focus mode ---
const focusBtn = document.getElementById("focus-btn");
focusBtn.addEventListener("click", () => {
  const entering = editorScreen.classList.toggle("focus-mode");
  if (entering) startAmbientFocusSound();
  else {
    stopAmbientFocusSound();
    notePage.style.removeProperty("--grain-x");
    notePage.style.removeProperty("--grain-y");
  }
});

// The paper grain drifts a couple pixels against the cursor in focus mode —
// like a sheet of paper on a desk, viewed from a slightly shifting angle.
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
document.addEventListener("mousemove", (e) => {
  if (!editorScreen.classList.contains("focus-mode") || reduceMotionQuery.matches) return;
  const rect = notePage.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width - 0.5;
  const relY = (e.clientY - rect.top) / rect.height - 0.5;
  notePage.style.setProperty("--grain-x", `${(-relX * 4).toFixed(2)}px`);
  notePage.style.setProperty("--grain-y", `${(-relY * 4).toFixed(2)}px`);
});

// --- PIN lock ---
const lockBtn = document.getElementById("lock-btn");
const lockOverlay = document.getElementById("lock-overlay");
const lockInput = document.getElementById("lock-input");
const lockError = document.getElementById("lock-error");
const lockUnlockBtn = document.getElementById("lock-unlock-btn");
const lockCancelBtn = document.getElementById("lock-cancel-btn");
let pendingUnlockNoteId = null;

function setLockIcon(locked) {
  lockBtn.innerHTML = `<svg class="icon"><use href="#icon-lock-${locked ? "closed" : "open"}"/></svg>`;
}

// --- Real encryption for locked notes (AES-GCM, key derived from the PIN via
// PBKDF2). `pinCode` (a bare SHA-256 hash) only exists on notes locked before
// this scheme: it verifies the PIN once, then the note is migrated in place.
async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToB64(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(pin, saltBytes) {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptString(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(data)) };
}

async function decryptString(key, enc) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(enc.iv) }, key, b64ToBytes(enc.data));
  return new TextDecoder().decode(plain);
}

// Holds the AES key for the note currently unlocked in this session, so edits
// keep re-encrypting on save without re-prompting for the PIN. Cleared as soon
// as the note is no longer the open one (see showList()), so leaving the
// editor always requires the PIN again next time, exactly like before.
let activeUnlockKey = null;
let lockFailCount = 0;
let lockLockedUntil = 0;

function showLockOverlay() {
  pendingUnlockNoteId = currentNote.id;
  lockInput.value = "";
  lockError.classList.add("hidden");
  lockOverlay.classList.remove("hidden");
  setTimeout(() => lockInput.focus(), 50);
}

async function attemptUnlock() {
  const note = notes.find((n) => n.id === pendingUnlockNoteId);
  if (!note) return;
  if (Date.now() < lockLockedUntil) {
    lockError.textContent = `Trop de tentatives, réessaie dans ${Math.ceil((lockLockedUntil - Date.now()) / 1000)}s`;
    lockError.classList.remove("hidden");
    return;
  }
  const pin = lockInput.value;
  let key = null;
  let plainBlob = null;
  try {
    if (note.pinSalt && note.encBlob) {
      key = await deriveKey(pin, b64ToBytes(note.pinSalt));
      plainBlob = JSON.parse(await decryptString(key, note.encBlob));
    } else if (note.pinCode) {
      const hash = await hashPin(pin);
      if (hash !== note.pinCode) throw new Error("wrong pin");
      // Legacy note locked before real encryption existed: its content is
      // still stored in clear. Migrate it to AES-GCM right now.
      plainBlob = { html: note.html, drawing: note.drawing, history: note.history };
      const salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(pin, salt);
      note.pinSalt = bytesToB64(salt);
      note.pinCode = null;
    } else {
      throw new Error("no pin set on this note");
    }
  } catch {
    lockFailCount++;
    if (lockFailCount >= 5) {
      lockLockedUntil = Date.now() + 30000;
      lockFailCount = 0;
      lockError.textContent = "Trop de tentatives, réessaie dans 30s";
    } else {
      lockError.textContent = "Code incorrect";
    }
    lockError.classList.remove("hidden");
    lockInput.value = "";
    lockInput.focus();
    return;
  }
  lockFailCount = 0;
  activeUnlockKey = { noteId: note.id, key };
  note.html = plainBlob.html || "";
  note.drawing = plainBlob.drawing || null;
  note.history = plainBlob.history || [];
  await persistNote(note);
  lockOverlay.classList.add("hidden");
  currentNote = note;
  if (navigator.vibrate) navigator.vibrate(15);
  loadNoteIntoEditor();
  showEditor();
}

lockUnlockBtn.addEventListener("click", attemptUnlock);
lockInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptUnlock();
});
lockCancelBtn.addEventListener("click", () => {
  lockOverlay.classList.add("hidden");
  pendingUnlockNoteId = null;
  showList();
});

lockBtn.addEventListener("click", async () => {
  if (!currentNote.locked) {
    const pin = window.prompt("Choisis un code (4 chiffres ou plus) pour verrouiller cette note :");
    if (!pin) return;
    currentNote.title = titleInput.value.trim();
    currentNote.folder = folderInput.value.trim();
    currentNote.tags = parseTags(tagsInput.value);
    currentNote.html = textEditor.innerHTML;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(pin, salt);
    currentNote.pinSalt = bytesToB64(salt);
    currentNote.pinCode = null;
    currentNote.locked = true;
    activeUnlockKey = { noteId: currentNote.id, key };
    await persistNote(currentNote);
    activeUnlockKey = null;
    textEditor.innerHTML = "";
    currentNote.html = "";
    currentNote.drawing = null;
    redrawStrokes();
    if (navigator.vibrate) navigator.vibrate(15);
    showToast("Note verrouillée et chiffrée");
    showList();
  } else {
    const pin = window.prompt("Entre le code pour retirer le verrou :");
    if (pin === null) return;
    let key = null;
    let plainBlob = null;
    try {
      if (currentNote.pinSalt && currentNote.encBlob) {
        key = await deriveKey(pin, b64ToBytes(currentNote.pinSalt));
        plainBlob = JSON.parse(await decryptString(key, currentNote.encBlob));
      } else if (currentNote.pinCode) {
        const hash = await hashPin(pin);
        if (hash !== currentNote.pinCode) throw new Error("wrong pin");
        plainBlob = { html: currentNote.html, drawing: currentNote.drawing, history: currentNote.history };
      } else {
        throw new Error("no pin set");
      }
    } catch {
      showToast("Code incorrect");
      return;
    }
    currentNote.locked = false;
    currentNote.pinSalt = null;
    currentNote.pinCode = null;
    currentNote.encBlob = null;
    currentNote.html = plainBlob.html || "";
    currentNote.drawing = plainBlob.drawing || null;
    currentNote.history = plainBlob.history || [];
    activeUnlockKey = null;
    await persistNote(currentNote);
    setLockIcon(false);
    setPressed(lockBtn, false);
    loadNoteIntoEditor();
    if (navigator.vibrate) navigator.vibrate(15);
    showToast("Verrou retiré");
  }
});

// --- Reminders (best-effort, only while the app is open) ---
const reminderBtn = document.getElementById("reminder-btn");
const reminderPanel = document.getElementById("reminder-panel");
const reminderInput = document.getElementById("reminder-input");
const reminderSaveBtn = document.getElementById("reminder-save-btn");
const reminderClearBtn = document.getElementById("reminder-clear-btn");

function toLocalDatetimeValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

reminderBtn.addEventListener("click", () => {
  historyPanel.classList.add("hidden");
  reminderPanel.classList.toggle("hidden");
});

reminderSaveBtn.addEventListener("click", () => {
  if (!reminderInput.value) return;
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  currentNote.reminderAt = new Date(reminderInput.value).getTime();
  currentNote.reminderFired = false;
  scheduleSave();
  reminderPanel.classList.add("hidden");
  showToast("Rappel programmé");
});

reminderClearBtn.addEventListener("click", () => {
  currentNote.reminderAt = null;
  currentNote.reminderFired = false;
  reminderInput.value = "";
  scheduleSave();
  reminderPanel.classList.add("hidden");
  showToast("Rappel supprimé");
});

setInterval(() => {
  const now = Date.now();
  notes.forEach((note) => {
    if (note.reminderAt && !note.reminderFired && note.reminderAt <= now) {
      note.reminderFired = true;
      persistNote(note);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(note.title || "Rappel NoteFlow", { body: "Touche pour ouvrir ta note." });
      } else {
        showToast(`Rappel : ${note.title || "Sans titre"}`);
      }
      if (listScreen.classList.contains("active")) renderList();
    }
  });
}, 30000);

// --- Ephemeral notes: a self-destruct timer, distinct from reminders — the
// note quietly moves itself to the trash once the delay is up (the 30-day
// trash retention still applies, so it's never truly unrecoverable). ---
const ephemeralBtn = document.getElementById("ephemeral-btn");
const ephemeralPanel = document.getElementById("ephemeral-panel");
const ephemeralClearBtn = document.getElementById("ephemeral-clear-btn");

ephemeralBtn.addEventListener("click", () => {
  reminderPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
  ephemeralPanel.classList.toggle("hidden");
});

document.getElementById("ephemeral-quick-row").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn) return;
  const hours = Number(btn.dataset.hours);
  currentNote.expiresAt = Date.now() + hours * 3600000;
  scheduleSave();
  ephemeralPanel.classList.add("hidden");
  showToast(`Cette note s'effacera dans ${btn.textContent}`);
});

ephemeralClearBtn.addEventListener("click", () => {
  currentNote.expiresAt = null;
  scheduleSave();
  ephemeralPanel.classList.add("hidden");
  showToast("Expiration annulée");
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  notes.forEach((note) => {
    if (note.expiresAt && !note.deletedAt && note.expiresAt <= now) {
      note.deletedAt = now;
      persistNote(note);
      changed = true;
    }
  });
  if (changed && listScreen.classList.contains("active")) renderList();
}, 30000);

// --- Version history ---
const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");

historyBtn.addEventListener("click", () => {
  reminderPanel.classList.add("hidden");
  const opening = historyPanel.classList.contains("hidden");
  historyPanel.classList.toggle("hidden");
  if (opening) renderHistory();
});

function renderHistory() {
  const history = currentNote.history || [];
  historyListEl.innerHTML = "";
  if (!history.length) {
    historyListEl.innerHTML = '<li class="history-empty">Pas encore de version enregistrée.</li>';
    return;
  }
  [...history].reverse().forEach((snap) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("span");
    label.textContent = new Date(snap.ts).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Restaurer";
    btn.addEventListener("click", () => {
      pushHistorySnapshot();
      currentNote.title = snap.title;
      currentNote.html = snap.html;
      titleInput.value = snap.title || "";
      textEditor.innerHTML = snap.html || "";
      updateWordCount();
      scheduleSave();
      historyPanel.classList.add("hidden");
      showToast("Version restaurée");
    });
    li.appendChild(label);
    li.appendChild(btn);
    historyListEl.appendChild(li);
  });
}

// --- Backlinks (notes that wikilink to the currently open note) ---
const backlinksBtn = document.getElementById("backlinks-btn");
const backlinksPanel = document.getElementById("backlinks-panel");
const backlinksListEl = document.getElementById("backlinks-list");

backlinksBtn.addEventListener("click", () => {
  reminderPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
  const opening = backlinksPanel.classList.contains("hidden");
  backlinksPanel.classList.toggle("hidden");
  if (opening) renderBacklinks();
});

function renderBacklinks() {
  const needle = `data-note-id="${currentNote.id}"`;
  const linking = notes.filter((n) => !n.deletedAt && n.id !== currentNote.id && !n.locked && (n.html || "").includes(needle));
  backlinksListEl.innerHTML = "";
  if (!linking.length) {
    backlinksListEl.innerHTML = '<li class="history-empty">Aucune note ne pointe encore ici.</li>';
    return;
  }
  linking.forEach((n) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("span");
    label.textContent = n.title || "Sans titre";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Ouvrir";
    btn.addEventListener("click", () => {
      backlinksPanel.classList.add("hidden");
      goToNote(n.id);
    });
    li.appendChild(label);
    li.appendChild(btn);
    backlinksListEl.appendChild(li);
  });
}

// --- Markdown-style shortcuts while typing ---
// Runs on "input" (after the space is already committed to the DOM). The line
// is converted with direct DOM moves rather than execCommand("formatBlock"/
// "insertUnorderedList"): on a collapsed caret those commands proved unreliable
// (no-op on the first line of a fresh note, or wrapping unrelated content).
// selectNodeContents(el).collapse() can land the caret on an {element,
// child-index} boundary instead of a {textNode, charOffset} one (e.g. when
// el's only child is a plain text node). That boundary is fine for our own
// reads, but the very next *native* keystroke doesn't reliably anchor to it
// when el has a sibling like the checklist checkbox — the typed text ends up
// escaping outside el entirely. Walking into the actual text descendant
// before handing the range to the browser avoids that.
function placeCaretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  let node = el;
  while (node.nodeType !== 3 && node.lastChild) node = node.lastChild;
  if (node.nodeType === 3) r.setStart(node, node.textContent.length), r.setEnd(node, node.textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function placeCaretAtStart(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  let node = el;
  while (node.nodeType !== 3 && node.firstChild) node = node.firstChild;
  if (node.nodeType === 3) r.setStart(node, 0), r.setEnd(node, 0);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function currentLineBlock(node) {
  const el = node.nodeType === 3 ? node.parentElement : node;
  const block = el && el.closest ? el.closest("p, div, h2, li") : null;
  return block && block !== textEditor ? block : null;
}

function convertLineToHeading() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const block = currentLineBlock(sel.getRangeAt(0).startContainer);
  const h2 = document.createElement("h2");
  if (block) {
    h2.append(...block.childNodes);
    block.replaceWith(h2);
  } else {
    h2.append(...textEditor.childNodes);
    textEditor.appendChild(h2);
  }
  if (!h2.textContent) h2.innerHTML = "<br>";
  placeCaretAtEnd(h2);
}

function convertLineToList(ordered) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const block = currentLineBlock(sel.getRangeAt(0).startContainer);
  const li = document.createElement("li");
  const list = document.createElement(ordered ? "ol" : "ul");
  if (block) {
    li.append(...block.childNodes);
    list.appendChild(li);
    block.replaceWith(list);
  } else {
    li.append(...textEditor.childNodes);
    list.appendChild(li);
    textEditor.appendChild(list);
  }
  if (!li.textContent) li.innerHTML = "<br>";
  placeCaretAtEnd(li);
}

const LINE_SHORTCUTS = [
  { re: /^#\s$/, action: () => convertLineToHeading() },
  { re: /^[-*]\s$/, action: () => convertLineToList(false) },
  { re: /^1\.\s$/, action: () => convertLineToList(true) },
  { re: /^\[\s?\]\s$/, action: () => insertChecklistItem() },
];

textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return;
  const offset = range.startOffset;
  const textBefore = node.textContent.slice(0, offset);
  const shortcut = LINE_SHORTCUTS.find((s) => s.re.test(textBefore));
  if (!shortcut) return;
  const r = document.createRange();
  r.setStart(node, offset - textBefore.length);
  r.setEnd(node, offset);
  r.deleteContents();
  sel.removeAllRanges();
  sel.addRange(r);
  shortcut.action();
  scheduleSave();
});

textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) return;
  const offset = sel.getRangeAt(0).startOffset;
  const text = node.textContent.slice(0, offset);
  const boldMatch = text.match(/\*\*([^*]+)\*\*$/) || text.match(/__([^_]+)__$/);
  const italicMatch = !boldMatch && (text.match(/(?:^|[^*])\*([^*]+)\*$/) || text.match(/(?:^|[^_])_([^_]+)_$/));
  let match = boldMatch;
  let tag = "b";
  if (!match && italicMatch) {
    match = italicMatch;
    tag = "i";
  }
  if (!match) return;
  const full = match[0];
  const inner = match[1];
  const range = document.createRange();
  try {
    const start = Math.max(0, offset - full.length);
    range.setStart(node, start);
    range.setEnd(node, offset);
    range.deleteContents();
    const el = document.createElement(tag);
    el.textContent = inner;
    range.insertNode(el);
    const spacer = document.createTextNode("​");
    el.parentNode.insertBefore(spacer, el.nextSibling);
    range.setStart(spacer, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* selection edge case: skip silently */
  }
});

// --- Auto-capitalize the first letter of a sentence while typing ---
// autocapitalize="sentences" on the editor already handles this for mobile
// virtual keyboards; this covers physical-keyboard typing, which that HTML
// attribute doesn't affect.
textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return;
  const offset = range.startOffset;
  if (offset < 1) return;
  const ch = node.textContent[offset - 1];
  if (!ch || ch === ch.toUpperCase() || ch !== ch.toLowerCase()) return;
  const before = node.textContent.slice(0, offset - 1);
  const atBlockStart = before === "" && !node.previousSibling;
  const afterSentenceEnd = /[.!?]\s+$/.test(before);
  if (!atBlockStart && !afterSentenceEnd) return;
  node.textContent = before + ch.toUpperCase() + node.textContent.slice(offset);
  const r = document.createRange();
  r.setStart(node, offset);
  r.setEnd(node, offset);
  sel.removeAllRanges();
  sel.addRange(r);
});

// --- Wikilinks: typing [[Titre]] turns into a clickable link to that note ---
textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) return;
  const offset = sel.getRangeAt(0).startOffset;
  const text = node.textContent.slice(0, offset);
  const match = text.match(/\[\[([^[\]]+)\]\]$/);
  if (!match) return;
  // A leading "!" (![[Titre]]) is transclusion, handled by a separate
  // listener below — this one only handles a plain wikilink.
  if (text[text.length - match[0].length - 1] === "!") return;
  const query = match[1].trim().toLowerCase();
  if (!query) return;
  const target =
    notes.find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase() === query) ||
    notes.find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase().includes(query));
  if (!target) return;
  const full = match[0];
  const range = document.createRange();
  try {
    range.setStart(node, offset - full.length);
    range.setEnd(node, offset);
    range.deleteContents();
    const a = document.createElement("a");
    a.href = "#";
    a.className = "wikilink";
    a.dataset.noteId = target.id;
    a.textContent = target.title || "Sans titre";
    range.insertNode(a);
    const spacer = document.createTextNode("​");
    a.parentNode.insertBefore(spacer, a.nextSibling);
    range.setStart(spacer, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleSave();
  } catch {
    /* selection edge case: skip silently */
  }
});

textEditor.addEventListener("click", (e) => {
  const link = e.target.closest("a.wikilink");
  if (!link) return;
  e.preventDefault();
  const id = link.dataset.noteId;
  if (notes.some((n) => n.id === id)) goToNote(id);
});

// --- Transclusion: typing ![[Titre]] embeds a read-only, refreshed-on-open
// snapshot of that note's content right here, instead of just linking to it. ---
function renderTransclusionBlock(el, note) {
  el.innerHTML = "";
  const header = document.createElement("div");
  header.className = "transclusion-header";
  header.textContent = "↳ Extrait de « " + (note.title || "Sans titre") + " »";
  const body = document.createElement("div");
  body.className = "transclusion-body";
  body.innerHTML = note.locked ? "<p><em>Cette note est verrouillée.</em></p>" : note.html || "<p><em>Note vide.</em></p>";
  el.appendChild(header);
  el.appendChild(body);
}

function insertTransclusionBlock(target) {
  const div = document.createElement("div");
  div.className = "transclusion";
  div.contentEditable = "false";
  div.dataset.noteId = target.id;
  renderTransclusionBlock(div, target);
  return div;
}

// Every embedded transclusion is refreshed from the current state of its
// source note whenever the containing note is (re)opened — not truly live
// while both are open at once, but never stale on view.
function refreshTransclusions() {
  textEditor.querySelectorAll(".transclusion[data-note-id]").forEach((el) => {
    const source = notes.find((n) => n.id === el.dataset.noteId && !n.deletedAt);
    if (!source) {
      el.innerHTML = '<div class="transclusion-header">↳ Note source introuvable (supprimée)</div>';
      return;
    }
    renderTransclusionBlock(el, source);
  });
}

textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) return;
  const offset = sel.getRangeAt(0).startOffset;
  const text = node.textContent.slice(0, offset);
  const match = text.match(/!\[\[([^[\]]+)\]\]$/);
  if (!match) return;
  const query = match[1].trim().toLowerCase();
  if (!query) return;
  const target =
    notes.find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase() === query) ||
    notes.find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase().includes(query));
  if (!target) return;
  const full = match[0];
  const range = document.createRange();
  try {
    range.setStart(node, offset - full.length);
    range.setEnd(node, offset);
    range.deleteContents();
    const block = insertTransclusionBlock(target);
    range.insertNode(block);
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    block.after(p);
    placeCaretAtStart(p);
    scheduleSave();
  } catch {
    /* selection edge case: skip silently */
  }
});

growPageBtn.addEventListener("click", () => {
  currentNote.pageHeight = (currentNote.pageHeight || 700) + 400;
  notePage.style.minHeight = currentNote.pageHeight + "px";
  textEditor.style.minHeight = currentNote.pageHeight + "px";
  updatePageFolio();
  initCanvasSize();
  redrawStrokes();
  scheduleSave();
});

// --- Rich text toolbar ---
const formatToolbar = document.getElementById("format-toolbar");
let savedRange = null;

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (sel.rangeCount && textEditor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
});

function restoreSelection() {
  textEditor.focus();
  if (savedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
}

formatToolbar.addEventListener("mousedown", (e) => {
  if (e.target.closest("button, .color-swatch")) e.preventDefault();
});

formatToolbar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  restoreSelection();
  const cmd = btn.dataset.cmd;
  if (cmd === "checklist") {
    insertChecklistItem();
  } else if (cmd === "link") {
    insertLink();
  } else if (cmd === "image") {
    imageInput.click();
  } else if (cmd === "table") {
    insertTable();
  } else if (cmd === "table-add-row") {
    tableAddRow();
  } else if (cmd === "table-add-col") {
    tableAddColumn();
  } else if (cmd === "table-delete-row") {
    tableDeleteRow();
  } else if (cmd === "table-delete-col") {
    tableDeleteColumn();
  } else if (cmd === "table-delete") {
    tableDelete();
  } else {
    document.execCommand(cmd, false, null);
    // Chrome leaves the caret at the START of the line after wrapping it
    // into a list (insertOrderedList/insertUnorderedList), instead of where
    // it actually was — typing or pressing Enter right after then corrupts
    // the list. Force it back to the end of the current item.
    if (cmd === "insertOrderedList" || cmd === "insertUnorderedList") fixListCaret();
  }
  scheduleSave();
  updateToolbarState();
});

function fixListCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  const li = node && node.closest ? node.closest("li") : null;
  if (!li) return;
  const r = document.createRange();
  r.selectNodeContents(li);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

const textColorRow = document.getElementById("text-color-row");
const TEXT_COLORS = ["#1d1d1f", "#a13d3d", "#a8752c", "#3d6b52", "#3a5a8c", "#6b4a8c"];
TEXT_COLORS.forEach((color) => {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "color-swatch";
  swatch.style.background = color;
  swatch.title = "Couleur du texte";
  swatch.addEventListener("click", () => {
    restoreSelection();
    document.execCommand("foreColor", false, color);
    scheduleSave();
  });
  textColorRow.appendChild(swatch);
});

const fontSelect = document.getElementById("font-select");
const FONTS = [
  { label: "Par défaut", value: "" },
  { label: "Serif classique", value: "Georgia, serif" },
  { label: "Serif éditoriale", value: "'Iowan Old Style', Palatino, 'Book Antiqua', serif" },
  { label: "Times", value: "'Times New Roman', Times, serif" },
  { label: "Didot", value: "Didot, Georgia, serif" },
  { label: "Sans moderne", value: "Helvetica, Arial, sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', sans-serif" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Compacte", value: "'Arial Narrow', Arial, sans-serif" },
  { label: "Machine à écrire", value: "'Courier New', Courier, monospace" },
  { label: "Mono moderne", value: "Menlo, Consolas, monospace" },
  { label: "Manuscrite", value: "'Bradley Hand', 'Segoe Script', cursive" },
  { label: "Manuscrite élégante", value: "'Brush Script MT', cursive" },
  { label: "Chalkboard", value: "'Chalkboard SE', 'Comic Sans MS', cursive" },
  { label: "Titrage", value: "Impact, 'Arial Black', sans-serif" },
  { label: "Futuriste", value: "Copperplate, fantasy" },
];
FONTS.forEach((f) => {
  const opt = document.createElement("option");
  opt.value = f.value;
  opt.textContent = f.label;
  opt.style.fontFamily = f.value || "inherit";
  fontSelect.appendChild(opt);
});
enhanceSelect(fontSelect);
fontSelect.addEventListener("mousedown", (e) => e.stopPropagation());
fontSelect.addEventListener("change", () => {
  restoreSelection();
  document.execCommand("fontName", false, fontSelect.value || "inherit");
  scheduleSave();
  updateFontSelectState();
});

function firstFontToken(value) {
  return (value.split(",")[0] || "").replace(/['"]/g, "").trim().toLowerCase();
}

function updateFontSelectState() {
  let current = "";
  try {
    current = document.queryCommandValue("fontName") || "";
  } catch {
    current = "";
  }
  const currentFirst = firstFontToken(current);
  const match = FONTS.find((f) => f.value && firstFontToken(f.value) === currentFirst);
  fontSelect.value = match ? match.value : "";
  if (fontSelect._customSelectRefresh) fontSelect._customSelectRefresh();
}

// --- Block style (heading levels) ---
const styleSelect = document.getElementById("style-select");
enhanceSelect(styleSelect);
styleSelect.addEventListener("mousedown", (e) => e.stopPropagation());
styleSelect.addEventListener("change", () => {
  restoreSelection();
  document.execCommand("formatBlock", false, styleSelect.value);
  scheduleSave();
  updateStyleSelectState();
});
function updateStyleSelectState() {
  let value = "p";
  try {
    value = (document.queryCommandValue("formatBlock") || "p").toLowerCase();
  } catch {
    value = "p";
  }
  if (!["p", "h1", "h2", "h3"].includes(value)) value = "p";
  styleSelect.value = value;
  if (styleSelect._customSelectRefresh) styleSelect._customSelectRefresh();
}

// --- Links ---
function insertLink() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    showToast("Sélectionne du texte pour créer un lien");
    return;
  }
  let url = window.prompt("Adresse du lien :", "https://");
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  document.execCommand("createLink", false, url);
}

// --- Images (toolbar insert + paste) ---
const imageInput = document.getElementById("image-input");

// Downscale + re-encode as JPEG before storing: a raw phone photo can be
// several MB of base64 inside note.html, and every one of those bytes gets
// duplicated into every history snapshot (see pushHistorySnapshot) and
// reloaded whole into memory on every app boot (dbGetAll loads all notes).
const IMAGE_MAX_DIMENSION = 1400;
const IMAGE_QUALITY = 0.82;

function compressImageFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const original = new Image();
      original.onload = () => {
        const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(original.width, original.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(original.width * scale);
        canvas.height = Math.round(original.height * scale);
        const ctx2d = canvas.getContext("2d");
        ctx2d.drawImage(original, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
        } catch {
          resolve(reader.result);
        }
      };
      original.onerror = () => resolve(reader.result);
      original.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function insertImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const dataUrl = await compressImageFile(file);
  if (!dataUrl) return;
  restoreSelection();
  const img = document.createElement("img");
  img.src = dataUrl;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer)) {
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    textEditor.appendChild(img);
  }
  scheduleSave();
}

imageInput.addEventListener("change", () => {
  if (imageInput.files[0]) insertImageFile(imageInput.files[0]);
  imageInput.value = "";
});

textEditor.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      insertImageFile(item.getAsFile());
      return;
    }
  }
});

// --- Find & replace ---
const findPanel = document.getElementById("find-panel");
const findInput = document.getElementById("find-input");
const replaceInput = document.getElementById("replace-input");
const findCount = document.getElementById("find-count");
const replaceAllBtn = document.getElementById("replace-all-btn");

function countMatches(term) {
  if (!term) return 0;
  const text = textEditor.textContent.toLowerCase();
  const needle = term.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function updateFindCount() {
  const term = findInput.value;
  if (!term) {
    findCount.textContent = "";
    return;
  }
  const n = countMatches(term);
  findCount.textContent = n ? `${n} résultat${n > 1 ? "s" : ""}` : "Aucun résultat";
}

findInput.addEventListener("input", updateFindCount);

document.getElementById("find-btn").addEventListener("click", () => {
  findPanel.classList.toggle("hidden");
  if (!findPanel.classList.contains("hidden")) {
    findInput.focus();
    updateFindCount();
  }
});
document.getElementById("find-close-btn").addEventListener("click", () => findPanel.classList.add("hidden"));

replaceAllBtn.addEventListener("click", () => {
  const term = findInput.value;
  if (!term) return;
  const replacement = replaceInput.value;
  const walker = document.createTreeWalker(textEditor, NodeFilter.SHOW_TEXT);
  const needle = term.toLowerCase();
  let replaced = 0;
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.forEach((n) => {
    if (n.textContent.toLowerCase().includes(needle)) {
      const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = n.textContent.match(re);
      if (matches) replaced += matches.length;
      n.textContent = n.textContent.replace(re, replacement);
    }
  });
  scheduleSave();
  updateWordCount();
  updateFindCount();
  showToast(replaced ? `${replaced} remplacement${replaced > 1 ? "s" : ""}` : "Aucun résultat");
});

function makeChecklistLi() {
  const li = document.createElement("li");
  li.className = "checklist-item";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const span = document.createElement("span");
  li.appendChild(checkbox);
  li.appendChild(span);
  return li;
}

// Converts the current line into a checklist item, the same way the bullet
// and numbered list buttons convert theirs — and, crucially, appends to the
// checklist <ul> right above instead of always wrapping a brand new
// single-item <ul>: every earlier version created one isolated <ul> per
// item, so consecutive checkboxes never actually lined up (each had its own
// list padding) and pressing Enter couldn't continue the list at all.
function insertChecklistItem() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const block = currentLineBlock(sel.getRangeAt(0).startContainer);
  const prevBlock = block ? block.previousElementSibling : textEditor.lastElementChild;
  const li = makeChecklistLi();
  const span = li.querySelector("span");
  if (block) span.append(...block.childNodes);
  else span.append(...textEditor.childNodes);
  // A plain space as placeholder gets treated specially by Chrome's
  // whitespace handling: the very next real keystroke lands as a sibling of
  // the span instead of inside it. A zero-width space anchors reliably.
  if (!span.textContent) span.textContent = "​";
  if (prevBlock && prevBlock.tagName === "UL" && prevBlock.classList.contains("checklist")) {
    prevBlock.appendChild(li);
    if (block) block.remove();
  } else {
    const ul = document.createElement("ul");
    ul.className = "checklist";
    ul.appendChild(li);
    if (block) block.replaceWith(ul);
    else textEditor.appendChild(ul);
  }
  placeCaretAtEnd(span);
}

// Enter inside a checklist item creates the next checkbox in the SAME <ul>
// (splitting the text at the caret) instead of letting the browser insert a
// plain <li> with no checkbox — that mismatch is what caused the checkbox
// column to drift after the first item. Enter on an empty item exits the
// checklist back to a normal paragraph, like native lists do.
textEditor.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentElement;
  const li = node && node.closest ? node.closest(".checklist-item") : null;
  if (!li) return;
  e.preventDefault();
  const span = li.querySelector("span");
  if (!li.textContent.replace(/​/g, "").trim()) {
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    li.replaceWith(p);
    placeCaretAtEnd(p);
    scheduleSave();
    return;
  }
  // range.startOffset is only a plain character index when startContainer is
  // itself a text node — when the caret sits directly on the <span> (e.g.
  // right after placeCaretAtEnd), the same number is a *child-node* index
  // instead, and treating it as a character offset silently split the text
  // at the wrong position. Extracting through a proper Range comparison
  // sidesteps that distinction entirely, and keeps any inline formatting
  // (bold, wikilinks…) inside the split-off half intact.
  const endOfSpan = document.createRange();
  endOfSpan.selectNodeContents(span);
  const afterRange = range.cloneRange();
  afterRange.setEnd(endOfSpan.endContainer, endOfSpan.endOffset);
  const afterFragment = afterRange.extractContents();
  const hadAfterContent = afterFragment.textContent.length > 0;
  if (!span.textContent) span.textContent = "​";
  const newLi = makeChecklistLi();
  const newSpan = newLi.querySelector("span");
  newSpan.appendChild(afterFragment);
  if (!hadAfterContent) {
    // A genuinely empty inline element loses the caret anchor the moment a
    // real keystroke lands (Chrome inserts the typed text as a sibling of
    // the span instead of inside it) — an invisible zero-width space gives
    // native typing something to actually sit inside.
    newSpan.appendChild(document.createTextNode("​"));
  }
  li.after(newLi);
  if (hadAfterContent) placeCaretAtStart(newSpan);
  else placeCaretAtEnd(newSpan);
  scheduleSave();
});

function currentTable() {
  const sel = window.getSelection();
  if (savedRange) {
    let node = savedRange.startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    const table = node && node.closest ? node.closest("table") : null;
    if (table) return table;
  }
  if (sel.rangeCount) {
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    if (node && node.closest) return node.closest("table");
  }
  const tables = textEditor.querySelectorAll("table");
  return tables.length ? tables[tables.length - 1] : null;
}

function makeCell() {
  const td = document.createElement("td");
  td.contentEditable = "true";
  td.innerHTML = "<br>";
  return td;
}

function insertTable() {
  const table = document.createElement("table");
  table.className = "note-table";
  for (let r = 0; r < 3; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < 3; c++) tr.appendChild(makeCell());
    table.appendChild(tr);
  }
  const sel = window.getSelection();
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  let range;
  if (sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer)) {
    range = sel.getRangeAt(0);
    range.collapse(false);
  } else {
    range = document.createRange();
    range.selectNodeContents(textEditor);
    range.collapse(false);
  }
  range.insertNode(table);
  range.setStartAfter(table);
  range.collapse(true);
  range.insertNode(p);
  sel.removeAllRanges();
  sel.addRange(range);
  table.rows[0].cells[0].focus();
}

function tableAddRow() {
  const table = currentTable();
  if (!table) return;
  const cols = table.rows[0] ? table.rows[0].cells.length : 3;
  const tr = document.createElement("tr");
  for (let c = 0; c < cols; c++) tr.appendChild(makeCell());
  table.appendChild(tr);
}

function tableAddColumn() {
  const table = currentTable();
  if (!table) return;
  Array.from(table.rows).forEach((row) => row.appendChild(makeCell()));
}

function tableDelete() {
  const table = currentTable();
  if (!table) return;
  const parent = table.parentNode;
  const next = table.nextSibling;
  const clone = table.cloneNode(true);
  table.remove();
  scheduleSave();
  showToast("Tableau supprimé", () => {
    parent.insertBefore(clone, next);
    scheduleSave();
  });
}

function currentCell() {
  const sources = [];
  if (savedRange) sources.push(savedRange.startContainer);
  const sel = window.getSelection();
  if (sel.rangeCount) sources.push(sel.getRangeAt(0).startContainer);
  for (const source of sources) {
    let node = source;
    if (node && node.nodeType === 3) node = node.parentElement;
    const cell = node && node.closest ? node.closest("td") : null;
    if (cell) return cell;
  }
  return null;
}

function tableDeleteRow() {
  const table = currentTable();
  if (!table) return;
  const cell = currentCell();
  const row = cell && table.contains(cell) ? cell.closest("tr") : table.rows[table.rows.length - 1];
  if (!row) return;
  const parent = row.parentNode;
  const next = row.nextSibling;
  const clone = row.cloneNode(true);
  const tableParent = table.parentNode;
  const tableNext = table.nextSibling;
  const wholeTable = table.rows.length <= 1 ? table.cloneNode(true) : null;
  row.remove();
  if (!table.rows.length) table.remove();
  scheduleSave();
  showToast("Ligne supprimée", () => {
    if (wholeTable) tableParent.insertBefore(wholeTable, tableNext);
    else parent.insertBefore(clone, next);
    scheduleSave();
  });
}

function tableDeleteColumn() {
  const table = currentTable();
  if (!table) return;
  const cell = currentCell();
  const colIndex =
    cell && table.contains(cell)
      ? Array.from(cell.parentElement.children).indexOf(cell)
      : table.rows[0]
      ? table.rows[0].cells.length - 1
      : -1;
  if (colIndex < 0) return;
  const willEmpty = table.rows[0] && table.rows[0].cells.length <= 1;
  const tableParent = table.parentNode;
  const tableNext = table.nextSibling;
  const wholeTable = willEmpty ? table.cloneNode(true) : null;
  const removed = willEmpty
    ? null
    : Array.from(table.rows).map((row) => {
        const cellEl = row.cells[colIndex];
        return cellEl ? { row, clone: cellEl.cloneNode(true), nextSibling: cellEl.nextSibling } : null;
      });
  Array.from(table.rows).forEach((row) => {
    if (row.cells[colIndex]) row.cells[colIndex].remove();
  });
  if (willEmpty) table.remove();
  scheduleSave();
  showToast("Colonne supprimée", () => {
    if (wholeTable) {
      tableParent.insertBefore(wholeTable, tableNext);
    } else {
      removed.forEach((entry) => {
        if (entry) entry.row.insertBefore(entry.clone, entry.nextSibling);
      });
    }
    scheduleSave();
  });
}

textEditor.addEventListener("change", (e) => {
  if (e.target.type === "checkbox") {
    const span = e.target.nextElementSibling;
    if (span) span.style.textDecoration = e.target.checked ? "line-through" : "none";
    scheduleSave();
  }
});

function updateToolbarState() {
  formatToolbar.querySelectorAll("button[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    try {
      if (cmd === "checklist" || cmd === "link" || cmd === "image") active = false;
      else active = document.queryCommandState(cmd);
    } catch {
      active = false;
    }
    setPressed(btn, active);
  });
  updateFontSelectState();
  updateStyleSelectState();
}
textEditor.addEventListener("keyup", updateToolbarState);
textEditor.addEventListener("mouseup", updateToolbarState);

// --- Drawing ---
const canvas = document.getElementById("draw-canvas");
const ctx = canvas.getContext("2d");
const colorRow = document.getElementById("color-row");
const undoStrokeBtn = document.getElementById("undo-stroke-btn");
const clearDrawBtn = document.getElementById("clear-draw-btn");
const eraserBtn = document.getElementById("eraser-btn");
const penBtn = document.getElementById("pen-btn");
const highlighterBtn = document.getElementById("highlighter-btn");
const drawHint = document.getElementById("draw-hint");

const COLORS = ["#1d1d1f", "#a13d3d", "#a8752c", "#3d6b52", "#3a5a8c", "#6b4a8c"];
const HIGHLIGHT_COLORS = ["#ffe066", "#a0e6a0", "#8fd3ff", "#ffb0d6", "#ffb066"];
let drawColor = COLORS[0];
let drawWidth = 3;
let isErasing = false;
let isHighlighting = false;
let activeStroke = null;

function setTool(tool) {
  isErasing = tool === "eraser";
  isHighlighting = tool === "highlighter";
  setPressed(penBtn, tool === "pen");
  setPressed(highlighterBtn, tool === "highlighter");
  setPressed(eraserBtn, tool === "eraser");
  renderColorRow();
  drawWidth = toolWidths[tool];
  updateWidthUI();
}

function renderColorRow() {
  colorRow.innerHTML = "";
  const palette = isHighlighting ? HIGHLIGHT_COLORS : COLORS;
  if (isHighlighting && !HIGHLIGHT_COLORS.includes(drawColor)) drawColor = HIGHLIGHT_COLORS[0];
  if (!isHighlighting && !COLORS.includes(drawColor)) drawColor = COLORS[0];
  palette.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "color-swatch" + (color === drawColor ? " selected" : "");
    swatch.style.background = color;
    swatch.addEventListener("click", () => {
      drawColor = color;
      isErasing = false;
      setPressed(eraserBtn, false);
      colorRow.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
      updateDrawCursor();
    });
    colorRow.appendChild(swatch);
  });
}
renderColorRow();

penBtn.addEventListener("click", () => setTool("pen"));
highlighterBtn.addEventListener("click", () => setTool("highlighter"));

// Each tool remembers its own width — a thin pen and a fat eraser don't have
// to fight over one shared slider position — and the eraser's range starts
// much bigger, since "not thick enough" was specifically the complaint.
const widthSlider = document.getElementById("width-slider");
const widthPreviewDot = document.getElementById("width-preview-dot");
const TOOL_WIDTH_RANGE = { pen: [1, 20], highlighter: [1, 20], eraser: [6, 60] };
let toolWidths = { pen: 3, highlighter: 3, eraser: 24 };

function updateWidthUI() {
  const tool = isErasing ? "eraser" : isHighlighting ? "highlighter" : "pen";
  const [min, max] = TOOL_WIDTH_RANGE[tool];
  widthSlider.min = String(min);
  widthSlider.max = String(max);
  widthSlider.value = String(drawWidth);
  const dotSize = Math.min(Math.max(drawWidth, 4), 28);
  widthPreviewDot.style.width = dotSize + "px";
  widthPreviewDot.style.height = dotSize + "px";
  updateDrawCursor();
}
updateWidthUI();

widthSlider.addEventListener("input", () => {
  drawWidth = Number(widthSlider.value);
  const tool = isErasing ? "eraser" : isHighlighting ? "highlighter" : "pen";
  toolWidths[tool] = drawWidth;
  updateWidthUI();
});

// The mouse cursor itself becomes a small swatch of the current tool's
// color/size while drawing, instead of a generic crosshair — a contextual
// pen that shows exactly what the next stroke will look like.
function updateDrawCursor() {
  const size = Math.max(6, Math.min(drawWidth, 36));
  const dim = Math.round(size + 6);
  const half = dim / 2;
  const fill = isErasing ? "none" : drawColor;
  const strokeColor = isErasing ? "#8a8a8a" : "rgba(0,0,0,0.4)";
  const fillOpacity = isHighlighting ? 0.45 : 0.85;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}"><circle cx="${half}" cy="${half}" r="${size / 2}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${strokeColor}" stroke-width="1.5"/></svg>`;
  const b64 = btoa(svg);
  canvas.style.cursor = `url("data:image/svg+xml;base64,${b64}") ${half} ${half}, crosshair`;
}

eraserBtn.addEventListener("click", () => {
  setTool(isErasing ? "pen" : "eraser");
});

function ensureDrawing() {
  if (!currentNote.drawing) currentNote.drawing = { strokes: [] };
  return currentNote.drawing;
}

function initCanvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function redrawStrokes() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const strokes = (currentNote.drawing && currentNote.drawing.strokes) || [];
  strokes.forEach((stroke) => drawStroke(stroke));
}

function drawStroke(stroke) {
  if (stroke.points.length < 1) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.globalAlpha = stroke.highlight ? 0.4 : 1;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineJoin = "round";
  ctx.lineCap = stroke.highlight ? "square" : "round";
  ctx.beginPath();
  stroke.points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.restore();
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const pos = pointerPos(e);
  const width = isHighlighting ? Math.max(drawWidth * 5, 18) : drawWidth;
  activeStroke = { points: [pos], color: drawColor, width, erase: isErasing, highlight: isHighlighting };
  ensureDrawing().strokes.push(activeStroke);
  strokeRedoStack = [];
});

canvas.addEventListener("pointermove", (e) => {
  if (!activeStroke) return;
  const pos = pointerPos(e);
  const prev = activeStroke.points[activeStroke.points.length - 1];
  activeStroke.points.push(pos);
  ctx.save();
  ctx.globalCompositeOperation = activeStroke.erase ? "destination-out" : "source-over";
  ctx.globalAlpha = activeStroke.highlight ? 0.4 : 1;
  ctx.strokeStyle = activeStroke.color;
  ctx.lineWidth = activeStroke.width;
  ctx.lineJoin = "round";
  ctx.lineCap = activeStroke.highlight ? "square" : "round";
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  ctx.restore();
});

// A real highlighter follows the line, not the wobble of a hand-drawn
// stroke: once the stroke is finished, flatten it to a single straight
// horizontal bar at its average height, spanning from the first point
// reached to the last — however many words it was dragged across.
function snapHighlightStroke(stroke) {
  if (!stroke.highlight || stroke.points.length < 2) return;
  const avgY = stroke.points.reduce((sum, p) => sum + p.y, 0) / stroke.points.length;
  const xs = stroke.points.map((p) => p.x);
  stroke.points = [
    { x: Math.min(...xs), y: avgY },
    { x: Math.max(...xs), y: avgY },
  ];
}

function endStroke() {
  if (!activeStroke) return;
  const stroke = activeStroke;
  activeStroke = null;
  if (stroke.highlight) {
    snapHighlightStroke(stroke);
    redrawStrokes();
  }
  scheduleSave();
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

let strokeRedoStack = [];

function undoLastStroke() {
  const drawing = ensureDrawing();
  if (!drawing.strokes.length) return false;
  const removed = drawing.strokes.pop();
  strokeRedoStack.push(removed);
  redrawStrokes();
  scheduleSave();
  showToast("Trait annulé", () => {
    drawing.strokes.push(removed);
    strokeRedoStack.pop();
    redrawStrokes();
    scheduleSave();
  });
  return true;
}

function redoLastStroke() {
  if (!strokeRedoStack.length) return false;
  const restored = strokeRedoStack.pop();
  ensureDrawing().strokes.push(restored);
  redrawStrokes();
  scheduleSave();
  return true;
}

undoStrokeBtn.addEventListener("click", undoLastStroke);

clearDrawBtn.addEventListener("click", () => {
  const drawing = ensureDrawing();
  if (!drawing.strokes.length) return;
  const removed = drawing.strokes;
  currentNote.drawing = { strokes: [] };
  redrawStrokes();
  scheduleSave();
  showToast("Dessin effacé", () => {
    currentNote.drawing = { strokes: removed };
    redrawStrokes();
    scheduleSave();
  });
});

window.addEventListener("resize", () => {
  if (editorScreen.classList.contains("active")) {
    initCanvasSize();
    redrawStrokes();
  }
});

// --- Cloud sync (Firebase, optional) ---
const SYNC_KEYS = { config: "noteflow.sync.config", code: "noteflow.sync.code" };
const syncToggle = document.getElementById("sync-toggle");
const syncPanel = document.getElementById("sync-panel");
const syncStatusEl = document.getElementById("sync-status");
const syncConfigInput = document.getElementById("sync-config-input");
const syncCodeInput = document.getElementById("sync-code-input");
const syncSaveBtn = document.getElementById("sync-save-btn");
const syncDisableBtn = document.getElementById("sync-disable-btn");

let syncDb = null;
let syncCode = "";
let syncFns = null;
let unsubscribeSnapshot = null;
let applyingRemoteChange = false;

syncToggle.addEventListener("click", () => syncPanel.classList.toggle("hidden"));

function setSyncStatus(text) {
  syncStatusEl.textContent = text;
}

async function loadFirebase() {
  const [appMod, authMod, storeMod] = await Promise.all([
    import(`${FIREBASE_CDN}/firebase-app.js`),
    import(`${FIREBASE_CDN}/firebase-auth.js`),
    import(`${FIREBASE_CDN}/firebase-firestore.js`),
  ]);
  return { ...appMod, ...authMod, ...storeMod };
}

async function startSync(config, code) {
  try {
    setSyncStatus("Connexion…");
    const fb = await loadFirebase();
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    const existingApps = fb.getApps();
    await Promise.all(existingApps.map((a) => fb.deleteApp(a)));
    const app = fb.initializeApp(config);
    const auth = fb.getAuth(app);
    await fb.signInAnonymously(auth);
    syncDb = fb.getFirestore(app);
    syncFns = fb;
    syncCode = code;

    unsubscribeSnapshot = fb.onSnapshot(
      fb.collection(syncDb, "syncs", code, "notes"),
      (snapshot) => handleRemoteSnapshot(snapshot),
      (err) => setSyncStatus("🔴 Erreur de synchronisation : " + err.message)
    );
    setSyncStatus("🟢 Synchronisation active");
  } catch (err) {
    setSyncStatus("🔴 Erreur : " + err.message);
  }
}

async function handleRemoteSnapshot(snapshot) {
  applyingRemoteChange = true;
  for (const change of snapshot.docChanges()) {
    const remote = change.doc.data();
    const localIndex = notes.findIndex((n) => n.id === remote.id);
    if (change.type === "removed") {
      if (localIndex !== -1) {
        notes.splice(localIndex, 1);
        await dbDelete(remote.id);
      }
    } else if (localIndex === -1 || remote.updatedAt > notes[localIndex].updatedAt) {
      if (localIndex === -1) notes.unshift(remote);
      else notes[localIndex] = remote;
      await dbPut(remote);
      if (currentNote && currentNote.id === remote.id && editorScreen.classList.contains("active")) {
        currentNote = remote;
        loadNoteIntoEditor();
      }
    }
  }
  applyingRemoteChange = false;
  if (listScreen.classList.contains("active")) renderList();
}

async function persistNote(note) {
  recordActivityToday();
  // A locked note is never written to IndexedDB/Firestore in clear: while an
  // unlock key is active for it, its body/drawing/history are swapped for an
  // AES-GCM ciphertext just for the write, then restored in memory right after.
  let restore = null;
  if (note.locked && activeUnlockKey && activeUnlockKey.noteId === note.id) {
    const blob = JSON.stringify({ html: note.html, drawing: note.drawing, history: note.history });
    const enc = await encryptString(activeUnlockKey.key, blob);
    restore = { html: note.html, drawing: note.drawing, history: note.history };
    note.encBlob = enc;
    note.html = "";
    note.drawing = null;
    note.history = [];
  }
  await dbPut(note);
  if (syncDb && syncCode && !applyingRemoteChange) {
    try {
      await syncFns.setDoc(syncFns.doc(syncDb, "syncs", syncCode, "notes", note.id), note);
    } catch (err) {
      console.warn("sync push failed", err);
    }
  }
  if (restore) {
    note.html = restore.html;
    note.drawing = restore.drawing;
    note.history = restore.history;
  }
}

async function removeNoteEverywhere(id) {
  await dbDelete(id);
  if (syncDb && syncCode && !applyingRemoteChange) {
    try {
      await syncFns.deleteDoc(syncFns.doc(syncDb, "syncs", syncCode, "notes", id));
    } catch (err) {
      console.warn("sync delete failed", err);
    }
  }
}

syncSaveBtn.addEventListener("click", async () => {
  let config;
  try {
    config = JSON.parse(syncConfigInput.value);
  } catch {
    setSyncStatus("🔴 JSON de configuration invalide");
    return;
  }
  const code = syncCodeInput.value.trim();
  if (!code) {
    setSyncStatus("🔴 Indique un code de synchronisation");
    return;
  }
  savePref(SYNC_KEYS.config, config);
  savePref(SYNC_KEYS.code, code);
  await startSync(config, code);
});

syncDisableBtn.addEventListener("click", () => {
  localStorage.removeItem(SYNC_KEYS.config);
  localStorage.removeItem(SYNC_KEYS.code);
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  syncDb = null;
  syncCode = "";
  setSyncStatus("Synchronisation non configurée");
});

async function initSyncFromStorage() {
  const config = loadPref(SYNC_KEYS.config, null);
  const code = loadPref(SYNC_KEYS.code, "");
  if (config && code) {
    syncConfigInput.value = JSON.stringify(config, null, 2);
    syncCodeInput.value = code;
    await startSync(config, code);
  }
}

// --- Keyboard shortcuts ---
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!cmdkOverlay.classList.contains("hidden")) {
      closeCommandPalette();
      return;
    }
    if (!lockOverlay.classList.contains("hidden")) {
      lockCancelBtn.click();
      return;
    }
    [reminderPanel, historyPanel, backlinksPanel, ephemeralPanel, colorPanel, paperPanel, findPanel].forEach((p) => p.classList.add("hidden"));
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();

  if (key === "k") {
    e.preventDefault();
    if (cmdkOverlay.classList.contains("hidden")) openCommandPalette();
    else closeCommandPalette();
    return;
  }

  // Undo (Ctrl/Cmd+Z): an active "undo this action" toast (delete, archive,
  // clear drawing…) always takes priority, on either screen.
  if (key === "z" && !e.shiftKey && triggerToastUndo()) {
    e.preventDefault();
    return;
  }

  if (listScreen.classList.contains("active")) {
    if (key === "n") {
      e.preventDefault();
      newNoteBtn.click();
    } else if (key === "f") {
      e.preventDefault();
      searchInput.focus();
    }
    return;
  }

  if (!editorScreen.classList.contains("active")) return;

  // Stroke undo/redo while drawing; otherwise let the browser's native
  // text-editing undo inside the contenteditable handle Ctrl/Cmd+Z.
  if (key === "z" && !e.shiftKey && notePage.classList.contains("mode-draw")) {
    e.preventDefault();
    undoLastStroke();
    return;
  }

  if ((key === "z" && e.shiftKey) || key === "y") {
    if (notePage.classList.contains("mode-draw")) {
      e.preventDefault();
      redoLastStroke();
    }
    return;
  }

  if (key === "s") {
    e.preventDefault();
    flushSave(false);
  }
  // Ctrl/Cmd+B, +I, +U are left to the browser's native contenteditable
  // handling (calling execCommand ourselves on top of it double-toggles
  // the formatting back off).
});

// --- Command palette (⌘K quick switcher + actions) ---
const cmdkOverlay = document.getElementById("command-palette");
const cmdkInput = document.getElementById("cmdk-input");
const cmdkList = document.getElementById("cmdk-list");
let cmdkItems = [];
let cmdkActiveIndex = 0;

function closeCommandPalette() {
  cmdkOverlay.classList.add("hidden");
}

function openCommandPalette() {
  cmdkOverlay.classList.remove("hidden");
  cmdkInput.value = "";
  renderCmdkResults("");
  setTimeout(() => cmdkInput.focus(), 30);
}

function goToNote(id) {
  if (editorScreen.classList.contains("active")) flushSave(true);
  showList();
  openNote(id);
}

function cmdkActionItems(query) {
  const items = [
    { label: "Nouvelle note", sub: "Créer une note vide", action: () => newNoteBtn.click() },
    { label: "Basculer le thème", sub: "Auto / clair / sombre", action: () => themeToggle.click() },
    { label: "Voir les archives", sub: "", action: () => { showList(); setListView("archived"); } },
    { label: "Voir la corbeille", sub: "", action: () => { showList(); setListView("trash"); } },
    { label: "Sélection multiple", sub: "Archiver / déplacer / supprimer plusieurs notes", action: () => { showList(); setSelectionMode(true); } },
  ];
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((it) => it.label.toLowerCase().includes(q));
}

function renderCmdkResults(query) {
  const q = query.trim().toLowerCase();
  const noteItems = notes
    .filter((n) => !n.deletedAt)
    .filter((n) => !q || (n.title || "sans titre").toLowerCase().includes(q) || (n.folder || "").toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((n) => ({
      label: n.locked ? "🔒 " + (n.title || "Sans titre") : n.title || "Sans titre",
      sub: n.folder || "Note",
      action: () => goToNote(n.id),
    }));
  cmdkItems = [...cmdkActionItems(query), ...noteItems];
  cmdkActiveIndex = 0;
  cmdkList.innerHTML = "";
  if (!cmdkItems.length) {
    cmdkList.innerHTML = '<li class="cmdk-empty">Aucun résultat</li>';
    return;
  }
  cmdkItems.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "cmdk-item" + (i === cmdkActiveIndex ? " active" : "");
    li.innerHTML = `<span class="cmdk-item-label"></span><span class="cmdk-item-sub"></span>`;
    li.querySelector(".cmdk-item-label").textContent = item.label;
    li.querySelector(".cmdk-item-sub").textContent = item.sub || "";
    li.addEventListener("mouseenter", () => setCmdkActive(i));
    li.addEventListener("click", () => runCmdkItem(i));
    cmdkList.appendChild(li);
  });
}

function setCmdkActive(index) {
  cmdkActiveIndex = index;
  cmdkList.querySelectorAll(".cmdk-item").forEach((li, i) => li.classList.toggle("active", i === index));
}

function runCmdkItem(index) {
  const item = cmdkItems[index];
  if (!item) return;
  closeCommandPalette();
  item.action();
}

cmdkInput.addEventListener("input", () => renderCmdkResults(cmdkInput.value));
document.getElementById("cmdk-btn").addEventListener("click", openCommandPalette);
cmdkOverlay.addEventListener("click", (e) => {
  if (e.target === cmdkOverlay) closeCommandPalette();
});
cmdkInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setCmdkActive(Math.min(cmdkActiveIndex + 1, cmdkItems.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setCmdkActive(Math.max(cmdkActiveIndex - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    runCmdkItem(cmdkActiveIndex);
  } else if (e.key === "Escape") {
    closeCommandPalette();
  }
});

// --- Init ---
(async () => {
  try {
    notes = await dbGetAll();
    await purgeOldTrash();
  } catch (err) {
    console.error("Échec du chargement des notes locales", err);
    notes = [];
    showToast("Impossible de charger tes notes locales (stockage indisponible ou navigation privée)");
  }
  showList();
  initSyncFromStorage();
})();

// --- PWA service worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "noteflow-update-available") {
      showToast("Nouvelle version disponible", () => window.location.reload(), { actionLabel: "Actualiser", ctrlZ: false });
    }
  });
}
