const FIREBASE_CDN = "https://www.gstatic.com/firebasejs/10.13.0";

// --- IndexedDB storage ---
const DB_NAME = "noteflow";
const STORE = "notes";

// Singleton connection: the autosave path calls dbPut every ~500ms while
// typing, and each of these used to open (and never close) a brand new
// IDBDatabase — an unbounded number of live connections over a long writing
// session, and a future schema version bump would hang forever in
// "blocked" waiting for connections that were never going to close.
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
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
  snippets: "noteflow.snippets",
  tagFamilies: "noteflow.tagFamilies",
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
let lastRenderedNoteIds = new Set();

// --- Vaults: fully separate note collections within the same install (e.g.
// "Pro" / "Perso"). All notes stay in one array/one IndexedDB store — a
// vault is just a partition tag (note.vaultId) plus a filter applied at
// every point notes get discovered by title/tag/folder rather than by a
// specific id already known to belong to the current vault. ---
const VAULTS_KEY = "noteflow.vaults";
const ACTIVE_VAULT_KEY = "noteflow.activeVaultId";
const DEFAULT_VAULT_ID = "default";
function loadVaults() {
  const list = loadPref(VAULTS_KEY, null);
  if (Array.isArray(list) && list.length) return list;
  return [{ id: DEFAULT_VAULT_ID, name: "Principal" }];
}
function saveVaults(list) {
  savePref(VAULTS_KEY, list);
}
let vaults = loadVaults();
let activeVaultId = loadPref(ACTIVE_VAULT_KEY, DEFAULT_VAULT_ID);
if (!vaults.find((v) => v.id === activeVaultId)) activeVaultId = vaults[0].id;
function setActiveVault(id) {
  activeVaultId = id;
  savePref(ACTIVE_VAULT_KEY, id);
  activeFolderFilter = null;
  activeTagFilter = null;
  searchQuery = "";
  if (searchInput) searchInput.value = "";
  renderList();
}
function notesInActiveVault() {
  return notes.filter((n) => (n.vaultId || DEFAULT_VAULT_ID) === activeVaultId);
}

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
// Local calendar day, not UTC: toISOString() rolls over at midnight UTC,
// so writing between midnight and 1-2am in France (UTC+1/+2) used to count
// against the *previous* day and could silently break the streak.
const dateKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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
  panel.setAttribute("role", "menu");
  panel.querySelectorAll(".menu-item").forEach((item) => item.setAttribute("role", "menuitem"));
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
// Escape closing a menu used to leave focus stranded on whatever was under
// the pointer (or nowhere) instead of back on the button that opened it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".menu-wrap").forEach((wrap) => {
    const panel = wrap.querySelector(".menu-panel");
    const btn = wrap.querySelector(".icon-btn");
    if (panel && btn && !panel.classList.contains("hidden")) btn.focus();
  });
});
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
// If the user never touched the in-app toggle, honor the OS-level
// "prefers-contrast: more" signal instead of defaulting to off — the two
// settings previously never talked to each other, so this mode was only
// reachable by knowing it existed and digging for it in the menu.
const thickInkNeverSet = localStorage.getItem(PREF_KEYS.thickInk) === null;
const prefersMoreContrast = window.matchMedia && window.matchMedia("(prefers-contrast: more)").matches;
let thickInkEnabled = loadPref(PREF_KEYS.thickInk, thickInkNeverSet && prefersMoreContrast);
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
let customSelectIdCounter = 0;

function enhanceSelect(select) {
  const wrap = document.createElement("div");
  wrap.className = "custom-select";
  if (select.id) wrap.dataset.for = select.id;
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("native-select-hidden");
  select.setAttribute("tabindex", "-1");
  select.setAttribute("aria-hidden", "true");

  const listId = `custom-select-list-${++customSelectIdCounter}`;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", listId);
  // The global "title -> aria-label" pass (see above) only runs once at
  // load, before enhanceSelect() ever creates this button — so it never
  // reached this element. Set it directly instead of relying on that pass.
  if (select.title) {
    trigger.title = select.title;
    trigger.setAttribute("aria-label", select.title);
  }
  wrap.appendChild(trigger);

  const list = document.createElement("div");
  list.className = "custom-select-list hidden";
  list.id = listId;
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);

  let optionItems = [];

  function focusOption(index) {
    if (!optionItems.length) return;
    const clamped = Math.max(0, Math.min(index, optionItems.length - 1));
    optionItems[clamped].focus();
  }

  function renderOptions() {
    list.innerHTML = "";
    optionItems = Array.from(select.options).map((opt, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "custom-select-option" + (i === select.selectedIndex ? " selected" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === select.selectedIndex ? "true" : "false");
      item.tabIndex = -1;
      item.textContent = opt.textContent;
      if (opt.style.fontFamily) item.style.fontFamily = opt.style.fontFamily;
      item.addEventListener("click", () => {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        refresh();
        closeList();
        trigger.focus();
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusOption(optionItems.indexOf(item) + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          focusOption(optionItems.indexOf(item) - 1);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          item.click();
        } else if (e.key === "Tab") {
          closeList();
        }
      });
      list.appendChild(item);
      return item;
    });
  }
  function updateTrigger() {
    const opt = select.options[select.selectedIndex];
    trigger.textContent = opt ? opt.textContent : "";
    // Overwrites the generic select.title set above — once a value is
    // selected, seeing that exact (possibly ellipsis-truncated) text on
    // hover is more useful than the select's static description.
    if (opt) trigger.title = opt.textContent;
  }
  function closeList() {
    list.classList.add("hidden");
    trigger.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  }
  function openList() {
    renderOptions();
    list.classList.remove("hidden");
    trigger.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
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
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (list.classList.contains("hidden")) openList();
      focusOption(select.selectedIndex);
    }
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) closeList();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.classList.contains("hidden")) {
      closeList();
      trigger.focus();
    }
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
  if (activeRecorder && activeRecorder.state === "recording") {
    activeRecorder.stop();
  }
  flushSplitViewSave();
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
  document.getElementById("split-view-pane").classList.add("hidden");
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

// Firefox (and historically Safari) don't guarantee the download has
// actually started by the time a.click() returns synchronously — revoking
// the object URL immediately after could invalidate it before the browser
// gets to it, silently producing no download at all. Appending the anchor
// to the DOM and delaying the revoke gives every browser a real chance to
// pick it up first.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
  downloadBlob(blob, `noteflow-export-${new Date().toISOString().slice(0, 10)}.json`);
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
    } else if (name.endsWith(".md")) {
      const mdFiles = Array.from(importInput.files).filter((f) => f.name.toLowerCase().endsWith(".md"));
      const imported = [];
      for (const f of mdFiles) {
        imported.push(importMarkdown(await f.text(), f.name));
      }
      resolveImportedWikilinks(imported);
      for (const note of imported) {
        notes.unshift(note);
        await persistNote(note);
      }
      renderList();
      showToast(`${imported.length} note${imported.length > 1 ? "s" : ""} importée${imported.length > 1 ? "s" : ""} depuis Markdown`);
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
        if (note.html) note.html = sanitizeNoteHtml(note.html);
        // A hand-edited or corrupted export can be missing fields the rest
        // of the app assumes exist: no updatedAt broke sort ordering (NaN),
        // and locked: true with neither encBlob nor pinCode made a note
        // permanently unopenable (every unlock attempt hit the same
        // "no pin set" throw, forever, with no way back in).
        if (typeof note.updatedAt !== "number" || Number.isNaN(note.updatedAt)) note.updatedAt = Date.now();
        if (typeof note.createdAt !== "number" || Number.isNaN(note.createdAt)) note.createdAt = note.updatedAt;
        if (note.locked && !note.encBlob && !note.pinCode) note.locked = false;
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

// Same caching rationale as getPreview() just below (keyed by note id, not
// by the html string itself — an unbounded cache keyed by content would
// just be a slower-growing version of the leak getPreview's cache used to
// have): parsing HTML runs once per note per renderList() call otherwise
// (every search keystroke, every 30s reminder/ephemeral tick).
const checklistProgressCache = new Map();
function checklistProgress(noteId, html) {
  const cached = checklistProgressCache.get(noteId);
  if (cached && cached.html === html) return cached.result;
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const boxes = div.querySelectorAll(".checklist-item input[type=checkbox]");
  const result = { total: boxes.length, checked: Array.from(boxes).filter((b) => b.hasAttribute("checked")).length };
  checklistProgressCache.set(noteId, { html, result });
  return result;
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

// In-memory cache: folderDisplayColor() runs once per note card and once per
// folder chip on every renderList() — reading + JSON.parse-ing localStorage
// that often (every keystroke in the search box, every 30s reminder tick) is
// wasted synchronous work for a value that only ever changes via the cover
// swatch picker, which already goes through saveFolderCovers().
let folderCoversCache = null;
function loadFolderCovers() {
  if (!folderCoversCache) folderCoversCache = loadPref(PREF_KEYS.folderCovers, {});
  return folderCoversCache;
}
function saveFolderCovers(map) {
  folderCoversCache = map;
  savePref(PREF_KEYS.folderCovers, map);
}

function folderDisplayColor(folder) {
  const covers = loadFolderCovers();
  const idx = covers[folder];
  return idx !== undefined ? FOLDER_COVER_TEXTURES[idx] : folderColor(folder);
}

function allFolders() {
  return [...new Set(notesInActiveVault().map((n) => n.folder).filter(Boolean))];
}

function allTags() {
  return [...new Set(notesInActiveVault().flatMap((n) => n.tags || []))].sort((a, b) => a.localeCompare(b, "fr"));
}

// --- Tag families: an optional, purely cosmetic grouping layer over flat
// tags (e.g. #urgent and #important both filed under "Priorité") — tags
// stay flat in the data model (still one array on the note, still fully
// compatible with tag: search clauses), this is only how they're clustered
// in the sidebar and the tag manager. ---
let tagFamiliesCache = null;
function loadTagFamilies() {
  if (!tagFamiliesCache) tagFamiliesCache = loadPref(PREF_KEYS.tagFamilies, {});
  return tagFamiliesCache;
}
function saveTagFamilies(map) {
  tagFamiliesCache = map;
  savePref(PREF_KEYS.tagFamilies, map);
}
function tagFamily(tag) {
  return loadTagFamilies()[tag] || "";
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
    const familyInput = document.createElement("input");
    familyInput.type = "text";
    familyInput.className = "properties-input tag-family-input";
    familyInput.placeholder = "Famille (optionnel)";
    familyInput.value = tagFamily(tag);
    familyInput.setAttribute("aria-label", `Famille du tag ${tag}`);
    familyInput.addEventListener("change", () => {
      const families = loadTagFamilies();
      const next = familyInput.value.trim();
      if (next) families[tag] = next;
      else delete families[tag];
      saveTagFamilies(families);
      renderFolderFilters();
    });
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
    li.appendChild(familyInput);
    li.appendChild(actions);
    tagManagerListEl.appendChild(li);
  });
}

// --- Snippets: user-defined trigger -> expansion pairs, expanded live while
// typing (trigger followed by a space or Enter). "$|" in the expansion text
// marks a single cursor placement after expansion — a lighter-weight
// alternative to full multi-tabstop snippet engines, chosen because the
// editor's contenteditable model has no native concept of linked tabstops
// to build that on top of without a much larger rewrite. ---
const snippetManagerBtn = document.getElementById("manage-snippets-btn");
const snippetManagerPanel = document.getElementById("snippet-manager-panel");
const snippetManagerListEl = document.getElementById("snippet-manager-list");
const snippetTriggerInput = document.getElementById("snippet-trigger-input");
const snippetExpansionInput = document.getElementById("snippet-expansion-input");
const snippetAddBtn = document.getElementById("snippet-add-btn");

function loadSnippets() {
  return loadPref(PREF_KEYS.snippets, []);
}
function saveSnippets(list) {
  savePref(PREF_KEYS.snippets, list);
}

function renderSnippetManager() {
  const snippets = loadSnippets();
  snippetManagerListEl.innerHTML = "";
  if (!snippets.length) {
    snippetManagerListEl.innerHTML = '<li class="history-empty">Aucune abréviation pour l\'instant.</li>';
    return;
  }
  snippets.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("span");
    label.textContent = `${s.trigger} → ${s.expansion}`;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "link-btn danger";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      const list = loadSnippets();
      list.splice(i, 1);
      saveSnippets(list);
      renderSnippetManager();
    });
    li.appendChild(label);
    li.appendChild(deleteBtn);
    snippetManagerListEl.appendChild(li);
  });
}

snippetManagerBtn.addEventListener("click", () => {
  const opening = snippetManagerPanel.classList.contains("hidden");
  snippetManagerPanel.classList.toggle("hidden");
  if (opening) renderSnippetManager();
});

snippetAddBtn.addEventListener("click", () => {
  const trigger = snippetTriggerInput.value.trim();
  const expansion = snippetExpansionInput.value.trim();
  if (!trigger || !expansion) return;
  const list = loadSnippets().filter((s) => s.trigger !== trigger);
  list.push({ trigger, expansion });
  saveSnippets(list);
  snippetTriggerInput.value = "";
  snippetExpansionInput.value = "";
  renderSnippetManager();
});

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
  const families = loadTagFamilies();
  if (oldTag in families) {
    if (newTag) families[newTag] = families[oldTag];
    delete families[oldTag];
    saveTagFamilies(families);
  }
  renderList();
  showToast(newTag ? `#${oldTag} renommé en #${newTag}` : `#${oldTag} supprimé de ${affected.length} note(s)`);
}

// --- Notebook hygiene dashboard: a diagnostic pass over the whole notebook
// (broken links, duplicate titles, tags used once, notes gone stale, orphaned
// folder covers), each finding with a one-click fix — not a graph view, just
// an actionable anomaly list. ---
const hygieneBtn = document.getElementById("hygiene-btn");
const hygienePanel = document.getElementById("hygiene-panel");
const hygieneListEl = document.getElementById("hygiene-list");
const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

function addHygieneSection(title, entries, emptyText) {
  const header = document.createElement("li");
  header.className = "backlinks-section-header";
  header.textContent = title;
  hygieneListEl.appendChild(header);
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = emptyText;
    hygieneListEl.appendChild(li);
    return;
  }
  entries.forEach(({ label, actionLabel, action }) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const span = document.createElement("span");
    span.textContent = label;
    li.appendChild(span);
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = actionLabel || "Ouvrir";
      btn.addEventListener("click", action);
      li.appendChild(btn);
    }
    hygieneListEl.appendChild(li);
  });
}

function renderHygieneDashboard() {
  hygieneListEl.innerHTML = "";
  const active = notes.filter((n) => !n.deletedAt);

  const brokenLinks = [];
  active.forEach((note) => {
    const container = document.createElement("div");
    container.innerHTML = note.html || "";
    container.querySelectorAll("[data-note-id]").forEach((el) => {
      const targetId = el.dataset.noteId;
      if (!notes.some((n) => n.id === targetId && !n.deletedAt)) {
        brokenLinks.push({
          label: `« ${note.title || "Sans titre"} » contient un lien brisé`,
          actionLabel: "Ouvrir",
          action: () => {
            hygienePanel.classList.add("hidden");
            goToNote(note.id);
          },
        });
      }
    });
  });

  const titleGroups = new Map();
  active.forEach((n) => {
    const key = (n.title || "").trim().toLowerCase();
    if (!key) return;
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(n);
  });
  const duplicates = [...titleGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      label: `${group.length} notes intitulées « ${group[0].title} »`,
      actionLabel: "Voir la 1ère",
      action: () => {
        hygienePanel.classList.add("hidden");
        goToNote(group[0].id);
      },
    }));

  const tagCounts = new Map();
  active.forEach((n) => (n.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
  const rareTags = [...tagCounts.entries()]
    .filter(([, count]) => count === 1)
    .map(([tag]) => ({
      label: `#${tag} n'est utilisé que sur une seule note`,
      actionLabel: "Gérer les tags",
      action: () => {
        hygienePanel.classList.add("hidden");
        tagManagerBtn.click();
      },
    }));

  const stale = active
    .filter((n) => {
      const lastTouch = Math.max(n.lastOpenedAt || 0, n.updatedAt || 0);
      return Date.now() - lastTouch > SIX_MONTHS_MS;
    })
    .map((n) => ({
      label: `« ${n.title || "Sans titre"} » n'a pas été rouverte depuis plus de 6 mois`,
      actionLabel: "Ouvrir",
      action: () => {
        hygienePanel.classList.add("hidden");
        goToNote(n.id);
      },
    }));

  const usedFolders = new Set(active.map((n) => n.folder).filter(Boolean));
  const covers = loadFolderCovers();
  const orphanCovers = Object.keys(covers)
    .filter((folder) => !usedFolders.has(folder))
    .map((folder) => ({
      label: `Couverture enregistrée pour le dossier « ${folder} », qui n'a plus de note`,
      actionLabel: "Nettoyer",
      action: () => {
        const current = loadFolderCovers();
        delete current[folder];
        saveFolderCovers(current);
        renderHygieneDashboard();
      },
    }));

  addHygieneSection("Liens brisés", brokenLinks, "Aucun lien brisé détecté.");
  addHygieneSection("Titres en doublon", duplicates, "Aucun doublon de titre.");
  addHygieneSection("Tags peu utilisés", rareTags, "Chaque tag est utilisé sur plusieurs notes.");
  addHygieneSection("Notes oubliées (6+ mois)", stale, "Aucune note oubliée.");
  addHygieneSection("Couvertures de dossier orphelines", orphanCovers, "Rien à nettoyer.");
}

hygieneBtn.addEventListener("click", () => {
  const opening = hygienePanel.classList.contains("hidden");
  hygienePanel.classList.toggle("hidden");
  if (opening) renderHygieneDashboard();
});

let draggedNoteId = null;

function reorderNotes(targetId) {
  if (!draggedNoteId || draggedNoteId === targetId) return;
  const fromIndex = notes.findIndex((n) => n.id === draggedNoteId);
  const toIndex = notes.findIndex((n) => n.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = notes.splice(fromIndex, 1);
  notes.splice(toIndex, 0, moved);
  // Only the notes between the old and new position actually change order —
  // writing all of them (IndexedDB + a Firestore setDoc each, unawaited) on
  // every single drag was a real freeze/quota risk on a notebook with
  // hundreds of notes, for a reorder that only ever moves one note past a
  // contiguous run of others.
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  for (let i = lo; i <= hi; i++) {
    notes[i].order = i;
    persistNote(notes[i]);
  }
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
  // One pass over notes to count exact-folder matches, instead of filtering
  // the full notes array once per folder chip below (that O(folders × notes)
  // scan was real: a few dozen folders over a notebook of a thousand notes
  // means tens of thousands of comparisons on every render, including on
  // every keystroke in the search box).
  const exactCounts = new Map();
  notesInActiveVault().forEach((n) => {
    if (n.deletedAt || !n.folder) return;
    exactCounts.set(n.folder, (exactCounts.get(n.folder) || 0) + 1);
  });
  folders.forEach((folder) => {
    const parts = folder.split("/");
    const depth = parts.length - 1;
    // A <div role="button">, not a <button>: it hosts a real, independently
    // focusable <button> (the cover swatch) as a child, and interactive
    // content nested inside a native <button> is invalid HTML that browsers
    // handle inconsistently for keyboard/AT users.
    const chip = document.createElement("div");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    chip.className = "tag-filter-chip folder-chip" + (activeFolderFilter === folder ? " active" : "");
    if (depth > 0) chip.style.marginLeft = `${depth * 14}px`;
    // A thicker "spine" for folders holding more notes — like books lined
    // up on a shelf by how full they are. Includes notes filed in
    // subfolders, same as the filter itself does.
    let noteCount = 0;
    for (const [f, count] of exactCounts) {
      if (f === folder || f.startsWith(folder + "/")) noteCount += count;
    }
    chip.style.borderLeftWidth = `${Math.min(2 + Math.round(noteCount / 2), 8)}px`;
    chip.title = folder;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = (depth > 0 ? "↳ " : "") + parts[parts.length - 1];
    const coverSwatch = document.createElement("button");
    coverSwatch.type = "button";
    coverSwatch.className = "folder-cover-swatch";
    coverSwatch.style.background = folderDisplayColor(folder);
    coverSwatch.title = "Choisir une couverture pour ce dossier";
    coverSwatch.setAttribute("aria-label", "Choisir une couverture pour ce dossier");
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
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        chip.click();
      }
    });
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
  function appendTagChip(tag) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter-chip tag-chip" + (activeTagFilter === tag ? " active" : "");
    chip.textContent = "#" + tag;
    chip.addEventListener("click", () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      renderList();
    });
    folderFiltersEl.appendChild(chip);
  }
  // Families are a purely visual cluster (see loadTagFamilies) — tags with
  // no family assigned just render as the flat row this always was.
  const families = loadTagFamilies();
  const byFamily = new Map();
  const ungroupedTags = [];
  tags.forEach((tag) => {
    const fam = families[tag];
    if (!fam) { ungroupedTags.push(tag); return; }
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(tag);
  });
  [...byFamily.keys()].sort((a, b) => a.localeCompare(b, "fr")).forEach((fam) => {
    const famLabel = document.createElement("span");
    famLabel.className = "tag-family-label";
    famLabel.textContent = fam;
    folderFiltersEl.appendChild(famLabel);
    byFamily.get(fam).forEach(appendTagChip);
  });
  ungroupedTags.forEach(appendTagChip);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Notes can arrive as HTML from three places we don't fully control: a JSON
// import, a decrypted .noteflow packet, and a Firestore sync snapshot (from
// whoever knows the sync code). All three get run through this before their
// html is ever assigned via innerHTML, so a crafted "<img onerror=...>" or
// "<script>" can't execute against the note's own author.
const SANITIZE_DANGEROUS_TAGS = new Set(["script", "iframe", "object", "embed", "link", "meta", "style", "base", "form"]);

function sanitizeNoteHtml(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = (root) => {
    Array.from(root.children).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (SANITIZE_DANGEROUS_TAGS.has(tag)) {
        el.remove();
        return;
      }
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        } else if (name === "src" && /^\s*data:(?!image\/|audio\/)/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      });
      clean(el);
    });
  };
  clean(doc.body);
  return doc.body.innerHTML;
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

// A small search-query language on top of plain substring search:
// tag:travail, dossier:Travail/Projets (also matches subfolders), est:verrouillée
// / archivée / épinglée, avant:2026-01-01 / apres:2026-01-01, "exact phrase",
// and a leading "-" negates any of the above. Anything left over after
// pulling these out is still free-text, ANDed with the rest — so a plain
// search like before ("facture avril") keeps working exactly the same.
const SEARCH_OP_ALIASES = { folder: "dossier" };
function parseSearchQuery(raw) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens
    .map((tok) => {
      let text = tok;
      let negate = false;
      if (text.startsWith("-") && text.length > 1) {
        negate = true;
        text = text.slice(1);
      }
      const opMatch = /^(tag|dossier|folder|avant|apres|après|est|prop):(.+)$/i.exec(text);
      if (opMatch) {
        let op = opMatch[1].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        op = SEARCH_OP_ALIASES[op] || op;
        return { negate, op, value: opMatch[2].toLowerCase() };
      }
      return { negate, text: text.toLowerCase() };
    })
    .filter((c) => c.op || c.text);
}

function noteHaystack(note) {
  return (
    note.title +
    " " +
    (note.folder || "") +
    " " +
    (note.tags || []).join(" ") +
    " " +
    (note.locked ? "" : getPreview(note) + " " + (note.ocrText || ""))
  ).toLowerCase();
}

function clauseMatches(note, clause) {
  if (clause.op === "tag") return (note.tags || []).some((t) => t.toLowerCase() === clause.value);
  if (clause.op === "dossier") return (note.folder || "").toLowerCase().startsWith(clause.value);
  if (clause.op === "avant" || clause.op === "apres") {
    const d = Date.parse(clause.value);
    if (Number.isNaN(d)) return false;
    return clause.op === "avant" ? note.updatedAt < d : note.updatedAt > d;
  }
  if (clause.op === "est") {
    const v = clause.value.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (v.startsWith("verrouill")) return !!note.locked;
    if (v.startsWith("archiv")) return !!note.archived;
    if (v.startsWith("epingl")) return !!note.pinned;
    return false;
  }
  if (clause.op === "prop") {
    const sep = clause.value.indexOf(":");
    const propKey = (sep === -1 ? clause.value : clause.value.slice(0, sep)).trim();
    const propValue = sep === -1 ? null : clause.value.slice(sep + 1).trim();
    const props = note.properties || {};
    const actualKey = Object.keys(props).find((k) => k.toLowerCase() === propKey);
    if (!actualKey) return false;
    return propValue === null || props[actualKey].toLowerCase() === propValue;
  }
  return noteHaystack(note).includes(clause.text);
}

function noteMatchesQuery(note, clauses) {
  return clauses.every((c) => (c.negate ? !clauseMatches(note, c) : clauseMatches(note, c)));
}

// --- Local "semantic" search: no embedding model ships with the app (that
// would mean a multi-megabyte download and a build step neither of which
// fit a single-file, offline-first PWA) — instead, a TF-IDF vector space
// over each note's own vocabulary, ranked by cosine similarity to the
// query. It surfaces notes that share topical vocabulary with the query
// even when no exact substring matches, which is the practical win users
// actually want out of "search by meaning" day to day. Entirely local,
// recomputed from scratch on each search (no persisted index to go stale). ---
const SEMANTIC_SEARCH_PREF_KEY = "noteflow.semanticSearch";
let semanticSearchMode = loadPref(SEMANTIC_SEARCH_PREF_KEY, false);
const STOPWORDS_FR = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "à", "a", "en", "que", "qui", "pour", "dans", "sur",
  "au", "aux", "ce", "ces", "cette", "cet", "se", "sa", "son", "ses", "est", "sont", "avec", "par", "ne", "pas",
  "plus", "ou", "mais", "comme", "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "d", "l", "c", "qu",
  "on", "y", "si", "the", "and", "of", "to", "in", "for", "with", "is", "are",
]);

function tokenizeForSemanticSearch(text) {
  return (text.toLowerCase().match(/[a-zàâäéèêëïîôöùûüçñ]+/gi) || [])
    .map((t) => t.normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .filter((t) => t.length > 2 && !STOPWORDS_FR.has(t));
}

function semanticSearch(candidates, query) {
  const docs = candidates.map((n) => ({ note: n, tokens: tokenizeForSemanticSearch(noteHaystack(n)) }));
  const df = new Map();
  docs.forEach((d) => {
    new Set(d.tokens).forEach((t) => df.set(t, (df.get(t) || 0) + 1));
  });
  const total = docs.length || 1;
  const idf = (t) => Math.log(1 + total / (1 + (df.get(t) || 0)));
  const vectorize = (tokens) => {
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    const vec = new Map();
    tf.forEach((count, t) => vec.set(t, count * idf(t)));
    return vec;
  };
  const norm = (vec) => {
    let sum = 0;
    vec.forEach((v) => (sum += v * v));
    return Math.sqrt(sum) || 1;
  };
  const cosine = (a, b) => {
    let dot = 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    small.forEach((v, k) => {
      if (big.has(k)) dot += v * big.get(k);
    });
    return dot / (norm(a) * norm(b));
  };
  const qVec = vectorize(tokenizeForSemanticSearch(query));
  return docs
    .map((d) => ({ note: d.note, score: cosine(qVec, vectorize(d.tokens)) }))
    .filter((s) => s.score > 0.04)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.note);
}

// --- Search offloaded to a Web Worker once the notebook is big enough that
// the query-matching pass could visibly stutter the UI on the main thread.
// Below the threshold, filtering runs inline (unchanged, no worker
// round-trip overhead for the common case of a small notebook). ---
const SEARCH_WORKER_THRESHOLD = 300;
let searchWorker = null;
let searchWorkerRequestId = 0;
const searchWorkerPending = new Map();

function getSearchWorker() {
  if (searchWorker) return searchWorker;
  try {
    searchWorker = new Worker("search-worker.js");
    searchWorker.addEventListener("message", (e) => {
      const { requestId, matchedIds } = e.data;
      const resolve = searchWorkerPending.get(requestId);
      if (resolve) {
        searchWorkerPending.delete(requestId);
        resolve(matchedIds);
      }
    });
    searchWorker.addEventListener("error", () => {
      // A worker script error aborts the worker silently otherwise — reject
      // every pending request so callers fall back instead of hanging.
      searchWorkerPending.forEach((resolve) => resolve(null));
      searchWorkerPending.clear();
    });
  } catch {
    searchWorker = null;
  }
  return searchWorker;
}

async function searchWithWorker(candidates, query) {
  const worker = getSearchWorker();
  if (!worker) throw new Error("Web Worker unavailable");
  const requestId = ++searchWorkerRequestId;
  const items = candidates.map((n) => ({
    id: n.id,
    tags: n.tags || [],
    folder: n.folder || "",
    updatedAt: n.updatedAt || 0,
    locked: !!n.locked,
    archived: !!n.archived,
    pinned: !!n.pinned,
    properties: n.properties || {},
    haystack: noteHaystack(n),
  }));
  const matchedIds = await new Promise((resolve) => {
    searchWorkerPending.set(requestId, resolve);
    worker.postMessage({ requestId, items, query });
  });
  // A newer keystroke may have started another search while this one was
  // still in flight — that request will render its own (fresher) result
  // shortly, so this one is dropped rather than falling back and briefly
  // flashing stale results back onto the screen.
  if (requestId !== searchWorkerRequestId) return SUPERSEDED;
  if (matchedIds === null) throw new Error("Search worker failed");
  const byId = new Map(candidates.map((n) => [n.id, n]));
  return matchedIds.map((id) => byId.get(id)).filter(Boolean);
}
const SUPERSEDED = Symbol("superseded-search-request");

function renderList() {
  notesListEl.classList.toggle("selection-mode", selectionMode);
  if (selectionMode) updateSelectionCount();
  renderFolderFilters();
  renderSavedSearchChips();
  const query = searchQuery.trim();
  const queryClauses = query ? parseSearchQuery(query) : [];
  // Highlighting only makes sense for the free-text part of the query — a
  // "tag:travail" or "est:archivée" clause has nothing literal to underline.
  const highlightTerm = queryClauses
    .filter((c) => !c.op && !c.negate)
    .map((c) => c.text)
    .join(" ")
    .trim();
  const scopeFiltered = notes.filter((n) => {
    if ((n.vaultId || DEFAULT_VAULT_ID) !== activeVaultId) return false;
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
    return true;
  });

  if (query && semanticSearchMode) {
    finishRenderList(semanticSearch(scopeFiltered, query), query, "", true);
    return;
  }

  // The text-query match itself — the part whose cost actually scales with
  // notebook size (parsing every note's stripped-HTML haystack) — is what
  // gets offloaded to the search worker once there are enough notes for it
  // to matter; everything else above is cheap primitive-field filtering
  // that's not worth the postMessage round-trip.
  if (query && scopeFiltered.length > SEARCH_WORKER_THRESHOLD) {
    searchWithWorker(scopeFiltered, query)
      .then((visible) => {
        if (visible !== SUPERSEDED) finishRenderList(visible, query, highlightTerm);
      })
      .catch(() => finishRenderList(scopeFiltered.filter((n) => noteMatchesQuery(n, queryClauses)), query, highlightTerm));
    return;
  }

  const visible = query ? scopeFiltered.filter((n) => noteMatchesQuery(n, queryClauses)) : scopeFiltered;
  finishRenderList(visible, query, highlightTerm);
}

function finishRenderList(visible, query, highlightTerm, preserveOrder) {
  // Semantic search already returns notes ranked by relevance to the query
  // — re-sorting them by pinned/date/title would throw that ranking away,
  // so preserveOrder skips it there (pinned notes lose their usual priority
  // in that one mode, which is the right trade-off: relevance is the point).
  if (!preserveOrder) {
    visible.sort((a, b) => {
      if (!!b.pinned - !!a.pinned !== 0) return !!b.pinned - !!a.pinned;
      if (sortMode === "manual") return (a.order ?? 0) - (b.order ?? 0);
      if (sortMode === "title") return (a.title || "").localeCompare(b.title || "", "fr");
      if (sortMode === "created") return b.createdAt - a.createdAt;
      // Consultation frequency, not edit recency — a note reopened often for
      // reference but rarely edited would otherwise sink in "Récentes"
      // (sorted by updatedAt) even though it's clearly the one in use.
      if (sortMode === "frequency") return (b.openCount || 0) - (a.openCount || 0) || (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0);
      return b.updatedAt - a.updatedAt;
    });
  }

  notesListEl.classList.toggle("manual-mode", sortMode === "manual");
  notesListEl.innerHTML = "";
  const isEmpty = visible.length === 0;
  notesEmptyEl.classList.toggle("show", isEmpty);
  if (isEmpty) {
    // The static "Touche + pour commencer" message was misleading whenever
    // the empty result came from a search, a folder/tag filter, or the
    // trash/archive view rather than an actually empty notebook.
    if (query) notesEmptyEl.textContent = "Aucune note ne correspond à ta recherche.";
    else if (activeFolderFilter || activeTagFilter) notesEmptyEl.textContent = "Aucune note dans ce filtre.";
    else if (listView === "trash") notesEmptyEl.textContent = "La corbeille est vide.";
    else if (listView === "archived") notesEmptyEl.textContent = "Aucune note archivée.";
    else notesEmptyEl.textContent = "Aucune note pour l'instant. Touche « + » pour commencer.";
  }

  // renderList() reruns on every reorder, tag toggle or rename, not just on
  // an actual view change — without this, dragging one note to a new spot
  // replayed the cascade entrance animation for the entire list. Only notes
  // that weren't part of the previous render (a genuinely new appearance —
  // first load, a filter revealing them, a search match) get it now.
  const previouslyRendered = lastRenderedNoteIds;
  const renderedThisPass = new Set();
  visible.forEach((note, index) => {
    renderedThisPass.add(note.id);
    const li = document.createElement("li");
    const isNewToView = !previouslyRendered.has(note.id);
    li.className = isNewToView ? "note-item note-in" : "note-item";
    if (isNewToView) li.style.animationDelay = `${Math.min(index, 12) * 28}ms`;
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
      <div class="note-main" role="button" tabindex="0">
        <div class="note-title">${badges}<span class="note-title-text"></span></div>
        <div class="note-preview"></div>
        <div class="note-meta">
          <span class="note-date"></span>
        </div>
      </div>
      <div class="note-actions">${actions}</div>
    `;
    if (note.color) li.style.backgroundColor = note.color;
    const titleEl = li.querySelector(".note-title-text");
    const previewEl = li.querySelector(".note-preview");
    titleEl.innerHTML = highlightMatch(note.title || "Sans titre", highlightTerm);
    titleEl.title = note.title || "Sans titre";
    previewEl.innerHTML = note.locked ? preview : highlightMatch(preview, highlightTerm);
    previewEl.title = preview;
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
    if (!note.locked) {
      const progress = checklistProgress(note.id, note.html);
      if (progress.total) {
        const chip = document.createElement("span");
        chip.className = "note-reminder-chip checklist-progress-chip";
        chip.innerHTML = `<svg class="icon"><use href="#icon-checklist"/></svg> ${progress.checked}/${progress.total}`;
        li.querySelector(".note-meta").appendChild(chip);
      }
    }
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
    const noteMain = li.querySelector(".note-main");
    noteMain.setAttribute("aria-label", note.locked ? "Note verrouillée" : note.title || "Note sans titre");
    const openThisNote = () => {
      if (selectionMode) {
        toggleSelect(note.id, li, checkbox);
        return;
      }
      if (listView === "trash") {
        showToast("Restaure la note pour l'ouvrir");
        return;
      }
      openNote(note.id);
    };
    noteMain.addEventListener("click", openThisNote);
    noteMain.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openThisNote();
      }
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
  lastRenderedNoteIds = renderedThisPass;
}

let searchDebounceTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = searchInput.value;
    renderList();
  }, 150);
});

const semanticSearchToggle = document.getElementById("semantic-search-toggle");
setPressed(semanticSearchToggle, semanticSearchMode);
semanticSearchToggle.addEventListener("click", () => {
  semanticSearchMode = !semanticSearchMode;
  savePref(SEMANTIC_SEARCH_PREF_KEY, semanticSearchMode);
  setPressed(semanticSearchToggle, semanticSearchMode);
  showToast(semanticSearchMode ? "Recherche par sens activée" : "Recherche par sens désactivée");
  if (searchQuery.trim()) renderList();
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
      const commit = () => {
        persistSavedSearches(loadSavedSearches().filter((x) => x.id !== s.id));
        renderSavedSearchChips();
      };
      // The chip used to just vanish mid-list-rebuild — a quick shrink first
      // gives the removal a visible cause, same spirit as the note-item
      // crumple-out animation used elsewhere for delete actions.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        commit();
        return;
      }
      chip.classList.add("chip-out");
      chip.addEventListener("animationend", commit, { once: true });
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
    vaultId: activeVaultId,
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
    bioCredentialId: null,
    bioSalt: null,
    bioWrappedKey: null,
    properties: {},
    journalDate: null,
    lastOpenedAt: null,
    lastSyncedAt: null,
    reminderAt: null,
    reminderRecur: null,
    expiresAt: null,
    reminderFired: false,
    history: [],
    color: null,
    paperStyle: "blank",
    archived: false,
    deletedAt: null,
    ocrText: "",
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

// Recently-opened note ids, most recent first — feeds the ⌘K palette's
// default list (before any query is typed) so it doubles as a quick-switcher
// between the handful of notes actually in use right now, not just an
// alphabetical/chronological browse of the whole notebook.
const RECENT_NOTES_KEY = "noteflow.recentNoteIds";
function recordRecentNote(id) {
  const list = loadPref(RECENT_NOTES_KEY, []).filter((n) => n !== id);
  list.unshift(id);
  savePref(RECENT_NOTES_KEY, list.slice(0, 10));
}

async function openNote(id) {
  currentNote = notes.find((n) => n.id === id);
  if (!currentNote) return;
  recordRecentNote(id);
  currentNote.lastOpenedAt = Date.now();
  currentNote.openCount = (currentNote.openCount || 0) + 1;
  persistNote(currentNote);
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
  lastEditorActivityAt = Date.now();
  titleInput.value = currentNote.title || "";
  folderInput.value = currentNote.folder || "";
  tagsInput.value = (currentNote.tags || []).join(", ");
  if (!currentNote.properties) currentNote.properties = {};
  renderProperties();
  // Defense in depth: also sanitize right before render, in case a note
  // already sitting in IndexedDB predates the ingestion-point sanitization
  // (import / .noteflow / Firestore sync) added alongside this line.
  textEditor.innerHTML = sanitizeNoteHtml(currentNote.html || "");
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
  reminderRecurSelect.value = currentNote.reminderRecur || "";
  editorScreen.classList.remove("focus-mode");
  editorScreen.classList.remove("reading-mode");
  textEditor.contentEditable = "true";
  document.getElementById("reading-progress").classList.add("hidden");
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

// --- Templates: reusable note structures (meeting notes, a daily journal
// page, a book-reading sheet…) — stored as plain {name, html} pairs in
// localStorage, entirely separate from the notes themselves. ---
const TEMPLATES_PREF_KEY = "noteflow.templates";

function loadTemplates() {
  return loadPref(TEMPLATES_PREF_KEY, []);
}
function saveTemplates(list) {
  savePref(TEMPLATES_PREF_KEY, list);
}

document.getElementById("save-as-template-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour l'enregistrer comme modèle");
    return;
  }
  const name = window.prompt("Nom du modèle :", currentNote.title || "Modèle");
  if (!name || !name.trim()) return;
  await flushSave(true);
  const templates = loadTemplates();
  templates.push({ id: crypto.randomUUID(), name: name.trim(), html: currentNote.html || "" });
  saveTemplates(templates);
  showToast(`Modèle « ${name.trim()} » enregistré`);
});

function renderTemplatesPickerPanel() {
  const templates = loadTemplates();
  templatesListEl.innerHTML = "";
  if (!templates.length) {
    templatesListEl.innerHTML = '<li class="history-empty">Aucun modèle enregistré pour l\'instant.</li>';
    return;
  }
  templates.forEach((tpl) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const span = document.createElement("span");
    span.textContent = tpl.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Utiliser";
    btn.addEventListener("click", async () => {
      templatesPanel.classList.add("hidden");
      const note = newNoteObject();
      note.html = tpl.html;
      notes.unshift(note);
      await persistNote(note);
      currentNote = note;
      loadNoteIntoEditor();
      showEditor();
      titleInput.focus();
    });
    li.appendChild(span);
    li.appendChild(btn);
    templatesListEl.appendChild(li);
  });
}

function renderManageTemplatesPanel() {
  const templates = loadTemplates();
  manageTemplatesListEl.innerHTML = "";
  if (!templates.length) {
    manageTemplatesListEl.innerHTML = '<li class="history-empty">Aucun modèle enregistré pour l\'instant.</li>';
    return;
  }
  templates.forEach((tpl, index) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const span = document.createElement("span");
    span.textContent = tpl.name;
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "link-btn";
    renameBtn.textContent = "Renommer";
    renameBtn.addEventListener("click", () => {
      const newName = window.prompt("Nouveau nom :", tpl.name);
      if (!newName || !newName.trim()) return;
      const list = loadTemplates();
      list[index].name = newName.trim();
      saveTemplates(list);
      renderManageTemplatesPanel();
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "link-btn danger";
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", () => {
      const list = loadTemplates();
      list.splice(index, 1);
      saveTemplates(list);
      renderManageTemplatesPanel();
    });
    li.appendChild(span);
    li.appendChild(renameBtn);
    li.appendChild(deleteBtn);
    manageTemplatesListEl.appendChild(li);
  });
}

const templatesBtn = document.getElementById("templates-btn");
const templatesPanel = document.getElementById("templates-panel");
const templatesListEl = document.getElementById("templates-list");
const manageTemplatesBtn = document.getElementById("manage-templates-btn");
const manageTemplatesPanel = document.getElementById("manage-templates-panel");
const manageTemplatesListEl = document.getElementById("manage-templates-list");

templatesBtn.addEventListener("click", () => {
  const opening = templatesPanel.classList.contains("hidden");
  templatesPanel.classList.toggle("hidden");
  if (opening) renderTemplatesPickerPanel();
});
manageTemplatesBtn.addEventListener("click", () => {
  const opening = manageTemplatesPanel.classList.contains("hidden");
  manageTemplatesPanel.classList.toggle("hidden");
  if (opening) renderManageTemplatesPanel();
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
  // No lookbehind here: it breaks script parsing (the whole file fails to
  // load, not just this line) on Safari < 16.4 / iOS <= 16.3.
  const sentences = (text.match(/[^.!?\n]+[.!?\n]*/g) || [])
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

// Moves every unchecked checklist item out of this note and into a new
// "Tâches reportées" note (checked items and everything else stay put) —
// the natural cleanup step after a to-do list accumulates carried-over
// items across several editing sessions.
document.getElementById("carry-over-tasks-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour reporter ses tâches");
    return;
  }
  const uncheckedItems = Array.from(textEditor.querySelectorAll(".checklist-item")).filter(
    (li) => !li.querySelector("input[type=checkbox]").hasAttribute("checked")
  );
  if (!uncheckedItems.length) {
    showToast("Aucune tâche non cochée à reporter");
    return;
  }
  const tasks = uncheckedItems.map((li) => li.querySelector("span").textContent.replace(/​/g, "").trim()).filter(Boolean);
  const emptiedLists = new Set();
  uncheckedItems.forEach((li) => {
    const parentUl = li.parentElement;
    li.remove();
    if (parentUl && parentUl.tagName === "UL" && !parentUl.children.length) emptiedLists.add(parentUl);
  });
  emptiedLists.forEach((ul) => ul.remove());

  const target = newNoteObject();
  target.title = `Tâches reportées — ${currentNote.title || "Sans titre"}`;
  const ul = document.createElement("ul");
  ul.className = "checklist";
  tasks.forEach((task) => {
    const li = makeChecklistLi();
    li.querySelector("span").textContent = task;
    ul.appendChild(li);
  });
  target.html = ul.outerHTML;
  notes.unshift(target);
  await persistNote(target);

  scheduleSave();
  updateWordCount();
  showToast(`${tasks.length} tâche${tasks.length > 1 ? "s" : ""} reportée${tasks.length > 1 ? "s" : ""} vers une nouvelle note`, () => goToNote(target.id), {
    actionLabel: "Ouvrir",
    ctrlZ: false,
  });
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

// Strips characters that are illegal (or awkward) in a filename on
// Windows/macOS/Linux, but — unlike a \w-based allow-list — keeps accented
// letters intact, since "Réunion d'été" turning into "Runion dt" in a
// French-first app is its own small bug.
function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "").trim();
}

// --- Markdown export/import: real portability out of the notebook, instead
// of only a JSON format nothing else reads. Not full CommonMark — a
// pragmatic subset (headings, bold/italic, lists, checklists, links, code
// fences, blockquotes) that round-trips NoteFlow's own export cleanly and
// reads plain external Markdown reasonably. ---
function yamlEscape(value) {
  return /[:#"'\n]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function htmlToMarkdown(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  const lines = [];

  function inline(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.textContent;
      } else if (child.tagName === "B" || child.tagName === "STRONG") {
        out += `**${inline(child)}**`;
      } else if (child.tagName === "I" || child.tagName === "EM") {
        out += `*${inline(child)}*`;
      } else if (child.tagName === "S" || child.tagName === "STRIKE") {
        out += `~~${inline(child)}~~`;
      } else if (child.tagName === "A") {
        out += `[${inline(child)}](${child.getAttribute("href") || ""})`;
      } else if (child.tagName === "BR") {
        out += "\n";
      } else {
        out += inline(child);
      }
    });
    return out;
  }

  // childNodes, not children: the very first line of a fresh note can be a
  // bare top-level text node (no <p> wrapper yet, before any block-level
  // command runs) — .children alone silently drops it, same quirk the note
  // splitter works around elsewhere in this file.
  Array.from(container.childNodes).forEach((el) => {
    if (el.nodeType === 3) {
      const text = el.textContent.trim();
      if (text) lines.push(text, "");
      return;
    }
    if (/^H[1-3]$/.test(el.tagName)) {
      lines.push(`${"#".repeat(Number(el.tagName[1]))} ${inline(el).trim()}`, "");
    } else if (el.tagName === "BLOCKQUOTE") {
      lines.push(`> ${inline(el).trim()}`, "");
    } else if (el.tagName === "PRE") {
      const code = el.querySelector("code");
      lines.push("```", (code ? code.textContent : el.textContent).replace(/​/g, ""), "```", "");
    } else if (el.tagName === "UL" && el.classList.contains("checklist")) {
      Array.from(el.children).forEach((li) => {
        const checked = li.querySelector("input[type=checkbox]")?.hasAttribute("checked");
        const text = (li.querySelector("span")?.textContent || "").replace(/​/g, "").trim();
        lines.push(`- [${checked ? "x" : " "}] ${text}`);
      });
      lines.push("");
    } else if (el.tagName === "UL") {
      Array.from(el.children).forEach((li) => lines.push(`- ${inline(li).trim()}`));
      lines.push("");
    } else if (el.tagName === "OL") {
      Array.from(el.children).forEach((li, i) => lines.push(`${i + 1}. ${inline(li).trim()}`));
      lines.push("");
    } else if (el.tagName === "TABLE") {
      const rows = Array.from(el.rows).map((r) => Array.from(r.cells).map((c) => inline(c).trim()));
      if (rows.length) {
        lines.push(`| ${rows[0].join(" | ")} |`);
        lines.push(`| ${rows[0].map(() => "---").join(" | ")} |`);
        rows.slice(1).forEach((r) => lines.push(`| ${r.join(" | ")} |`));
        lines.push("");
      }
    } else if (el.classList.contains("note-callout")) {
      lines.push(`> **${el.classList.contains("note-callout-warning") ? "⚠️" : "ℹ️"}** ${inline(el).trim()}`, "");
    } else if (el.tagName === "DIV" && !el.classList.contains("transclusion")) {
      lines.push(inline(el).trim(), "");
    } else {
      lines.push(inline(el).trim(), "");
    }
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownToHtml(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/~~(.+?)~~/g, "<s>$1</s>")
      .replace(/(?:^|[^*])\*([^*]+?)\*(?!\*)/g, (m, g1) => m[0] + `<i>${g1}</i>`)
      // Obsidian-style [[Page]] / [[Page|Alias]] wikilinks: left as a marker
      // span here (bare text at this point, no target note known yet) —
      // resolveImportedWikilinks() turns matching ones into real internal
      // links once every file in the batch has been parsed.
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, target, alias) => {
        const label = (alias || target).trim();
        return `<span class="wikilink-pending" data-wikilink-title="${target.trim()}">${label}</span>`;
      })
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>');
  }
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html.push(`<pre class="note-code"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    } else if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      html.push(`<h${level}>${inline(line.replace(/^#+\s+/, ""))}</h${level}>`);
      i++;
    } else if (/^>\s?/.test(line)) {
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      i++;
    } else if (/^-\s+\[[ xX]\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+\[[ xX]\]\s+/.test(lines[i])) {
        const checked = /\[[xX]\]/.test(lines[i]);
        const text = lines[i].replace(/^-\s+\[[ xX]\]\s+/, "");
        items.push(`<li class="checklist-item"><input type="checkbox"${checked ? ' checked=""' : ""}><span>${inline(text)}</span></li>`);
        i++;
      }
      html.push(`<ul class="checklist">${items.join("")}</ul>`);
    } else if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
    } else if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
    } else if (line.trim() === "") {
      i++;
    } else {
      html.push(`<p>${inline(line)}</p>`);
      i++;
    }
  }
  return html.join("");
}

function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  match[1].split("\n").forEach((line) => {
    const sep = line.indexOf(":");
    if (sep === -1) return;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (/^\[.*\]$/.test(value)) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^"|"$/g, "");
    }
  });
  return { meta, body: match[2] };
}

function exportNoteAsMarkdown(note) {
  const front = [
    "---",
    `title: ${yamlEscape(note.title || "Sans titre")}`,
    note.folder ? `folder: ${yamlEscape(note.folder)}` : null,
    note.tags && note.tags.length ? `tags: [${note.tags.map(yamlEscape).join(", ")}]` : null,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
    "---",
    "",
  ].filter((l) => l !== null);
  return front.join("\n") + htmlToMarkdown(note.html);
}

// --- Structured Markdown export: one real .md file per note, mirroring the
// folder hierarchy as actual filesystem folders — unlike the single-note
// export above or the local JSON backup (one opaque combined file), this is
// meant to be opened directly by Obsidian, a plain text editor, or anything
// else that reads a folder of Markdown. One-way (export only, no import-back
// sync loop) since round-tripping edits made outside NoteFlow back in raises
// conflict questions the JSON sync mechanism already exists to answer. ---
async function getOrCreateFolderHandle(rootHandle, folderPath) {
  if (!folderPath) return rootHandle;
  let handle = rootHandle;
  for (const segment of folderPath.split("/")) {
    const name = safeFilename(segment).trim() || "Sans nom";
    handle = await handle.getDirectoryHandle(name, { create: true });
  }
  return handle;
}

document.getElementById("export-markdown-folder-btn").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    showToast("Non disponible sur ce navigateur (Chrome/Edge sur ordinateur uniquement)");
    return;
  }
  let rootHandle;
  try {
    rootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // user cancelled the picker
  }
  const candidates = notesInActiveVault().filter((n) => !n.deletedAt);
  let exported = 0;
  let skippedLocked = 0;
  // Keyed by folder path string, not by directory handle — getDirectoryHandle
  // hands back a fresh handle object each call, so two notes in the same
  // folder would otherwise never see each other's used filenames.
  const usedNamesByDir = new Map();
  for (const note of candidates) {
    if (note.locked) {
      skippedLocked++;
      continue;
    }
    try {
      const dirHandle = await getOrCreateFolderHandle(rootHandle, note.folder);
      const dirKey = note.folder || "";
      if (!usedNamesByDir.has(dirKey)) usedNamesByDir.set(dirKey, new Set());
      const usedNames = usedNamesByDir.get(dirKey);
      let baseName = safeFilename(note.title || "Sans titre").trim() || "Sans titre";
      let filename = `${baseName}.md`;
      // Two notes can share a title in the same folder (nothing stops it in
      // NoteFlow) — a second file of the same name would silently overwrite
      // the first on disk, so disambiguate instead of losing a note.
      let suffix = 2;
      while (usedNames.has(filename)) {
        filename = `${baseName} (${suffix}).md`;
        suffix++;
      }
      usedNames.add(filename);
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(exportNoteAsMarkdown(note));
      await writable.close();
      exported++;
    } catch {
      /* one note failing (permission hiccup, odd folder name) shouldn't abort the whole export */
    }
  }
  showToast(`${exported} note${exported > 1 ? "s" : ""} exportée${exported > 1 ? "s" : ""}` + (skippedLocked ? ` (${skippedLocked} verrouillée${skippedLocked > 1 ? "s" : ""} ignorée${skippedLocked > 1 ? "s" : ""})` : ""));
});

// Notion's bulk export appends a 32-char hex block id to every filename
// ("Meeting Notes 3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c.md") — strip it so the
// imported note's title matches what the user actually sees in Notion.
function titleFromFilename(filename) {
  return (filename || "")
    .replace(/\.md$/i, "")
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .trim();
}

function importMarkdown(text, filenameHint) {
  const { meta, body } = parseFrontMatter(text);
  const note = newNoteObject();
  let title = meta.title;
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
  }
  if (!title && filenameHint) title = titleFromFilename(filenameHint);
  note.title = title || "Note importée";
  note.folder = meta.folder || "";
  note.tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [];
  note.html = sanitizeNoteHtml(markdownToHtml(body));
  return note;
}

// Second pass over a whole imported batch: [[Page]] markers left by
// markdownToHtml become real internal wikilinks when their target is found
// either among the notes just imported or already in the active vault —
// resolving against the batch first is what makes Obsidian/Notion exports
// (which link to each other, not to anything already in NoteFlow) work.
function resolveImportedWikilinks(importedNotes) {
  const titleIndex = new Map();
  [...notesInActiveVault(), ...importedNotes].forEach((n) => {
    if (!n.deletedAt) titleIndex.set((n.title || "").toLowerCase(), n);
  });
  importedNotes.forEach((note) => {
    if (!note.html.includes("wikilink-pending")) return;
    const div = document.createElement("div");
    div.innerHTML = note.html;
    div.querySelectorAll(".wikilink-pending").forEach((span) => {
      const target = titleIndex.get((span.dataset.wikilinkTitle || "").toLowerCase());
      if (target) {
        const a = document.createElement("a");
        a.href = "#";
        a.className = "wikilink";
        a.dataset.noteId = target.id;
        a.textContent = span.textContent;
        span.replaceWith(a);
      } else {
        span.replaceWith(document.createTextNode(span.textContent));
      }
    });
    note.html = sanitizeNoteHtml(div.innerHTML);
  });
}

document.getElementById("export-note-btn").addEventListener("click", async () => {
  await flushSave(true);
  const exportNote = await noteForExport(currentNote);
  const blob = new Blob([JSON.stringify(exportNote, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(exportNote.title || "note") || "note"}.json`);
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
  downloadBlob(blob, `${safeFilename(currentNote.title || "note") || "note"}.html`);
  showToast("Page web exportée");
});

document.getElementById("export-markdown-btn").addEventListener("click", async () => {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour l'exporter");
    return;
  }
  await flushSave(true);
  const md = exportNoteAsMarkdown(currentNote);
  const blob = new Blob([md], { type: "text/markdown" });
  downloadBlob(blob, `${safeFilename(currentNote.title || "note") || "note"}.md`);
  showToast("Note exportée en Markdown");
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
  downloadBlob(blob, `${safeFilename(currentNote.title || "note") || "note"}.noteflow`);
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
    note.html = sanitizeNoteHtml(payload.html || "");
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

backBtn.addEventListener("click", async () => {
  // Must await: showList() clears a locked note's plaintext from memory,
  // and flushSave's persistNote() briefly restores that same plaintext
  // (to encrypt-then-restore) after its own await — if showList() ran
  // first, that restore would race back in right after the purge.
  await flushSave(true);
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
  div.querySelectorAll("img, audio, source").forEach((el) => el.remove());
  return div.innerHTML;
}

function pushHistorySnapshot() {
  if (!currentNote.history) currentNote.history = [];
  currentNote.history.push({ title: currentNote.title, html: stripImagesForHistory(currentNote.html), ts: Date.now() });
  // Pinned milestones ("avant refonte") are exempt from the rolling 20-slot
  // cap: find the oldest *unpinned* entry to drop instead of always
  // dropping index 0, which would silently delete a milestone the user
  // explicitly asked to keep.
  if (currentNote.history.length > 20) {
    const dropIndex = currentNote.history.findIndex((s) => !s.pinned);
    if (dropIndex !== -1) currentNote.history.splice(dropIndex, 1);
  }
}

async function flushSave(immediate) {
  if (!currentNote) return;
  // Scoped here rather than inside persistNote(): persistNote is also
  // called by background machinery (the reminder/ephemeral-expiry interval,
  // Firestore sync) that isn't the user actually writing — counting those
  // toward the streak meant a day with zero typing could still "extend" it.
  recordActivityToday();
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

// Flush the pending 500ms autosave debounce when the app is about to lose
// the CPU entirely (tab closed, backgrounded, or an iOS PWA swiped away) —
// without this, the last half-second of typing before any of those was
// silently lost. "visibilitychange" fires reliably in all of these cases
// (unlike "beforeunload", which iOS Safari/PWA doesn't fire); "pagehide" is
// kept as a second signal for browsers that skip visibilitychange on close.
function flushOnLeave() {
  if (document.visibilityState === "hidden" && editorScreen.classList.contains("active") && currentNote) {
    flushSave(true);
  }
}
document.addEventListener("visibilitychange", flushOnLeave);
window.addEventListener("pagehide", flushOnLeave);

// --- Auto-relock: a locked note left open and unattended stayed decrypted
// in memory indefinitely — until the user manually navigated back to the
// list — even if the tab sat in the background or idle for hours. Backing
// the app or a couple of minutes without typing now re-locks it. ---
const AUTO_RELOCK_IDLE_MS = 2 * 60 * 1000;
let lastEditorActivityAt = Date.now();
["input", "keydown", "mousedown", "touchstart"].forEach((evt) => {
  textEditor.addEventListener(evt, () => {
    lastEditorActivityAt = Date.now();
  });
});

async function relockIfUnattended() {
  if (!currentNote || !currentNote.locked || !activeUnlockKey || activeUnlockKey.noteId !== currentNote.id) return;
  if (!editorScreen.classList.contains("active")) return;
  await flushSave(true);
  showList();
  showToast("Note reverrouillée automatiquement");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") relockIfUnattended();
  // The ambient mesh-gradient blobs animate continuously (30-46s loops) —
  // pointless work, and battery drain, while the tab isn't visible.
  document.body.classList.toggle("mesh-paused", document.visibilityState === "hidden");
});

setInterval(() => {
  if (Date.now() - lastEditorActivityAt > AUTO_RELOCK_IDLE_MS) relockIfUnattended();
}, 30000);

titleInput.addEventListener("input", scheduleSave);
folderInput.addEventListener("change", scheduleSave);
tagsInput.addEventListener("change", scheduleSave);

// --- Structured properties: key/value pairs stored on the note object
// itself (note.properties), not in the HTML body — so they stay comparable
// and filterable (prop:clé:valeur in search) instead of being just more
// unstructured text in the note. ---
const propertiesChipsEl = document.getElementById("properties-chips");
const propertiesInput = document.getElementById("properties-input");

function renderProperties() {
  propertiesChipsEl.innerHTML = "";
  const props = currentNote.properties || {};
  Object.keys(props).forEach((key) => {
    const chip = document.createElement("span");
    chip.className = "property-chip";
    const label = document.createElement("span");
    label.textContent = `${key}: ${props[key]}`;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `Retirer la propriété ${key}`);
    removeBtn.addEventListener("click", () => {
      delete currentNote.properties[key];
      renderProperties();
      scheduleSave();
    });
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    propertiesChipsEl.appendChild(chip);
  });
}

propertiesInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const raw = propertiesInput.value.trim();
  if (!raw) return;
  const sep = raw.indexOf(":");
  if (sep === -1) {
    showToast("Format attendu : clé: valeur");
    return;
  }
  const key = raw.slice(0, sep).trim();
  const value = raw.slice(sep + 1).trim();
  if (!key || !value) return;
  if (!currentNote.properties) currentNote.properties = {};
  currentNote.properties[key] = value;
  propertiesInput.value = "";
  renderProperties();
  scheduleSave();
});
textEditor.addEventListener("input", () => {
  scheduleSave();
  updateWordCount();
});

textEditor.addEventListener("input", (e) => {
  if (e.data !== " " && e.inputType !== "insertParagraph" && e.inputType !== "insertLineBreak") return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) return;
  const offset = sel.getRangeAt(0).startOffset;
  const before = node.textContent.slice(0, offset);
  // Chrome's contenteditable silently turns a typed space into a non-breaking
  // space (U+00A0) rather than U+0020 in some caret positions — a plain " "
  // in the character class below would then never match.
  const match = before.match(/(\S+)[  \n]$/);
  if (!match) return;
  const trigger = match[1];
  const snippet = loadSnippets().find((s) => s.trigger === trigger);
  if (!snippet) return;
  const cursorMarker = "$|";
  const cursorIndex = snippet.expansion.indexOf(cursorMarker);
  const expansionText = cursorIndex === -1 ? snippet.expansion : snippet.expansion.replace(cursorMarker, "");
  const range = document.createRange();
  range.setStart(node, offset - match[0].length);
  range.setEnd(node, offset);
  range.deleteContents();
  const textNode = document.createTextNode(expansionText + " ");
  range.insertNode(textNode);
  const caretPos = cursorIndex === -1 ? textNode.length : cursorIndex;
  const newRange = document.createRange();
  newRange.setStart(textNode, Math.min(caretPos, textNode.length));
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  scheduleSave();
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

// --- Reading mode: a consultation view (wider measure, taller line-height,
// chrome hidden, reading-progress bar), distinct from focus mode which is a
// *writing* mode (gold frame, ambient sound, editor stays fully live). ---
const readingModeBtn = document.getElementById("reading-mode-btn");
const readingProgressEl = document.getElementById("reading-progress");
const readingProgressFillEl = document.getElementById("reading-progress-fill");

function updateReadingProgress() {
  if (!editorScreen.classList.contains("reading-mode")) return;
  const scrollable = pageScrollEl.scrollHeight - pageScrollEl.clientHeight;
  const pct = scrollable > 0 ? Math.min(100, Math.max(0, (pageScrollEl.scrollTop / scrollable) * 100)) : 100;
  readingProgressFillEl.style.width = `${pct}%`;
}

readingModeBtn.addEventListener("click", () => {
  const entering = editorScreen.classList.toggle("reading-mode");
  textEditor.contentEditable = entering ? "false" : "true";
  readingProgressEl.classList.toggle("hidden", !entering);
  if (entering) updateReadingProgress();
});

pageScrollEl.addEventListener("scroll", updateReadingProgress);

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
const lockBiometricBtn = document.getElementById("lock-biometric-btn");
const biometricSetupBtn = document.getElementById("biometric-setup-btn");
let pendingUnlockNoteId = null;

function setLockIcon(locked) {
  lockBtn.innerHTML = `<svg class="icon"><use href="#icon-lock-${locked ? "closed" : "open"}"/></svg>${locked ? "Retirer le verrou" : "Verrouiller"}`;
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

// --- Biometric unlock (WebAuthn, PRF extension) — an additional way to
// unlock a note already PIN-protected, never a replacement: the platform
// authenticator's PRF output is used directly as the AES-GCM key material,
// so the biometric itself never leaves the device and NoteFlow never
// touches a private key. Falls back invisibly wherever unsupported.
async function biometricSupported() {
  return !!(
    window.PublicKeyCredential &&
    (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false))
  );
}

async function registerBiometricCredential() {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "NoteFlow" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "noteflow-note", displayName: "Note NoteFlow" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const prfResults = cred.getClientExtensionResults().prf;
  if (!prfResults || !prfResults.enabled || !prfResults.results) {
    throw new Error("PRF extension not supported");
  }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(prfResults.results.first), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { credentialId: bytesToB64(new Uint8Array(cred.rawId)), salt: bytesToB64(salt), key };
}

async function getBiometricKey(credentialIdB64, saltB64) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: b64ToBytes(credentialIdB64), type: "public-key" }],
      userVerification: "required",
      extensions: { prf: { eval: { first: b64ToBytes(saltB64) } } },
    },
  });
  const prfResults = assertion.getClientExtensionResults().prf;
  if (!prfResults || !prfResults.results) throw new Error("PRF result missing");
  return crypto.subtle.importKey("raw", new Uint8Array(prfResults.results.first), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Biometric auth never gets its own copy of the note's content to encrypt —
// that would silently go stale the moment the note is edited through a PIN
// session and only the PIN-side ciphertext gets refreshed. Instead the
// bio-derived key WRAPS (encrypts) the exact PIN-derived key bytes, so both
// unlock paths always decrypt the one and only `encBlob`, in sync by
// construction rather than by discipline.
biometricSetupBtn.addEventListener("click", async () => {
  if (!currentNote.locked || !currentNote.pinSalt || !currentNote.encBlob) {
    showToast("Verrouille d'abord la note avec un code PIN");
    return;
  }
  if (!(await biometricSupported())) {
    showToast("Déverrouillage biométrique non disponible sur cet appareil");
    return;
  }
  const pin = window.prompt("Confirme le code PIN de cette note pour activer Face ID / empreinte :");
  if (!pin) return;
  try {
    const saltBytes = b64ToBytes(currentNote.pinSalt);
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    const rawBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" }, baseKey, 256);
    const testKey = await crypto.subtle.importKey("raw", rawBits, { name: "AES-GCM" }, false, ["decrypt"]);
    await decryptString(testKey, currentNote.encBlob); // throws on a wrong PIN, before anything is registered
    const { credentialId, salt, key: bioKey } = await registerBiometricCredential();
    const wrapped = await encryptString(bioKey, bytesToB64(new Uint8Array(rawBits)));
    currentNote.bioCredentialId = credentialId;
    currentNote.bioSalt = salt;
    currentNote.bioWrappedKey = wrapped;
    await persistNote(currentNote);
    showToast("Déverrouillage biométrique activé pour cette note");
  } catch {
    showToast("Code incorrect ou déverrouillage biométrique impossible");
  }
});

lockBiometricBtn.addEventListener("click", async () => {
  const note = notes.find((n) => n.id === pendingUnlockNoteId);
  if (!note || !note.bioCredentialId) return;
  try {
    const bioKey = await getBiometricKey(note.bioCredentialId, note.bioSalt);
    const rawKeyB64 = await decryptString(bioKey, note.bioWrappedKey);
    const pinKey = await crypto.subtle.importKey("raw", b64ToBytes(rawKeyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const plainBlob = JSON.parse(await decryptString(pinKey, note.encBlob));
    lockFailCount = 0;
    activeUnlockKey = { noteId: note.id, key: pinKey };
    note.html = plainBlob.html || "";
    note.drawing = plainBlob.drawing || null;
    note.history = plainBlob.history || [];
    await persistNote(note);
    lockOverlay.classList.add("hidden");
    currentNote = note;
    if (navigator.vibrate) navigator.vibrate(15);
    loadNoteIntoEditor();
    showEditor();
  } catch {
    lockError.textContent = "Échec de la vérification biométrique";
    lockError.classList.remove("hidden");
  }
});

// Holds the AES key for the note currently unlocked in this session, so edits
// keep re-encrypting on save without re-prompting for the PIN. Cleared as soon
// as the note is no longer the open one (see showList()), so leaving the
// editor always requires the PIN again next time, exactly like before.
let activeUnlockKey = null;
let lockFailCount = 0;
let lockLockedUntil = 0;

function showLockOverlay() {
  modalReturnFocusEl = document.activeElement;
  pendingUnlockNoteId = currentNote.id;
  lockInput.value = "";
  lockError.classList.add("hidden");
  lockOverlay.classList.remove("hidden");
  lockBiometricBtn.classList.toggle("hidden", !currentNote.bioCredentialId);
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
  // PBKDF2 at 150k iterations plus AES-GCM decryption is genuinely slow on
  // low-end phones (can run past a second) — without this, the PIN prompt
  // just sits there with no sign anything is happening after pressing Enter.
  lockUnlockBtn.disabled = true;
  const unlockBtnLabel = lockUnlockBtn.textContent;
  lockUnlockBtn.textContent = "Déverrouillage…";
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
  } finally {
    lockUnlockBtn.disabled = false;
    lockUnlockBtn.textContent = unlockBtnLabel;
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
  restoreModalFocus();
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
    // A new PIN means a new key — any biometric wrap of the previous one is
    // now stale and would silently fail; the user re-activates it if wanted.
    currentNote.bioCredentialId = null;
    currentNote.bioSalt = null;
    currentNote.bioWrappedKey = null;
    currentNote.locked = true;
    activeUnlockKey = { noteId: currentNote.id, key };
    await persistNote(currentNote);
    activeUnlockKey = null;
    textEditor.innerHTML = "";
    currentNote.html = "";
    currentNote.drawing = null;
    // Without this, the version history array — still full of plaintext
    // snapshots — stays in memory after locking. It's already preserved
    // inside encBlob; leaving a second, unencrypted copy around means the
    // next persistNote() with no active unlock key (pin from the list,
    // archive, a reminder tick) writes it to IndexedDB/Firestore in clear.
    currentNote.history = [];
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
    currentNote.bioCredentialId = null;
    currentNote.bioSalt = null;
    currentNote.bioWrappedKey = null;
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
const reminderRecurSelect = document.getElementById("reminder-recur-select");
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
  currentNote.reminderRecur = reminderRecurSelect.value || null;
  currentNote.reminderFired = false;
  scheduleSave();
  reminderPanel.classList.add("hidden");
  showToast("Rappel programmé");
});

reminderClearBtn.addEventListener("click", () => {
  currentNote.reminderAt = null;
  currentNote.reminderRecur = null;
  currentNote.reminderFired = false;
  reminderInput.value = "";
  reminderRecurSelect.value = "";
  scheduleSave();
  reminderPanel.classList.add("hidden");
  showToast("Rappel supprimé");
});

function nextRecurrence(ts, recur) {
  const d = new Date(ts);
  if (recur === "daily") d.setDate(d.getDate() + 1);
  else if (recur === "weekly") d.setDate(d.getDate() + 7);
  else if (recur === "monthly") d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

function snoozeReminder(noteId, minutes) {
  const note = notes.find((n) => n.id === noteId);
  if (!note) return;
  note.reminderAt = Date.now() + minutes * 60000;
  note.reminderFired = false;
  persistNote(note);
  if (currentNote && currentNote.id === noteId) {
    reminderInput.value = toLocalDatetimeValue(note.reminderAt);
  }
  if (listScreen.classList.contains("active")) renderList();
}

navigator.serviceWorker &&
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "noteflow-snooze-reminder" && event.data.noteId) {
      snoozeReminder(event.data.noteId, 10);
      showToast("Rappel reporté de 10 minutes");
    }
  });

function notifyReminder(note) {
  const title = note.title || "Rappel NoteFlow";
  const body = "Touche pour ouvrir ta note.";
  if (!("Notification" in window) || Notification.permission !== "granted") {
    showToast(`Rappel : ${note.title || "Sans titre"}`, () => snoozeReminder(note.id, 10), { actionLabel: "Dans 10 min", ctrlZ: false });
    return;
  }
  // Chrome on Android (and so any Chromium-based installed PWA there) throws
  // "Illegal constructor" on `new Notification(...)` — notifications must go
  // through the service worker registration there. A single throw used to
  // abort the whole forEach below, silently dropping every other reminder
  // due that tick (each had already been marked reminderFired first).
  if (navigator.serviceWorker) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, data: { noteId: note.id }, actions: [{ action: "snooze", title: "Dans 10 min" }] }))
      .catch(() => showToast(`Rappel : ${note.title || "Sans titre"}`));
    return;
  }
  try {
    new Notification(title, { body });
  } catch {
    showToast(`Rappel : ${note.title || "Sans titre"}`);
  }
}

setInterval(() => {
  const now = Date.now();
  notes.forEach((note) => {
    if (note.reminderAt && !note.reminderFired && note.reminderAt <= now) {
      if (note.reminderRecur) {
        note.reminderAt = nextRecurrence(note.reminderAt, note.reminderRecur);
      } else {
        note.reminderFired = true;
      }
      persistNote(note);
      notifyReminder(note);
      if (listScreen.classList.contains("active")) renderList();
    }
  });
}, 30000);

// A reminder due while the app was closed entirely never got a chance to
// fire (the interval above only runs while a tab is open) — surfaced once
// as a single recap at boot instead of scattering separate notifications
// for however many piled up, or silently losing track of them.
function summarizeMissedReminders() {
  const now = Date.now();
  const missed = notes.filter((n) => !n.deletedAt && n.reminderAt && !n.reminderFired && n.reminderAt <= now);
  if (!missed.length) return;
  missed.forEach((note) => {
    if (note.reminderRecur) note.reminderAt = nextRecurrence(note.reminderAt, note.reminderRecur);
    else note.reminderFired = true;
    persistNote(note);
  });
  const names = missed.slice(0, 3).map((n) => n.title || "Sans titre").join(", ");
  const extra = missed.length > 3 ? ` et ${missed.length - 3} autre(s)` : "";
  showToast(`Rappel${missed.length > 1 ? "s" : ""} manqué${missed.length > 1 ? "s" : ""} : ${names}${extra}`);
}

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

// Word-level diff (classic LCS backtrack) between two plain-text strings —
// capped, since the DP table is O(n*m): a note has to be genuinely huge
// (a few thousand words on both sides) before this becomes noticeably slow.
const DIFF_WORD_CAP = 4000;
function diffWords(oldText, newText) {
  const a = oldText.split(/(\s+)/).filter((w) => w !== "");
  const b = newText.split(/(\s+)/).filter((w) => w !== "");
  if (a.length > DIFF_WORD_CAP || b.length > DIFF_WORD_CAP) return null;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  const parts = [];
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      parts.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: "del", text: a[i] });
      i++;
    } else {
      parts.push({ type: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) parts.push({ type: "del", text: a[i++] });
  while (j < m) parts.push({ type: "ins", text: b[j++] });
  return parts;
}

function renderDiffView(container, snap) {
  const oldText = stripHtml(snap.html);
  const newText = stripHtml(currentNote.html);
  const parts = diffWords(oldText, newText);
  container.innerHTML = "";
  if (!parts) {
    container.textContent = "Note trop volumineuse pour un aperçu détaillé.";
    return;
  }
  if (!parts.some((p) => p.type !== "same")) {
    container.textContent = "Identique au contenu actuel.";
    return;
  }
  parts.forEach((p) => {
    if (p.type === "same") {
      container.appendChild(document.createTextNode(p.text));
    } else {
      const mark = document.createElement(p.type === "del" ? "del" : "ins");
      mark.textContent = p.text;
      container.appendChild(mark);
    }
  });
}

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
    const row = document.createElement("div");
    row.className = "history-row";
    const label = document.createElement("span");
    const dateLabel = new Date(snap.ts).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    label.textContent = snap.pinned ? `📌 ${snap.label || "Jalon"} — ${dateLabel}` : dateLabel;
    const diffBox = document.createElement("div");
    diffBox.className = "history-diff hidden";
    const compareBtn = document.createElement("button");
    compareBtn.type = "button";
    compareBtn.className = "link-btn";
    compareBtn.textContent = "Comparer";
    compareBtn.addEventListener("click", () => {
      const hidden = diffBox.classList.contains("hidden");
      if (hidden) renderDiffView(diffBox, snap);
      diffBox.classList.toggle("hidden");
      compareBtn.textContent = hidden ? "Masquer" : "Comparer";
    });
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "link-btn";
    pinBtn.textContent = snap.pinned ? "Détacher" : "Épingler";
    pinBtn.addEventListener("click", () => {
      if (snap.pinned) {
        snap.pinned = false;
        snap.label = null;
      } else {
        const name = window.prompt("Nom de ce jalon :", "Jalon");
        if (!name) return;
        snap.pinned = true;
        snap.label = name.trim();
      }
      scheduleSave();
      renderHistory();
    });
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.textContent = "Restaurer";
    restoreBtn.addEventListener("click", () => {
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
    row.appendChild(label);
    row.appendChild(compareBtn);
    row.appendChild(pinBtn);
    row.appendChild(restoreBtn);
    li.appendChild(row);
    li.appendChild(diffBox);
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
  outlinePanel.classList.add("hidden");
  const opening = backlinksPanel.classList.contains("hidden");
  backlinksPanel.classList.toggle("hidden");
  if (opening) renderBacklinks();
});

// --- Outline: a live table of contents from the note's own H1/H2/H3, click
// to jump to a heading, ▾/▸ to fold/unfold everything until the next
// heading of the same or higher level (a lightweight section collapse,
// without needing to wrap the editor's content in section containers). ---
const outlineBtn = document.getElementById("outline-btn");
const outlinePanel = document.getElementById("outline-panel");
const outlineListEl = document.getElementById("outline-list");

function headingLevel(el) {
  return el.tagName === "H1" ? 1 : el.tagName === "H2" ? 2 : 3;
}

function isHeadingCollapsed(heading) {
  const next = heading.nextElementSibling;
  return !!(next && next.classList.contains("outline-collapsed"));
}

function toggleHeadingCollapse(heading) {
  const level = headingLevel(heading);
  const collapsing = !isHeadingCollapsed(heading);
  let el = heading.nextElementSibling;
  while (el && !(/^H[1-3]$/.test(el.tagName) && headingLevel(el) <= level)) {
    el.classList.toggle("outline-collapsed", collapsing);
    el = el.nextElementSibling;
  }
}

function renderOutline() {
  const headings = Array.from(textEditor.querySelectorAll("h1, h2, h3"));
  outlineListEl.innerHTML = "";
  if (!headings.length) {
    outlineListEl.innerHTML = '<li class="history-empty">Aucun titre (H1/H2/H3) dans cette note.</li>';
    return;
  }
  headings.forEach((heading, i) => {
    if (!heading.id) heading.id = `outline-heading-${i}-${Date.now()}`;
    const level = headingLevel(heading);
    const li = document.createElement("li");
    li.className = "history-item outline-item";
    li.style.marginLeft = `${(level - 1) * 14}px`;
    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "link-btn outline-fold-btn";
    foldBtn.textContent = isHeadingCollapsed(heading) ? "▸" : "▾";
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHeadingCollapse(heading);
      foldBtn.textContent = isHeadingCollapsed(heading) ? "▸" : "▾";
      scheduleSave();
    });
    const label = document.createElement("span");
    label.textContent = heading.textContent.trim() || "(sans titre)";
    label.title = label.textContent;
    label.addEventListener("click", () => {
      outlinePanel.classList.add("hidden");
      heading.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    li.appendChild(foldBtn);
    li.appendChild(label);
    outlineListEl.appendChild(li);
  });
}

// --- Split view: a read-only reference pane showing a second note beside
// the one being edited — mono-user, entirely local, for consulting or
// actually editing a source note side by side while writing the main one,
// without leaving the editor. Its own independent autosave debounce (not
// currentNote/textEditor's) keeps it fully decoupled from the main editor's
// state — no shared history snapshots, wikilink autocomplete, or drawing
// canvas, on purpose: those stay exclusive to the primary, full-featured
// editor, this pane is deliberately a lighter-weight second view. ---
const splitViewBtn = document.getElementById("split-view-btn");
const splitViewPane = document.getElementById("split-view-pane");
const splitViewSearch = document.getElementById("split-view-search");
const splitViewResults = document.getElementById("split-view-results");
const splitViewContent = document.getElementById("split-view-content");
const splitViewEditToggle = document.getElementById("split-view-edit-toggle");
let splitViewNoteId = null;
let splitViewEditable = false;
let splitViewSaveTimer = null;

function flushSplitViewSave() {
  clearTimeout(splitViewSaveTimer);
  if (!splitViewEditable || !splitViewNoteId) return;
  const note = notes.find((n) => n.id === splitViewNoteId);
  if (!note) return;
  const body = splitViewContent.querySelector(".split-view-editable");
  if (!body) return;
  note.html = sanitizeNoteHtml(body.innerHTML);
  note.updatedAt = Date.now();
  persistNote(note);
  if (listScreen.classList.contains("active")) renderList();
}

function renderSplitViewContent() {
  const note = notes.find((n) => n.id === splitViewNoteId && !n.deletedAt);
  splitViewEditToggle.classList.toggle("hidden", !note || note.locked);
  if (!note) {
    splitViewContent.innerHTML = '<p class="split-view-empty">Choisis une note ci-dessus.</p>';
    return;
  }
  if (note.locked) {
    splitViewContent.innerHTML = '<p class="split-view-empty">Cette note est verrouillée.</p>';
    return;
  }
  splitViewContent.innerHTML = `<p><strong>${escapeHtml(note.title || "Sans titre")}</strong></p><div class="split-view-editable"></div>`;
  const body = splitViewContent.querySelector(".split-view-editable");
  body.innerHTML = sanitizeNoteHtml(note.html) || "";
  body.contentEditable = splitViewEditable ? "true" : "false";
  body.addEventListener("input", () => {
    clearTimeout(splitViewSaveTimer);
    splitViewSaveTimer = setTimeout(flushSplitViewSave, 500);
  });
  splitViewEditToggle.textContent = splitViewEditable ? "Lecture seule" : "Modifier";
}

splitViewEditToggle.addEventListener("click", () => {
  flushSplitViewSave();
  splitViewEditable = !splitViewEditable;
  renderSplitViewContent();
});

function openInSplitView(noteId) {
  flushSplitViewSave();
  splitViewNoteId = noteId;
  splitViewEditable = false;
  splitViewPane.classList.remove("hidden");
  splitViewResults.classList.add("hidden");
  splitViewSearch.value = "";
  renderSplitViewContent();
}

splitViewSearch.addEventListener("input", () => {
  const q = splitViewSearch.value.trim().toLowerCase();
  if (!q) {
    splitViewResults.classList.add("hidden");
    return;
  }
  const matches = notes
    .filter((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "sans titre").toLowerCase().includes(q))
    .slice(0, 8);
  splitViewResults.innerHTML = "";
  matches.forEach((n) => {
    const li = document.createElement("li");
    li.className = "cmdk-item";
    li.innerHTML = `<span class="cmdk-item-label"></span>`;
    li.querySelector(".cmdk-item-label").textContent = n.locked ? "🔒 " + (n.title || "Sans titre") : n.title || "Sans titre";
    li.addEventListener("click", () => openInSplitView(n.id));
    splitViewResults.appendChild(li);
  });
  splitViewResults.classList.toggle("hidden", !matches.length);
});

document.getElementById("split-view-close").addEventListener("click", () => {
  flushSplitViewSave();
  splitViewPane.classList.add("hidden");
  splitViewNoteId = null;
});

splitViewBtn.addEventListener("click", () => {
  const opening = splitViewPane.classList.contains("hidden");
  if (opening) {
    splitViewPane.classList.remove("hidden");
    renderSplitViewContent();
    setTimeout(() => splitViewSearch.focus(), 30);
  } else {
    flushSplitViewSave();
    splitViewPane.classList.add("hidden");
  }
});

outlineBtn.addEventListener("click", () => {
  reminderPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
  backlinksPanel.classList.add("hidden");
  const opening = outlinePanel.classList.contains("hidden");
  outlinePanel.classList.toggle("hidden");
  if (opening) renderOutline();
});

// The surrounding paragraph/line of a link, not the whole note body — a
// quick sense of *why* another note points here, without opening it.
function extractLinkContext(html, noteId) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  const el = container.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`);
  if (!el) return "";
  const block = el.closest("p, li, div, h1, h2, h3") || el.parentElement || container;
  const text = block.textContent.trim();
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

function extractOutgoingRefs(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  const refs = [];
  container.querySelectorAll("a.wikilink[data-note-id]").forEach((a) => refs.push({ id: a.dataset.noteId, kind: "link" }));
  container.querySelectorAll(".transclusion[data-note-id]").forEach((d) => refs.push({ id: d.dataset.noteId, kind: "transclusion" }));
  return refs;
}

// Full-bleed overlays (graph/mindmap/whiteboard/tasks view) all open via a
// button click and close via an explicit close button — without this, focus
// is left on the now-hidden trigger (or falls back to <body>) once the
// overlay is dismissed, stranding keyboard/screen-reader users instead of
// putting them back where they were.
let lastOverlayTrigger = null;
function restoreOverlayFocus() {
  if (lastOverlayTrigger) {
    lastOverlayTrigger.focus();
    lastOverlayTrigger = null;
  }
}

// --- Interactive graph view: notes as nodes, wikilinks/transclusions as
// edges, laid out with a small hand-rolled force simulation (repulsion +
// spring attraction + centering, run on canvas via requestAnimationFrame) —
// no charting library, since the actual algorithm is short and this avoids
// a CDN dependency for something this self-contained. ---
const graphViewBtn = document.getElementById("graph-view-btn");
const graphViewOverlay = document.getElementById("graph-view-overlay");
const graphViewClose = document.getElementById("graph-view-close");
const graphViewCount = document.getElementById("graph-view-count");
const graphCanvas = document.getElementById("graph-canvas");
const graphCtx = graphCanvas.getContext("2d");
const graphTooltip = document.getElementById("graph-tooltip");

let graphNodes = [];
let graphEdges = [];
let graphAnimFrame = null;
let graphDragNode = null;
let graphPan = { x: 0, y: 0 };
let graphDraggingCanvas = false;
let graphLastPointer = null;
let graphHoverNode = null;

function buildGraphData() {
  const active = notesInActiveVault().filter((n) => !n.deletedAt && !n.locked);
  const idSet = new Set(active.map((n) => n.id));
  const degree = new Map();
  const edges = [];
  active.forEach((note) => {
    extractOutgoingRefs(note.html).forEach((ref) => {
      if (!idSet.has(ref.id) || ref.id === note.id) return;
      edges.push({ from: note.id, to: ref.id });
      degree.set(note.id, (degree.get(note.id) || 0) + 1);
      degree.set(ref.id, (degree.get(ref.id) || 0) + 1);
    });
  });
  const cx = graphCanvas.width / 2;
  const cy = graphCanvas.height / 2;
  const nodes = active.map((n, i) => {
    const angle = (i / active.length) * Math.PI * 2;
    const radius = 80 + Math.random() * 60;
    return {
      id: n.id,
      title: n.title || "Sans titre",
      folder: n.folder || "",
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: degree.get(n.id) || 0,
    };
  });
  return { nodes, edges };
}

// Reused as-is (not folderDisplayColor, which can return a CSS gradient
// string for custom cover swatches — not usable as a canvas fillStyle).
function graphNodeColor(node) {
  return node.folder ? folderColor(node.folder) : goldColorFallback();
}
let cachedGoldColor = null;
function goldColorFallback() {
  if (!cachedGoldColor) {
    cachedGoldColor = getComputedStyle(document.documentElement).getPropertyValue("--gold").trim() || "#c8963c";
  }
  return cachedGoldColor;
}

function renderGraphLegend(nodes) {
  cachedGoldColor = null; // theme may have changed since the last render
  const legendEl = document.getElementById("graph-view-legend");
  const folders = [...new Set(nodes.map((n) => n.folder).filter(Boolean))].sort();
  legendEl.innerHTML = "";
  if (nodes.some((n) => !n.folder)) folders.push("");
  folders.forEach((folder) => {
    const item = document.createElement("span");
    item.className = "graph-view-legend-item";
    const dot = document.createElement("span");
    dot.className = "graph-view-legend-dot";
    dot.style.background = folder ? folderColor(folder) : goldColorFallback();
    item.appendChild(dot);
    item.appendChild(document.createTextNode(folder || "Sans dossier"));
    legendEl.appendChild(item);
  });
}

function graphStep() {
  const nodes = graphNodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cx = graphCanvas.width / 2;
  const cy = graphCanvas.height / 2;
  // Repulsion between every pair — O(n²), fine for the hundreds-of-notes
  // scale a personal notebook actually reaches.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy || 0.01;
      const force = 2400 / distSq;
      const dist = Math.sqrt(distSq);
      dx /= dist;
      dy /= dist;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }
  // Spring attraction along edges.
  graphEdges.forEach((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const targetDist = 140;
    const force = (dist - targetDist) * 0.02;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  });
  // Gentle centering so the whole graph doesn't drift off-canvas.
  nodes.forEach((n) => {
    if (n === graphDragNode) return;
    n.vx += (cx - n.x) * 0.0015;
    n.vy += (cy - n.y) * 0.0015;
    n.vx *= 0.82;
    n.vy *= 0.82;
    n.x += n.vx;
    n.y += n.vy;
  });
}

function drawGraph() {
  const dpr = window.devicePixelRatio || 1;
  graphCtx.save();
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  graphCtx.clearRect(0, 0, graphCanvas.width / dpr, graphCanvas.height / dpr);
  graphCtx.translate(graphPan.x, graphPan.y);
  const byId = new Map(graphNodes.map((n) => [n.id, n]));
  const rootStyle = getComputedStyle(document.documentElement);
  const borderColor = rootStyle.getPropertyValue("--border").trim() || "rgba(0,0,0,0.1)";
  const textColor = rootStyle.getPropertyValue("--text").trim() || "#111";

  graphCtx.strokeStyle = borderColor;
  graphCtx.lineWidth = 1;
  graphEdges.forEach((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return;
    graphCtx.beginPath();
    graphCtx.moveTo(a.x, a.y);
    graphCtx.lineTo(b.x, b.y);
    graphCtx.stroke();
  });

  graphNodes.forEach((n) => {
    const r = 5 + Math.min(n.degree, 8) * 1.5;
    graphCtx.beginPath();
    graphCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
    graphCtx.fillStyle = graphNodeColor(n);
    graphCtx.globalAlpha = n === graphHoverNode ? 1 : 0.7;
    graphCtx.fill();
    graphCtx.globalAlpha = 1;
    graphCtx.fillStyle = textColor;
    graphCtx.font = "11px sans-serif";
    graphCtx.fillText(n.title.slice(0, 24), n.x + r + 4, n.y + 4);
  });
  graphCtx.restore();
}

function graphLoop() {
  graphStep();
  drawGraph();
  graphAnimFrame = requestAnimationFrame(graphLoop);
}

function resizeGraphCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = graphCanvas.getBoundingClientRect();
  graphCanvas.width = rect.width * dpr;
  graphCanvas.height = rect.height * dpr;
}

function graphPointFromEvent(e) {
  const rect = graphCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left - graphPan.x, y: e.clientY - rect.top - graphPan.y };
}

function findGraphNodeAt(pt) {
  return graphNodes.find((n) => {
    const r = 5 + Math.min(n.degree, 8) * 1.5 + 4;
    return (n.x - pt.x) ** 2 + (n.y - pt.y) ** 2 <= r * r;
  });
}

graphCanvas.addEventListener("pointerdown", (e) => {
  const pt = graphPointFromEvent(e);
  const node = findGraphNodeAt(pt);
  if (node) {
    graphDragNode = node;
    graphCanvas.setPointerCapture(e.pointerId);
  } else {
    graphDraggingCanvas = true;
    graphLastPointer = { x: e.clientX, y: e.clientY };
  }
});
graphCanvas.addEventListener("pointermove", (e) => {
  if (graphDragNode) {
    const pt = graphPointFromEvent(e);
    graphDragNode.x = pt.x;
    graphDragNode.y = pt.y;
    graphDragNode.vx = 0;
    graphDragNode.vy = 0;
  } else if (graphDraggingCanvas && graphLastPointer) {
    graphPan.x += e.clientX - graphLastPointer.x;
    graphPan.y += e.clientY - graphLastPointer.y;
    graphLastPointer = { x: e.clientX, y: e.clientY };
  } else {
    const pt = graphPointFromEvent(e);
    graphHoverNode = findGraphNodeAt(pt) || null;
    if (graphHoverNode) {
      graphTooltip.textContent = graphHoverNode.title;
      graphTooltip.style.left = `${e.clientX + 12}px`;
      graphTooltip.style.top = `${e.clientY + 12}px`;
      graphTooltip.classList.remove("hidden");
    } else {
      graphTooltip.classList.add("hidden");
    }
  }
});
graphCanvas.addEventListener("pointerup", (e) => {
  if (graphDragNode && !graphDraggingCanvas) {
    const pt = graphPointFromEvent(e);
    const moved = findGraphNodeAt(pt) === graphDragNode;
    // A drag that never really moved the pointer counts as a click.
    if (moved && Math.abs(graphDragNode.vx) < 0.01) {
      /* click-through handled by dedicated click listener below */
    }
  }
  graphDragNode = null;
  graphDraggingCanvas = false;
});
graphCanvas.addEventListener("click", (e) => {
  const pt = graphPointFromEvent(e);
  const node = findGraphNodeAt(pt);
  if (node) {
    closeGraphView();
    goToNote(node.id);
  }
});

function openGraphView() {
  graphViewOverlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    resizeGraphCanvas();
    graphPan = { x: 0, y: 0 };
    const data = buildGraphData();
    graphNodes = data.nodes;
    graphEdges = data.edges;
    graphViewCount.textContent = `${graphNodes.length} note${graphNodes.length > 1 ? "s" : ""} · ${graphEdges.length} lien${graphEdges.length > 1 ? "s" : ""}`;
    renderGraphLegend(graphNodes);
    if (graphAnimFrame) cancelAnimationFrame(graphAnimFrame);
    graphLoop();
  });
}

function closeGraphView() {
  graphViewOverlay.classList.add("hidden");
  if (graphAnimFrame) cancelAnimationFrame(graphAnimFrame);
  graphAnimFrame = null;
  restoreOverlayFocus();
}

graphViewBtn.addEventListener("click", () => {
  lastOverlayTrigger = document.getElementById("list-menu-btn");
  showList();
  openGraphView();
});
graphViewClose.addEventListener("click", closeGraphView);
window.addEventListener("resize", () => {
  if (!graphViewOverlay.classList.contains("hidden")) resizeGraphCanvas();
});

// --- Automatic mindmap: a static, read-only tree built purely from a
// note's own H1/H2/H3 headings (no manual layout, no dragging notes around
// like the graph view — this one just answers "what's the outline of this
// long note, at a glance"). ---
const mindmapViewOverlay = document.getElementById("mindmap-view-overlay");
const mindmapViewClose = document.getElementById("mindmap-view-close");
const mindmapViewTitle = document.getElementById("mindmap-view-title");
const mindmapViewBtn = document.getElementById("mindmap-view-btn");
const mindmapCanvas = document.getElementById("mindmap-canvas");
const mindmapCtx = mindmapCanvas.getContext("2d");
let mindmapNodes = [];
let mindmapEdges = [];
let mindmapPan = { x: 0, y: 0 };
let mindmapDraggingCanvas = false;
let mindmapLastPointer = null;

function parseHeadingsTree(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const root = { level: 0, text: "", children: [] };
  const stack = [root];
  Array.from(div.children).forEach((el) => {
    const m = /^H([1-3])$/.exec(el.tagName);
    if (!m) return;
    const level = Number(m[1]);
    const node = { level, text: el.textContent.trim() || "Sans titre", children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  return root;
}

const MINDMAP_H_GAP = 190;
const MINDMAP_V_GAP = 46;

function layoutMindmapTree(root) {
  let yCounter = 0;
  const nodes = [];
  const edges = [];
  function visit(node, depth, parent) {
    if (!node.children.length) {
      node.y = yCounter++ * MINDMAP_V_GAP;
    } else {
      node.children.forEach((c) => visit(c, depth + 1, node));
      const ys = node.children.map((c) => c.y);
      node.y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    node.x = depth * MINDMAP_H_GAP;
    nodes.push(node);
    if (parent) edges.push({ from: parent, to: node });
  }
  root.children.forEach((c) => visit(c, 0, null));
  return { nodes, edges };
}

function drawMindmap() {
  const dpr = window.devicePixelRatio || 1;
  mindmapCtx.save();
  mindmapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mindmapCtx.clearRect(0, 0, mindmapCanvas.width / dpr, mindmapCanvas.height / dpr);
  mindmapCtx.translate(mindmapPan.x, mindmapPan.y);
  const rootStyle = getComputedStyle(document.documentElement);
  const borderColor = rootStyle.getPropertyValue("--border").trim() || "rgba(0,0,0,0.1)";
  const goldColor = rootStyle.getPropertyValue("--gold").trim() || "#c8963c";
  const textColor = rootStyle.getPropertyValue("--text").trim() || "#111";

  mindmapCtx.strokeStyle = borderColor;
  mindmapCtx.lineWidth = 1.5;
  mindmapEdges.forEach((e) => {
    mindmapCtx.beginPath();
    mindmapCtx.moveTo(e.from.x + 6, e.from.y);
    const midX = (e.from.x + e.to.x) / 2;
    mindmapCtx.bezierCurveTo(midX, e.from.y, midX, e.to.y, e.to.x - 6, e.to.y);
    mindmapCtx.stroke();
  });

  mindmapNodes.forEach((n) => {
    const r = n.level === 1 ? 6 : n.level === 2 ? 4.5 : 3.5;
    mindmapCtx.beginPath();
    mindmapCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
    mindmapCtx.fillStyle = goldColor;
    mindmapCtx.fill();
    mindmapCtx.fillStyle = textColor;
    mindmapCtx.font = n.level === 1 ? "bold 13px sans-serif" : "12px sans-serif";
    mindmapCtx.fillText(n.text.slice(0, 30), n.x + r + 6, n.y + 4);
  });
  mindmapCtx.restore();
}

function resizeMindmapCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = mindmapCanvas.getBoundingClientRect();
  mindmapCanvas.width = rect.width * dpr;
  mindmapCanvas.height = rect.height * dpr;
}

mindmapCanvas.addEventListener("pointerdown", (e) => {
  mindmapDraggingCanvas = true;
  mindmapLastPointer = { x: e.clientX, y: e.clientY };
  mindmapCanvas.setPointerCapture(e.pointerId);
});
mindmapCanvas.addEventListener("pointermove", (e) => {
  if (!mindmapDraggingCanvas || !mindmapLastPointer) return;
  mindmapPan.x += e.clientX - mindmapLastPointer.x;
  mindmapPan.y += e.clientY - mindmapLastPointer.y;
  mindmapLastPointer = { x: e.clientX, y: e.clientY };
  drawMindmap();
});
mindmapCanvas.addEventListener("pointerup", () => {
  mindmapDraggingCanvas = false;
  mindmapLastPointer = null;
});

function openMindmapView() {
  if (currentNote.locked) {
    showToast("Déverrouille d'abord la note pour voir sa carte mentale");
    return;
  }
  const tree = parseHeadingsTree(currentNote.html);
  if (!tree.children.length) {
    showToast("Aucun titre (H1/H2/H3) dans cette note");
    return;
  }
  const { nodes, edges } = layoutMindmapTree(tree);
  mindmapNodes = nodes;
  mindmapEdges = edges;
  mindmapViewTitle.textContent = currentNote.title || "Sans titre";
  mindmapViewOverlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    resizeMindmapCanvas();
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxY = Math.max(...nodes.map((n) => n.y));
    const rect = mindmapCanvas.getBoundingClientRect();
    mindmapPan = { x: 30, y: rect.height / 2 - (minY + maxY) / 2 };
    drawMindmap();
  });
}

function closeMindmapView() {
  mindmapViewOverlay.classList.add("hidden");
  restoreOverlayFocus();
}

mindmapViewBtn.addEventListener("click", () => {
  lastOverlayTrigger = document.getElementById("editor-menu-btn");
  openMindmapView();
});
mindmapViewClose.addEventListener("click", closeMindmapView);
window.addEventListener("resize", () => {
  if (!mindmapViewOverlay.classList.contains("hidden")) {
    resizeMindmapCanvas();
    drawMindmap();
  }
});

// --- Infinite whiteboard: freeform text cards + freehand drawing sharing
// one coordinate space, entirely separate from the note editor and from
// any single note — its own per-vault canvas for spatial thinking rather
// than linear note-taking. A large fixed "world" panned via a CSS
// transform stands in for a truly unbounded canvas: simpler and plenty
// for sketching out ideas without the complexity (and risk) of a
// dynamically resizing coordinate space. ---
const WHITEBOARD_WORLD = { w: 3000, h: 2000 };
const whiteboardOverlay = document.getElementById("whiteboard-overlay");
const whiteboardClose = document.getElementById("whiteboard-close");
const whiteboardWorldWrap = document.getElementById("whiteboard-world-wrap");
const whiteboardWorld = document.getElementById("whiteboard-world");
const whiteboardCanvas = document.getElementById("whiteboard-canvas");
const whiteboardCtx = whiteboardCanvas.getContext("2d");
const whiteboardCardsEl = document.getElementById("whiteboard-cards");
const whiteboardBtn = document.getElementById("whiteboard-btn");
const whiteboardMoveBtn = document.getElementById("whiteboard-move-btn");
const whiteboardPenBtn = document.getElementById("whiteboard-pen-btn");
const whiteboardAddCardBtn = document.getElementById("whiteboard-add-card-btn");
const whiteboardUndoBtn = document.getElementById("whiteboard-undo-btn");

let whiteboardMode = "move"; // "move" | "pen"
let whiteboardPan = { x: 0, y: 0 };
let whiteboardData = { cards: [], strokes: [] };
let whiteboardActiveStroke = null;
let whiteboardPanning = false;
let whiteboardLastPointer = null;
let whiteboardDragState = null;

function whiteboardKey() {
  return "noteflow.whiteboard." + activeVaultId;
}
function loadWhiteboard() {
  const data = loadPref(whiteboardKey(), { cards: [], strokes: [] });
  if (!Array.isArray(data.cards)) data.cards = [];
  if (!Array.isArray(data.strokes)) data.strokes = [];
  return data;
}
function saveWhiteboard() {
  savePref(whiteboardKey(), whiteboardData);
}

function applyWhiteboardTransform() {
  whiteboardWorld.style.transform = `translate(${whiteboardPan.x}px, ${whiteboardPan.y}px)`;
}

function resizeWhiteboardCanvas() {
  const dpr = window.devicePixelRatio || 1;
  whiteboardCanvas.width = WHITEBOARD_WORLD.w * dpr;
  whiteboardCanvas.height = WHITEBOARD_WORLD.h * dpr;
  whiteboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWhiteboardStroke(stroke) {
  if (stroke.points.length < 2) return;
  whiteboardCtx.strokeStyle = stroke.color;
  whiteboardCtx.lineWidth = stroke.width;
  whiteboardCtx.lineJoin = "round";
  whiteboardCtx.lineCap = "round";
  whiteboardCtx.beginPath();
  stroke.points.forEach((p, i) => {
    if (i === 0) whiteboardCtx.moveTo(p.x, p.y);
    else whiteboardCtx.lineTo(p.x, p.y);
  });
  whiteboardCtx.stroke();
}

function drawWhiteboardStrokes() {
  whiteboardCtx.clearRect(0, 0, WHITEBOARD_WORLD.w, WHITEBOARD_WORLD.h);
  whiteboardData.strokes.forEach(drawWhiteboardStroke);
}

function whiteboardPointFromEvent(e) {
  const rect = whiteboardCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function renderWhiteboardCard(card) {
  const el = document.createElement("div");
  el.className = "whiteboard-card";
  el.style.left = card.x + "px";
  el.style.top = card.y + "px";
  el.dataset.id = card.id;

  const del = document.createElement("button");
  del.type = "button";
  del.className = "whiteboard-card-delete";
  del.textContent = "×";
  del.title = "Supprimer cette carte";
  del.addEventListener("mousedown", (e) => e.preventDefault());
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    whiteboardData.cards = whiteboardData.cards.filter((c) => c.id !== card.id);
    saveWhiteboard();
    el.remove();
  });
  el.appendChild(del);

  // Kept as a separate contentEditable node from the card itself — the
  // delete button lives outside it, so its "×" never leaks into
  // el.textContent the way it would if the whole card were editable.
  const text = document.createElement("div");
  text.className = "whiteboard-card-text";
  text.contentEditable = "true";
  text.textContent = card.text || "";
  text.addEventListener("input", () => {
    card.text = text.textContent;
    saveWhiteboard();
  });
  el.appendChild(text);

  el.addEventListener("pointerdown", (e) => {
    if (e.target === del) return;
    whiteboardDragState = { card, el, startX: e.clientX, startY: e.clientY, cardX: card.x, cardY: card.y, dragging: false };
  });
  whiteboardCardsEl.appendChild(el);
  return el;
}

whiteboardCardsEl.addEventListener("pointermove", (e) => {
  if (!whiteboardDragState) return;
  const { card, el, startX, startY, cardX, cardY } = whiteboardDragState;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!whiteboardDragState.dragging && Math.hypot(dx, dy) < 4) return;
  whiteboardDragState.dragging = true;
  card.x = cardX + dx;
  card.y = cardY + dy;
  el.style.left = card.x + "px";
  el.style.top = card.y + "px";
});
document.addEventListener("pointerup", () => {
  if (whiteboardDragState && whiteboardDragState.dragging) saveWhiteboard();
  whiteboardDragState = null;
});

function setWhiteboardMode(mode) {
  whiteboardMode = mode;
  setPressed(whiteboardMoveBtn, mode === "move");
  setPressed(whiteboardPenBtn, mode === "pen");
  whiteboardWorldWrap.classList.toggle("drawing", mode === "pen");
}
whiteboardMoveBtn.addEventListener("click", () => setWhiteboardMode("move"));
whiteboardPenBtn.addEventListener("click", () => setWhiteboardMode("pen"));

whiteboardCanvas.addEventListener("pointerdown", (e) => {
  if (whiteboardMode === "pen") {
    const rootStyle = getComputedStyle(document.documentElement);
    const color = rootStyle.getPropertyValue("--text").trim() || "#1d1d1f";
    whiteboardActiveStroke = { points: [whiteboardPointFromEvent(e)], color, width: 3 };
    whiteboardData.strokes.push(whiteboardActiveStroke);
  } else {
    whiteboardPanning = true;
    whiteboardLastPointer = { x: e.clientX, y: e.clientY };
    whiteboardWorldWrap.classList.add("panning");
  }
  whiteboardCanvas.setPointerCapture(e.pointerId);
});
whiteboardCanvas.addEventListener("pointermove", (e) => {
  if (whiteboardMode === "pen" && whiteboardActiveStroke) {
    whiteboardActiveStroke.points.push(whiteboardPointFromEvent(e));
    drawWhiteboardStroke(whiteboardActiveStroke);
  } else if (whiteboardPanning && whiteboardLastPointer) {
    whiteboardPan.x += e.clientX - whiteboardLastPointer.x;
    whiteboardPan.y += e.clientY - whiteboardLastPointer.y;
    whiteboardLastPointer = { x: e.clientX, y: e.clientY };
    applyWhiteboardTransform();
  }
});
function endWhiteboardInteraction() {
  if (whiteboardActiveStroke) {
    whiteboardActiveStroke = null;
    saveWhiteboard();
  }
  whiteboardPanning = false;
  whiteboardLastPointer = null;
  whiteboardWorldWrap.classList.remove("panning");
}
whiteboardCanvas.addEventListener("pointerup", endWhiteboardInteraction);
whiteboardCanvas.addEventListener("pointercancel", endWhiteboardInteraction);

whiteboardUndoBtn.addEventListener("click", () => {
  if (!whiteboardData.strokes.length) return;
  whiteboardData.strokes.pop();
  drawWhiteboardStrokes();
  saveWhiteboard();
});

whiteboardAddCardBtn.addEventListener("click", () => {
  const rect = whiteboardWorldWrap.getBoundingClientRect();
  const card = {
    id: crypto.randomUUID(),
    x: -whiteboardPan.x + rect.width / 2 - 100,
    y: -whiteboardPan.y + rect.height / 2 - 50,
    text: "",
  };
  whiteboardData.cards.push(card);
  saveWhiteboard();
  const el = renderWhiteboardCard(card);
  el.querySelector(".whiteboard-card-text").focus();
});

function openWhiteboard() {
  whiteboardData = loadWhiteboard();
  whiteboardPan = { x: 0, y: 0 };
  applyWhiteboardTransform();
  setWhiteboardMode("move");
  whiteboardOverlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    resizeWhiteboardCanvas();
    drawWhiteboardStrokes();
    whiteboardCardsEl.innerHTML = "";
    whiteboardData.cards.forEach(renderWhiteboardCard);
  });
}
function closeWhiteboard() {
  whiteboardOverlay.classList.add("hidden");
  restoreOverlayFocus();
}
whiteboardBtn.addEventListener("click", () => {
  lastOverlayTrigger = document.getElementById("list-menu-btn");
  showList();
  openWhiteboard();
});
whiteboardClose.addEventListener("click", closeWhiteboard);

// --- Centralized tasks view: every checklist item across every note,
// grouped by note, editable in place (toggling here writes straight back
// into that note's stored html — no need to open the note itself). ---
const tasksViewBtn = document.getElementById("tasks-view-btn");
const tasksViewOverlay = document.getElementById("tasks-view-overlay");
const tasksViewClose = document.getElementById("tasks-view-close");
const tasksViewCount = document.getElementById("tasks-view-count");
const tasksViewListEl = document.getElementById("tasks-view-list");
const tasksHideDoneBtn = document.getElementById("tasks-hide-done-btn");
let tasksHideDone = loadPref("noteflow.tasks.hideDone", false);

function collectAllTasks() {
  const tasks = [];
  notesInActiveVault()
    .filter((n) => !n.deletedAt && !n.archivedAt && !n.locked)
    .forEach((note) => {
      const div = document.createElement("div");
      div.innerHTML = note.html || "";
      const items = div.querySelectorAll(".checklist-item");
      items.forEach((li, index) => {
        const cb = li.querySelector("input[type=checkbox]");
        if (!cb) return;
        const span = li.querySelector("span");
        tasks.push({
          noteId: note.id,
          noteTitle: note.title || "Sans titre",
          itemIndex: index,
          checked: cb.hasAttribute("checked"),
          text: span ? span.textContent : "",
        });
      });
    });
  return tasks;
}

function toggleTaskInNote(noteId, itemIndex) {
  const note = notes.find((n) => n.id === noteId && !n.deletedAt);
  if (!note) return;
  const div = document.createElement("div");
  div.innerHTML = note.html || "";
  const li = div.querySelectorAll(".checklist-item")[itemIndex];
  const cb = li && li.querySelector("input[type=checkbox]");
  if (!cb) return;
  if (cb.hasAttribute("checked")) cb.removeAttribute("checked");
  else cb.setAttribute("checked", "");
  note.html = div.innerHTML;
  note.updatedAt = Date.now();
  persistNote(note);
  if (currentNote && currentNote.id === noteId) {
    textEditor.innerHTML = sanitizeNoteHtml(note.html);
  }
}

function renderTasksView() {
  const all = collectAllTasks();
  const visible = tasksHideDone ? all.filter((t) => !t.checked) : all;
  const doneCount = all.filter((t) => t.checked).length;
  tasksViewCount.textContent = `${all.length - doneCount}/${all.length} tâche${all.length > 1 ? "s" : ""} restante${all.length - doneCount > 1 ? "s" : ""}`;
  tasksViewListEl.innerHTML = "";
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.textContent = all.length ? "Toutes les tâches sont cochées." : "Aucune tâche dans le carnet.";
    tasksViewListEl.appendChild(li);
    return;
  }
  const byNote = new Map();
  visible.forEach((t) => {
    if (!byNote.has(t.noteId)) byNote.set(t.noteId, []);
    byNote.get(t.noteId).push(t);
  });
  byNote.forEach((items, noteId) => {
    const header = document.createElement("li");
    header.className = "history-item tasks-note-header";
    const noteBtn = document.createElement("button");
    noteBtn.type = "button";
    noteBtn.className = "link-btn";
    noteBtn.textContent = items[0].noteTitle;
    noteBtn.addEventListener("click", () => {
      tasksViewOverlay.classList.add("hidden");
      goToNote(noteId);
    });
    header.appendChild(noteBtn);
    tasksViewListEl.appendChild(header);
    items.forEach((t) => {
      const li = document.createElement("li");
      li.className = "history-item task-view-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = t.checked;
      cb.addEventListener("change", () => {
        toggleTaskInNote(t.noteId, t.itemIndex);
        renderTasksView();
      });
      const label = document.createElement("span");
      label.textContent = t.text;
      label.className = t.checked ? "task-view-text task-view-done" : "task-view-text";
      li.appendChild(cb);
      li.appendChild(label);
      tasksViewListEl.appendChild(li);
    });
  });
}

tasksViewBtn.addEventListener("click", () => {
  lastOverlayTrigger = document.getElementById("list-menu-btn");
  showList();
  tasksViewOverlay.classList.remove("hidden");
  renderTasksView();
});
tasksViewClose.addEventListener("click", () => {
  tasksViewOverlay.classList.add("hidden");
  restoreOverlayFocus();
});
tasksHideDoneBtn.addEventListener("click", () => {
  tasksHideDone = !tasksHideDone;
  savePref("noteflow.tasks.hideDone", tasksHideDone);
  setPressed(tasksHideDoneBtn, tasksHideDone);
  renderTasksView();
});

// --- Kanban view: a lightweight board over whatever folder/tag filter is
// active in the list (or the whole vault if none), grouped by a "statut"
// note property — no new data model, it reuses the existing free-form
// properties system so a card's column is also just a normal `prop:statut:…`
// search clause. Scoped to the current filter rather than the whole
// notebook: an unscoped board of hundreds of notes in three columns would
// be closer to noise than a project view. ---
const kanbanViewBtn = document.getElementById("kanban-view-btn");
const kanbanViewOverlay = document.getElementById("kanban-view-overlay");
const kanbanViewClose = document.getElementById("kanban-view-close");
const kanbanViewCount = document.getElementById("kanban-view-count");
const kanbanBoardEl = document.getElementById("kanban-board");
const KANBAN_COLUMNS = [
  { key: "a-faire", label: "À faire" },
  { key: "en-cours", label: "En cours" },
  { key: "fait", label: "Fait" },
];

function noteKanbanStatus(note) {
  const raw = note.properties && note.properties.statut;
  return KANBAN_COLUMNS.some((c) => c.key === raw) ? raw : "a-faire";
}

function kanbanScopedNotes() {
  return notesInActiveVault().filter((n) => {
    if (n.deletedAt || n.archived || n.locked) return false;
    if (activeFolderFilter && n.folder !== activeFolderFilter && !(n.folder || "").startsWith(activeFolderFilter + "/")) return false;
    if (activeTagFilter && !(n.tags || []).includes(activeTagFilter)) return false;
    return true;
  });
}

// Deterministic per-card tilt (same note always tilts the same way instead
// of jittering on every re-render) — small range so a column full of cards
// reads as "pinned to a board", not seasick.
function kanbanCardTilt(noteId) {
  let hash = 0;
  for (let i = 0; i < noteId.length; i++) hash = noteId.charCodeAt(i) + ((hash << 5) - hash);
  return `${(Math.abs(hash) % 7) - 3}deg`;
}

function renderKanbanCard(note) {
  const card = document.createElement("div");
  card.className = "kanban-card";
  card.draggable = true;
  card.dataset.noteId = note.id;
  card.style.setProperty("--card-tilt", kanbanCardTilt(note.id));
  const pin = document.createElement("span");
  pin.className = "kanban-card-pin";
  pin.style.background = note.folder ? folderColor(note.folder) : "var(--gold)";
  card.appendChild(pin);
  const title = document.createElement("div");
  title.className = "kanban-card-title";
  title.textContent = note.title || "Sans titre";
  card.appendChild(title);
  const preview = getPreview(note);
  if (preview) {
    const previewEl = document.createElement("div");
    previewEl.className = "kanban-card-preview";
    previewEl.textContent = preview;
    card.appendChild(previewEl);
  }
  card.addEventListener("click", () => {
    kanbanViewOverlay.classList.add("hidden");
    goToNote(note.id);
  });
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", note.id);
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
}

function renderKanban() {
  const scoped = kanbanScopedNotes();
  kanbanViewCount.textContent = `${scoped.length} note${scoped.length > 1 ? "s" : ""}` + (activeFolderFilter ? ` · ${activeFolderFilter}` : "") + (activeTagFilter ? ` · #${activeTagFilter}` : "");
  kanbanBoardEl.innerHTML = "";
  KANBAN_COLUMNS.forEach((col) => {
    const colEl = document.createElement("div");
    colEl.className = "kanban-column";
    colEl.dataset.status = col.key;
    const header = document.createElement("div");
    header.className = "kanban-column-header";
    const label = document.createElement("span");
    label.textContent = col.label;
    const colNotes = scoped.filter((n) => noteKanbanStatus(n) === col.key);
    const count = document.createElement("span");
    count.className = "kanban-column-count";
    count.textContent = String(colNotes.length);
    header.appendChild(label);
    header.appendChild(count);
    colEl.appendChild(header);
    if (!colNotes.length) {
      const empty = document.createElement("div");
      empty.className = "kanban-empty";
      empty.textContent = "Vide";
      colEl.appendChild(empty);
    } else {
      colNotes.forEach((n) => colEl.appendChild(renderKanbanCard(n)));
    }
    colEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      colEl.classList.add("drag-over");
    });
    colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
    colEl.addEventListener("drop", (e) => {
      e.preventDefault();
      colEl.classList.remove("drag-over");
      const noteId = e.dataTransfer.getData("text/plain");
      const note = notes.find((n) => n.id === noteId);
      if (!note || noteKanbanStatus(note) === col.key) return;
      if (!note.properties) note.properties = {};
      note.properties.statut = col.key;
      note.updatedAt = Date.now();
      persistNote(note);
      renderKanban();
    });
    kanbanBoardEl.appendChild(colEl);
  });
}

function closeKanbanView() {
  kanbanViewOverlay.classList.add("hidden");
  restoreOverlayFocus();
}

kanbanViewBtn.addEventListener("click", () => {
  lastOverlayTrigger = document.getElementById("list-menu-btn");
  showList();
  kanbanViewOverlay.classList.remove("hidden");
  renderKanban();
});
kanbanViewClose.addEventListener("click", closeKanbanView);

// --- Vaults panel: switch/create/rename/delete workspaces. ---
const vaultsBtn = document.getElementById("vaults-btn");
const vaultsBtnCurrent = document.getElementById("vaults-btn-current");
const vaultsPanel = document.getElementById("vaults-panel");
const vaultsListEl = document.getElementById("vaults-list");
const vaultCreateBtn = document.getElementById("vault-create-btn");

function updateVaultsBtnLabel() {
  const current = vaults.find((v) => v.id === activeVaultId);
  vaultsBtnCurrent.textContent = current ? current.name : "";
}

function renderVaultsPanel() {
  vaultsListEl.innerHTML = "";
  vaults.forEach((vault) => {
    const li = document.createElement("li");
    li.className = "history-item history-row";
    const label = document.createElement("span");
    label.textContent = (vault.id === activeVaultId ? "✓ " : "") + vault.name;
    const actions = document.createElement("div");
    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "link-btn";
    switchBtn.textContent = "Ouvrir";
    switchBtn.disabled = vault.id === activeVaultId;
    switchBtn.addEventListener("click", () => {
      setActiveVault(vault.id);
      updateVaultsBtnLabel();
      renderVaultsPanel();
      showToast(`Espace « ${vault.name} » ouvert`);
    });
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "link-btn";
    renameBtn.textContent = "Renommer";
    renameBtn.addEventListener("click", () => {
      const name = window.prompt("Nouveau nom :", vault.name);
      if (!name || !name.trim()) return;
      vault.name = name.trim();
      saveVaults(vaults);
      updateVaultsBtnLabel();
      renderVaultsPanel();
    });
    actions.appendChild(switchBtn);
    actions.appendChild(renameBtn);
    if (vaults.length > 1) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "link-btn danger";
      deleteBtn.textContent = "Supprimer";
      deleteBtn.addEventListener("click", () => {
        const fallback = vaults.find((v) => v.id !== vault.id);
        if (!window.confirm(`Supprimer l'espace « ${vault.name} » ? Ses notes seront déplacées vers « ${fallback.name} ».`)) return;
        notes.forEach((n) => {
          if ((n.vaultId || DEFAULT_VAULT_ID) === vault.id) {
            n.vaultId = fallback.id;
            persistNote(n);
          }
        });
        vaults = vaults.filter((v) => v.id !== vault.id);
        saveVaults(vaults);
        if (activeVaultId === vault.id) setActiveVault(fallback.id);
        else renderList();
        updateVaultsBtnLabel();
        renderVaultsPanel();
        showToast(`Espace « ${vault.name} » supprimé`);
      });
      actions.appendChild(deleteBtn);
    }
    li.appendChild(label);
    li.appendChild(actions);
    vaultsListEl.appendChild(li);
  });
}

vaultsBtn.addEventListener("click", () => {
  const opening = vaultsPanel.classList.contains("hidden");
  vaultsPanel.classList.toggle("hidden");
  if (opening) renderVaultsPanel();
});
vaultCreateBtn.addEventListener("click", () => {
  const name = window.prompt("Nom du nouvel espace de travail :", "");
  if (!name || !name.trim()) return;
  const vault = { id: crypto.randomUUID(), name: name.trim() };
  vaults.push(vault);
  saveVaults(vaults);
  setActiveVault(vault.id);
  updateVaultsBtnLabel();
  renderVaultsPanel();
  showToast(`Espace « ${vault.name} » créé`);
});
updateVaultsBtnLabel();

function addBacklinksSection(title, entries, emptyText) {
  const header = document.createElement("li");
  header.className = "backlinks-section-header";
  header.textContent = title;
  backlinksListEl.appendChild(header);
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = emptyText;
    backlinksListEl.appendChild(li);
    return;
  }
  entries.forEach(({ label, sub, targetId, broken }) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const textWrap = document.createElement("div");
    textWrap.className = "backlink-text";
    const labelEl = document.createElement("span");
    labelEl.textContent = broken ? `${label} (lien brisé)` : label;
    labelEl.title = labelEl.textContent;
    textWrap.appendChild(labelEl);
    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "backlink-extract";
      subEl.textContent = sub;
      subEl.title = sub;
      textWrap.appendChild(subEl);
    }
    li.appendChild(textWrap);
    if (!broken) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Ouvrir";
      btn.addEventListener("click", () => {
        backlinksPanel.classList.add("hidden");
        goToNote(targetId);
      });
      li.appendChild(btn);
    }
    backlinksListEl.appendChild(li);
  });
}

// --- Related notes: a heuristic suggestion panel, distinct from the
// explicit wikilink backlinks above it — surfaces connections the user
// never typed a [[link]] for, based on shared tags (strong signal) and
// shared significant words in title/preview (weaker signal). Nothing here
// is stored; it's recomputed each time the backlinks panel renders. ---
const RELATED_STOPWORDS_FR = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "est",
  "pour", "avec", "dans", "sur", "au", "aux", "que", "qui", "ne", "pas",
  "plus", "ce", "cette", "ces", "son", "sa", "ses", "en", "à", "a", "il",
  "elle", "nous", "vous", "ils", "elles", "se", "ça", "je", "tu", "on",
  "par", "sans", "sous", "mais", "donc", "or", "ni", "car", "tout", "toute",
  "être", "avoir", "fait", "faire", "cela", "leur", "leurs", "dont", "où",
]);

function relatedNotesSignificantWords(text) {
  const matches = text.toLowerCase().match(/[a-zàâäéèêëïîôöùûüçñ0-9]{4,}/g) || [];
  return new Set(matches.filter((w) => !RELATED_STOPWORDS_FR.has(w)));
}

function findRelatedNotes(note, excludeIds) {
  const noteTags = new Set((note.tags || []).map((t) => t.toLowerCase()));
  const noteWords = note.locked ? new Set() : relatedNotesSignificantWords((note.title || "") + " " + getPreview(note));
  if (!noteTags.size && !noteWords.size) return [];
  const scored = [];
  notes.forEach((n) => {
    if (n.id === note.id || n.deletedAt || n.archived || excludeIds.has(n.id)) return;
    if ((n.vaultId || DEFAULT_VAULT_ID) !== activeVaultId) return;
    const tags = new Set((n.tags || []).map((t) => t.toLowerCase()));
    const sharedTags = [...noteTags].filter((t) => tags.has(t));
    let sharedWordsCount = 0;
    if (!n.locked) {
      const words = relatedNotesSignificantWords((n.title || "") + " " + getPreview(n));
      sharedWordsCount = [...noteWords].filter((w) => words.has(w)).length;
    }
    const score = sharedTags.length * 3 + sharedWordsCount;
    if (score > 0) scored.push({ note: n, sharedTags, sharedWordsCount, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ note: n, sharedTags, sharedWordsCount }) => {
    const why = sharedTags.length
      ? `${sharedTags.length} tag${sharedTags.length > 1 ? "s" : ""} en commun : ${sharedTags.join(", ")}`
      : `${sharedWordsCount} mot${sharedWordsCount > 1 ? "s" : ""}-clé${sharedWordsCount > 1 ? "s" : ""} en commun`;
    return {
      label: n.locked ? "🔒 " + (n.title || "Sans titre") : n.title || "Sans titre",
      sub: why,
      targetId: n.id,
    };
  });
}

function renderBacklinks() {
  backlinksListEl.innerHTML = "";
  const needle = `data-note-id="${currentNote.id}"`;
  const incoming = notes
    .filter((n) => !n.deletedAt && n.id !== currentNote.id && (n.html || "").includes(needle))
    .map((n) => ({
      label: n.locked ? "🔒 " + (n.title || "Sans titre") : n.title || "Sans titre",
      sub: n.locked ? "" : extractLinkContext(n.html, currentNote.id),
      targetId: n.id,
    }));

  const outgoingRefs = extractOutgoingRefs(currentNote.html);
  const outgoingLinks = outgoingRefs
    .filter((r) => r.kind === "link")
    .map((r) => {
      const target = notes.find((n) => n.id === r.id && !n.deletedAt);
      return target
        ? { label: target.locked ? "🔒 " + (target.title || "Sans titre") : target.title || "Sans titre", targetId: target.id }
        : { label: "Note supprimée", broken: true };
    });
  const transclusions = outgoingRefs
    .filter((r) => r.kind === "transclusion")
    .map((r) => {
      const target = notes.find((n) => n.id === r.id && !n.deletedAt);
      return target
        ? { label: target.locked ? "🔒 " + (target.title || "Sans titre") : target.title || "Sans titre", targetId: target.id }
        : { label: "Note supprimée", broken: true };
    });

  addBacklinksSection("Liens entrants", incoming, "Aucune note ne pointe encore ici.");
  addBacklinksSection("Liens sortants", outgoingLinks, "Cette note ne pointe vers aucune autre.");
  addBacklinksSection("Transclusions", transclusions, "Aucune transclusion dans cette note.");

  const alreadyLinked = new Set(
    [...incoming, ...outgoingLinks, ...transclusions].filter((e) => !e.broken).map((e) => e.targetId)
  );
  const related = findRelatedNotes(currentNote, alreadyLinked);
  addBacklinksSection("Notes apparentées", related, "Aucune note apparentée trouvée.");
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

// --- Wikilinks: typing [[Titre]] turns into a clickable link to that note.
// A live popup also opens right after "[[" and filters as you type, with
// arrow keys + Enter to pick — including a "Créer la note…" entry when
// nothing matches, instead of silently doing nothing until you finish
// typing an exact, pre-existing title. ---
const wikilinkAutocompleteEl = document.getElementById("wikilink-autocomplete");
let wikilinkAcItems = [];
let wikilinkAcIndex = 0;
let wikilinkAcRange = null; // { node, start, end } spanning "[[query" (no closing "]]")

function closeWikilinkAutocomplete() {
  wikilinkAutocompleteEl.classList.add("hidden");
  wikilinkAcItems = [];
  wikilinkAcRange = null;
}

function insertWikilinkAt(node, start, end, target) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  range.deleteContents();
  const a = document.createElement("a");
  a.href = "#";
  a.className = "wikilink";
  a.dataset.noteId = target.id;
  a.textContent = target.title || "Sans titre";
  range.insertNode(a);
  const spacer = document.createTextNode("​");
  a.parentNode.insertBefore(spacer, a.nextSibling);
  const sel = window.getSelection();
  range.setStart(spacer, 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  scheduleSave();
}

// --- Smart link suggestions: no need to type [[ at all — finishing a word
// run that happens to match an existing note's title pops a small "Lier
// vers « X » ?" chip near the caret, one click away from a real wikilink. ---
const linkSuggestionEl = document.getElementById("link-suggestion-popup");
const linkSuggestionTextEl = linkSuggestionEl.querySelector(".link-suggestion-text");
let linkSuggestionState = null;
let dismissedLinkSuggestionTitle = null;

function hideLinkSuggestion() {
  linkSuggestionEl.classList.add("hidden");
  linkSuggestionState = null;
}

function showLinkSuggestion(node, start, end, note, title) {
  linkSuggestionState = { node, start, end, target: note };
  linkSuggestionTextEl.textContent = `Lier vers « ${title} » ?`;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rect = range.getBoundingClientRect();
  const pageRect = notePage.getBoundingClientRect();
  linkSuggestionEl.style.left = `${rect.left - pageRect.left}px`;
  linkSuggestionEl.style.top = `${rect.bottom - pageRect.top + 4}px`;
  linkSuggestionEl.classList.remove("hidden");
}

textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) {
    hideLinkSuggestion();
    return;
  }
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) {
    hideLinkSuggestion();
    return;
  }
  const offset = sel.getRangeAt(0).startOffset;
  const text = node.textContent.slice(0, offset);
  // The [[ / ![[ typed-link flows already have their own UX — don't pile a
  // second suggestion popup on top while one of those is in progress.
  if (/!?\[\[[^[\]]*$/.test(text)) {
    hideLinkSuggestion();
    return;
  }
  const tail = text.slice(-80);
  let best = null;
  notesInActiveVault().forEach((n) => {
    if (n.deletedAt || n.id === currentNote.id) return;
    const title = (n.title || "").trim();
    if (title.length < 4) return;
    const idx = tail.toLowerCase().lastIndexOf(title.toLowerCase());
    if (idx === -1 || idx + title.length !== tail.length) return;
    const before = tail[idx - 1];
    if (before !== undefined && /[a-z0-9à-ÿ]/i.test(before)) return;
    if (!best || title.length > best.title.length) best = { note: n, title };
  });
  if (!best) {
    hideLinkSuggestion();
    dismissedLinkSuggestionTitle = null;
    return;
  }
  if (dismissedLinkSuggestionTitle === best.title) return;
  showLinkSuggestion(node, offset - best.title.length, offset, best.note, best.title);
});

document.getElementById("link-suggestion-accept").addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (!linkSuggestionState) return;
  const { node, start, end, target } = linkSuggestionState;
  insertWikilinkAt(node, start, end, target);
  hideLinkSuggestion();
});
document.getElementById("link-suggestion-dismiss").addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (linkSuggestionState) dismissedLinkSuggestionTitle = linkSuggestionTextEl.textContent.replace(/^Lier vers « | » \?$/g, "");
  hideLinkSuggestion();
});
textEditor.addEventListener("blur", () => setTimeout(hideLinkSuggestion, 150));

async function chooseWikilinkAutocomplete(index) {
  if (!wikilinkAcRange || !wikilinkAcItems[index]) return;
  const { node, start, end } = wikilinkAcRange;
  const item = wikilinkAcItems[index];
  let target = item.note;
  if (item.create) {
    target = newNoteObject();
    target.title = item.title;
    notes.push(target);
    await persistNote(target);
  }
  closeWikilinkAutocomplete();
  insertWikilinkAt(node, start, end, target);
}

function renderWikilinkAutocomplete(node, start, query) {
  const q = query.trim().toLowerCase();
  const matches = notesInActiveVault()
    .filter((n) => !n.deletedAt && n.id !== currentNote.id)
    .filter((n) => !q || (n.title || "").toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)
    .map((n) => ({ note: n, label: n.title || "Sans titre" }));
  wikilinkAcItems = matches;
  const hasExact = matches.some((m) => (m.note.title || "").toLowerCase() === q);
  if (q && !hasExact) wikilinkAcItems = [...matches, { create: true, title: query.trim(), label: `Créer la note « ${query.trim()} »` }];
  if (!wikilinkAcItems.length) {
    closeWikilinkAutocomplete();
    return;
  }
  wikilinkAcIndex = 0;
  wikilinkAcRange = { node, start, end: start + 2 + query.length };
  wikilinkAutocompleteEl.innerHTML = "";
  wikilinkAcItems.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "wikilink-autocomplete-item" + (item.create ? " create" : "") + (i === 0 ? " active" : "");
    li.setAttribute("role", "option");
    li.textContent = item.label;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseWikilinkAutocomplete(i);
    });
    wikilinkAutocompleteEl.appendChild(li);
  });
  wikilinkAutocompleteEl.classList.remove("hidden");
  const range = document.createRange();
  range.setStart(node, start);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const pageRect = notePage.getBoundingClientRect();
  wikilinkAutocompleteEl.style.left = `${rect.left - pageRect.left}px`;
  wikilinkAutocompleteEl.style.top = `${rect.bottom - pageRect.top + 4}px`;
}

textEditor.addEventListener("input", () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 3) return;
  const offset = sel.getRangeAt(0).startOffset;
  const text = node.textContent.slice(0, offset);

  const closedMatch = text.match(/\[\[([^[\]]+)\]\]$/);
  if (closedMatch && text[text.length - closedMatch[0].length - 1] !== "!") {
    closeWikilinkAutocomplete();
    const query = closedMatch[1].trim().toLowerCase();
    if (!query) return;
    const target =
      notesInActiveVault().find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase() === query) ||
      notesInActiveVault().find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase().includes(query));
    if (!target) return;
    insertWikilinkAt(node, offset - closedMatch[0].length, offset, target);
    return;
  }

  const openMatch = text.match(/(?:^|[^!])\[\[([^[\]]*)$/);
  if (openMatch) {
    const bracketStart = text.lastIndexOf("[[");
    renderWikilinkAutocomplete(node, bracketStart, openMatch[1]);
  } else {
    closeWikilinkAutocomplete();
  }
});

textEditor.addEventListener("keydown", (e) => {
  if (wikilinkAutocompleteEl.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    wikilinkAcIndex = Math.min(wikilinkAcIndex + 1, wikilinkAcItems.length - 1);
    wikilinkAutocompleteEl.querySelectorAll(".wikilink-autocomplete-item").forEach((li, i) => li.classList.toggle("active", i === wikilinkAcIndex));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    wikilinkAcIndex = Math.max(wikilinkAcIndex - 1, 0);
    wikilinkAutocompleteEl.querySelectorAll(".wikilink-autocomplete-item").forEach((li, i) => li.classList.toggle("active", i === wikilinkAcIndex));
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    chooseWikilinkAutocomplete(wikilinkAcIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeWikilinkAutocomplete();
  }
});

textEditor.addEventListener("click", (e) => {
  const link = e.target.closest("a.wikilink");
  if (!link) return;
  e.preventDefault();
  const id = link.dataset.noteId;
  if (notes.some((n) => n.id === id)) goToNote(id);
});

// --- Hover preview: see a linked note's content without leaving the one
// you're reading, mouse only (a touch device has no hover state, so tapping
// still just navigates via the click handler above). ---
const wikilinkHoverPreviewEl = document.getElementById("wikilink-hover-preview");
let wikilinkHoverTimer = null;
let wikilinkHoverHideTimer = null;

function showWikilinkHoverPreview(link) {
  const id = link.dataset.noteId;
  const note = notes.find((n) => n.id === id && !n.deletedAt);
  if (!note) return;
  wikilinkHoverPreviewEl.innerHTML = note.locked
    ? '<p class="split-view-empty">Note verrouillée.</p>'
    : `<p><strong>${escapeHtml(note.title || "Sans titre")}</strong></p>` + (sanitizeNoteHtml(note.html) || '<p class="split-view-empty">Note vide.</p>');
  wikilinkHoverPreviewEl.classList.remove("hidden");
  const linkRect = link.getBoundingClientRect();
  const pageRect = notePage.getBoundingClientRect();
  wikilinkHoverPreviewEl.style.left = `${linkRect.left - pageRect.left}px`;
  wikilinkHoverPreviewEl.style.top = `${linkRect.bottom - pageRect.top + 6}px`;
}

function hideWikilinkHoverPreview() {
  wikilinkHoverPreviewEl.classList.add("hidden");
}

textEditor.addEventListener("mouseover", (e) => {
  const link = e.target.closest("a.wikilink");
  if (!link) return;
  clearTimeout(wikilinkHoverHideTimer);
  clearTimeout(wikilinkHoverTimer);
  wikilinkHoverTimer = setTimeout(() => showWikilinkHoverPreview(link), 350);
});
textEditor.addEventListener("mouseout", (e) => {
  const link = e.target.closest("a.wikilink");
  if (!link) return;
  clearTimeout(wikilinkHoverTimer);
  // A short delay before hiding: lets the pointer travel from the link down
  // into the preview box itself (to scroll it, say) without it vanishing
  // the instant the cursor leaves the link's own bounding box.
  wikilinkHoverHideTimer = setTimeout(hideWikilinkHoverPreview, 250);
});
wikilinkHoverPreviewEl.addEventListener("mouseenter", () => clearTimeout(wikilinkHoverHideTimer));
wikilinkHoverPreviewEl.addEventListener("mouseleave", hideWikilinkHoverPreview);

// --- Transclusion: typing ![[Titre]] embeds a read-only, refreshed-on-open
// snapshot of that note's content right here, instead of just linking to it.
// ![[Titre#N]] embeds only the N-th block (paragraph/titre/item) of that
// note, still refreshed from the live source each time the note is opened. ---
// Top-level nodes of a note's HTML, one per "block". The editor often leaves
// the very first line as a bare text node (no wrapping <div>/<p>) until a
// second line is typed, so plain text nodes count as blocks too.
function getNoteBlockElements(note) {
  const container = document.createElement("div");
  container.innerHTML = sanitizeNoteHtml(note.html) || "";
  return Array.from(container.childNodes).filter(
    (n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()),
  );
}

function blockOuterHtml(node) {
  if (node.nodeType === 1) return node.outerHTML;
  return "<p>" + escapeHtml(node.textContent) + "</p>";
}

function renderTransclusionBlock(el, note, blockIndex) {
  el.innerHTML = "";
  const header = document.createElement("div");
  header.className = "transclusion-header";
  const body = document.createElement("div");
  body.className = "transclusion-body";
  if (note.locked) {
    header.textContent = "↳ Extrait de « " + (note.title || "Sans titre") + " »";
    body.innerHTML = "<p><em>Cette note est verrouillée.</em></p>";
  } else if (blockIndex != null) {
    const blocks = getNoteBlockElements(note);
    const block = blocks[blockIndex];
    header.textContent = "↳ Bloc n°" + (blockIndex + 1) + " de « " + (note.title || "Sans titre") + " »";
    body.innerHTML = block ? blockOuterHtml(block) : "<p><em>Bloc introuvable (la note source a changé).</em></p>";
  } else {
    header.textContent = "↳ Extrait de « " + (note.title || "Sans titre") + " »";
    body.innerHTML = sanitizeNoteHtml(note.html) || "<p><em>Note vide.</em></p>";
  }
  el.appendChild(header);
  el.appendChild(body);
}

function insertTransclusionBlock(target, blockIndex) {
  const div = document.createElement("div");
  div.className = "transclusion";
  div.contentEditable = "false";
  div.dataset.noteId = target.id;
  if (blockIndex != null) div.dataset.blockIndex = String(blockIndex);
  renderTransclusionBlock(div, target, blockIndex);
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
    const blockIndex = el.dataset.blockIndex != null ? Number(el.dataset.blockIndex) : null;
    renderTransclusionBlock(el, source, blockIndex);
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
  const raw = match[1].trim();
  const hashIdx = raw.lastIndexOf("#");
  let queryTitle = raw;
  let blockIndex = null;
  if (hashIdx > 0) {
    const maybeNum = raw.slice(hashIdx + 1).trim();
    if (/^\d+$/.test(maybeNum) && Number(maybeNum) > 0) {
      queryTitle = raw.slice(0, hashIdx).trim();
      blockIndex = Number(maybeNum) - 1;
    }
  }
  const query = queryTitle.toLowerCase();
  if (!query) return;
  const target =
    notesInActiveVault().find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase() === query) ||
    notesInActiveVault().find((n) => !n.deletedAt && n.id !== currentNote.id && (n.title || "").toLowerCase().includes(query));
  if (!target) return;
  const full = match[0];
  const range = document.createRange();
  try {
    range.setStart(node, offset - full.length);
    range.setEnd(node, offset);
    range.deleteContents();
    const block = insertTransclusionBlock(target, blockIndex);
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
  } else if (cmd === "table-header-toggle") {
    toggleTableHeader();
  } else if (cmd === "code-block") {
    insertCodeBlock();
  } else if (cmd === "blockquote") {
    document.execCommand("formatBlock", false, "blockquote");
  } else if (cmd === "callout-info" || cmd === "callout-warning") {
    insertCallout(cmd === "callout-warning" ? "warning" : "info");
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
  indexImageTextForNote(currentNote, dataUrl);
}

imageInput.addEventListener("change", () => {
  if (imageInput.files[0]) insertImageFile(imageInput.files[0]);
  imageInput.value = "";
});

// --- Voice notes (MediaRecorder, 100% local — the audio is stored as a
// data URL right inside the note's html, exactly like a pasted image). ---
const voiceNoteBtn = document.getElementById("voice-note-btn");
let activeRecorder = null;
let audioChunks = [];
let recordingNoteId = null;

function setVoiceBtnRecording(recording) {
  setPressed(voiceNoteBtn, recording);
  const label = recording ? "Arrêter l'enregistrement" : "Enregistrer une note vocale";
  voiceNoteBtn.title = label;
  // The one-time "title -> aria-label" pass at load time froze this to the
  // idle label forever; without updating it here too, a screen reader never
  // announced that recording had actually started.
  voiceNoteBtn.setAttribute("aria-label", label);
}

voiceNoteBtn.addEventListener("click", async () => {
  if (activeRecorder && activeRecorder.state === "recording") {
    activeRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showToast("Enregistrement audio non disponible sur ce navigateur");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recordingNoteId = currentNote ? currentNote.id : null;
    activeRecorder = new MediaRecorder(stream);
    activeRecorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) audioChunks.push(e.data);
    });
    activeRecorder.addEventListener("stop", () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const reader = new FileReader();
      reader.onload = () => {
        setVoiceBtnRecording(false);
        // If the editor was left mid-recording, there's no safe target note
        // to insert into anymore (recordingNoteId no longer matches what's
        // open, or nothing is open at all) — drop it rather than inserting
        // into whatever note happens to be open now.
        if (!editorScreen.classList.contains("active") || !currentNote || currentNote.id !== recordingNoteId) {
          showToast("Enregistrement annulé (note fermée pendant l'enregistrement)");
          return;
        }
        restoreSelection();
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = reader.result;
        const sel = window.getSelection();
        if (sel && sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer)) {
          const range = sel.getRangeAt(0);
          range.collapse(false);
          range.insertNode(audio);
        } else {
          textEditor.appendChild(audio);
        }
        scheduleSave();
      };
      reader.onerror = () => {
        setVoiceBtnRecording(false);
        showToast("Échec de l'enregistrement audio");
      };
      reader.readAsDataURL(blob);
    });
    activeRecorder.start();
    setVoiceBtnRecording(true);
    showToast("Enregistrement en cours… touche à nouveau pour arrêter");
  } catch {
    showToast("Micro indisponible ou accès refusé");
  }
});

// A block copied from a spreadsheet (or any tab/comma-separated text with at
// least 2 consistent columns across 2+ lines) becomes a real table instead
// of landing as plain, unstructured text.
function parseTabularText(text) {
  // Tab is the only delimiter treated as a reliable "this came from a
  // spreadsheet" signal — copying two lines of ordinary prose that each
  // happen to contain one comma (very common in French) would otherwise
  // get hijacked into an unwanted table.
  if (!text.includes("\t")) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const rows = lines.map((l) => l.split("\t").map((cell) => cell.trim()));
  const colCount = rows[0].length;
  if (colCount < 2 || !rows.every((r) => r.length === colCount)) return null;
  return rows;
}

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
  const text = e.clipboardData.getData("text/plain");
  if (!text) return;
  const rows = parseTabularText(text);
  if (!rows) return;
  e.preventDefault();
  const table = document.createElement("table");
  table.className = "note-table";
  rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    cells.forEach((value) => {
      const cell = document.createElement(r === 0 ? "th" : "td");
      cell.contentEditable = "true";
      cell.textContent = value;
      tr.appendChild(cell);
    });
    table.appendChild(tr);
  });
  restoreSelection();
  const sel = window.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0) : document.createRange();
  if (!sel.rangeCount) range.selectNodeContents(textEditor);
  range.collapse(false);
  range.insertNode(table);
  scheduleSave();
  showToast("Tableau créé depuis le presse-papiers");
});

// --- OCR (photo -> texte), chargé à la demande depuis un CDN pour ne pas
// alourdir le chargement initial de l'app avec un moteur de reconnaissance
// de plusieurs Mo. ---
const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const ocrBtn = document.getElementById("ocr-btn");
const ocrInput = document.getElementById("ocr-input");
let tesseractWorkerPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_CDN;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error("Tesseract CDN unreachable"));
    document.head.appendChild(script);
  });
}

function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = loadTesseract().then((Tesseract) => Tesseract.createWorker("fra"));
  }
  return tesseractWorkerPromise;
}

// Runs OCR on every inserted/pasted photo in the background — no toast, no
// visible text added to the note — just folds whatever text it finds into
// note.ocrText so the image becomes findable via the normal search box
// (noteHaystack() includes it). A silent best-effort: offline or a CDN
// hiccup just means that one image stays un-indexed, same as not having
// OCR at all.
async function indexImageTextForNote(note, dataUrl) {
  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(dataUrl);
    const text = (data.text || "").trim();
    if (!text) return;
    const existing = note.ocrText || "";
    if (existing.includes(text)) return;
    note.ocrText = (existing + " " + text).trim();
    persistNote(note);
  } catch {
    /* offline or CDN unreachable — silent, this is a background enhancement */
  }
}

function insertTextAtCursor(text) {
  restoreSelection();
  const sel = window.getSelection();
  if (sel && sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer)) {
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    textEditor.appendChild(document.createTextNode(text));
  }
  scheduleSave();
}

ocrBtn.addEventListener("click", () => {
  ocrInput.click();
});

ocrInput.addEventListener("change", async () => {
  const file = ocrInput.files[0];
  ocrInput.value = "";
  if (!file) return;
  ocrBtn.classList.add("busy-guard");
  showToast("Lecture du texte de la photo…");
  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(file);
    const text = (data.text || "").trim();
    if (!text) {
      showToast("Aucun texte détecté sur cette photo");
    } else {
      insertTextAtCursor(text);
      showToast("Texte extrait et ajouté à la note");
    }
  } catch {
    showToast("OCR indisponible (connexion requise pour charger le moteur)");
  } finally {
    ocrBtn.classList.remove("busy-guard");
  }
});

// --- Scan QR code / code-barres, chargé à la demande depuis un CDN. ---
const JSQR_CDN = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
const scanCodeBtn = document.getElementById("scan-code-btn");
const scanCodeInput = document.getElementById("scan-code-input");
let jsQRPromise = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = JSQR_CDN;
      script.onload = () => resolve(window.jsQR);
      script.onerror = () => reject(new Error("jsQR CDN unreachable"));
      document.head.appendChild(script);
    });
  }
  return jsQRPromise;
}

function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text.trim());
}

scanCodeBtn.addEventListener("click", () => {
  scanCodeInput.click();
});

scanCodeInput.addEventListener("change", async () => {
  const file = scanCodeInput.files[0];
  scanCodeInput.value = "";
  if (!file) return;
  scanCodeBtn.classList.add("busy-guard");
  try {
    const jsQR = await loadJsQR();
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx2d = canvas.getContext("2d");
    ctx2d.drawImage(img, 0, 0);
    const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (!result || !result.data) {
      showToast("Aucun QR code détecté sur cette photo");
    } else {
      const value = result.data;
      insertTextAtCursor(value);
      showToast(looksLikeUrl(value) ? "Lien détecté et ajouté à la note" : "Contenu du code ajouté à la note");
    }
  } catch {
    showToast("Scan indisponible (connexion requise pour charger le moteur)");
  } finally {
    scanCodeBtn.classList.remove("busy-guard");
  }
});

// --- Find & replace ---
const findPanel = document.getElementById("find-panel");
const findInput = document.getElementById("find-input");
const replaceInput = document.getElementById("replace-input");
const findCount = document.getElementById("find-count");
const replaceAllBtn = document.getElementById("replace-all-btn");
const findRegexToggle = document.getElementById("find-regex-toggle");
const findScopeToggle = document.getElementById("find-scope-toggle");
const findScopeListEl = document.getElementById("find-scope-list");

function buildFindRegex(term, useRegex) {
  try {
    return new RegExp(useRegex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return null;
  }
}

function countMatchesInText(text, re) {
  if (!re) return 0;
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function countMatches(term) {
  const re = buildFindRegex(term, findRegexToggle.checked);
  return countMatchesInText(textEditor.textContent, re);
}

// Multi-note scope keeps a checked-in/out selection per note id so the user
// can review which notes actually match before committing a bulk replace,
// rather than the old single-note "Tout remplacer" going in blind.
let findScopeSelection = new Map();

function updateFindCount() {
  const term = findInput.value;
  if (findScopeToggle.checked) {
    renderFindScopeList(term);
    return;
  }
  findScopeListEl.classList.add("hidden");
  if (!term) {
    findCount.textContent = "";
    return;
  }
  const n = countMatches(term);
  findCount.textContent = n ? `${n} résultat${n > 1 ? "s" : ""}` : "Aucun résultat";
}

function renderFindScopeList(term) {
  findScopeListEl.classList.remove("hidden");
  findScopeListEl.innerHTML = "";
  if (!term) {
    findCount.textContent = "";
    return;
  }
  const re = buildFindRegex(term, findRegexToggle.checked);
  if (!re) {
    findCount.textContent = "Regex invalide";
    return;
  }
  const matches = notes
    .filter((n) => !n.deletedAt && !n.locked)
    .map((n) => ({ note: n, count: countMatchesInText(stripHtml(n.html), re) }))
    .filter((m) => m.count > 0);
  findCount.textContent = matches.length
    ? `${matches.length} note${matches.length > 1 ? "s" : ""} concernée${matches.length > 1 ? "s" : ""}`
    : "Aucun résultat";
  matches.forEach(({ note, count }) => {
    if (!findScopeSelection.has(note.id)) findScopeSelection.set(note.id, true);
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = findScopeSelection.get(note.id);
    cb.addEventListener("change", () => findScopeSelection.set(note.id, cb.checked));
    const span = document.createElement("span");
    span.textContent = `${note.title || "Sans titre"} (${count})`;
    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
    findScopeListEl.appendChild(li);
  });
}

findInput.addEventListener("input", updateFindCount);
findRegexToggle.addEventListener("change", updateFindCount);
findScopeToggle.addEventListener("change", updateFindCount);

document.getElementById("find-btn").addEventListener("click", () => {
  findPanel.classList.toggle("hidden");
  if (!findPanel.classList.contains("hidden")) {
    findInput.focus();
    updateFindCount();
  }
});
document.getElementById("find-close-btn").addEventListener("click", () => findPanel.classList.add("hidden"));

// Runs a compiled regex replacement across an arbitrary HTML string's text
// nodes (not the live editor), preserving formatting — used both for the
// current note and for every other note in multi-note scope, since those
// aren't loaded into textEditor.
function replaceInHtml(html, re, replacement) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  let replaced = 0;
  nodes.forEach((n) => {
    re.lastIndex = 0;
    const matches = n.textContent.match(re);
    if (matches) {
      replaced += matches.length;
      n.textContent = n.textContent.replace(re, replacement);
    }
  });
  return { html: container.innerHTML, replaced };
}

replaceAllBtn.addEventListener("click", async () => {
  const term = findInput.value;
  if (!term) return;
  const replacement = replaceInput.value;
  const re = buildFindRegex(term, findRegexToggle.checked);
  if (!re) {
    showToast("Regex invalide");
    return;
  }

  if (findScopeToggle.checked) {
    const targets = notes.filter((n) => !n.deletedAt && !n.locked && findScopeSelection.get(n.id));
    let totalReplaced = 0;
    let notesTouched = 0;
    for (const note of targets) {
      const { html, replaced } = replaceInHtml(note.html, re, replacement);
      if (!replaced) continue;
      if (!note.history) note.history = [];
      note.history.push({ title: note.title, html: stripImagesForHistory(note.html), ts: Date.now() });
      if (note.history.length > 20) {
        const dropIndex = note.history.findIndex((s) => !s.pinned);
        if (dropIndex !== -1) note.history.splice(dropIndex, 1);
      }
      note.html = html;
      note.updatedAt = Date.now();
      await persistNote(note);
      totalReplaced += replaced;
      notesTouched++;
      if (currentNote && currentNote.id === note.id && editorScreen.classList.contains("active")) {
        textEditor.innerHTML = note.html;
        updateWordCount();
      }
    }
    renderList();
    updateFindCount();
    showToast(totalReplaced ? `${totalReplaced} remplacement(s) dans ${notesTouched} note(s)` : "Aucun résultat");
    return;
  }

  // Undoable via the version history panel, since there's no confirmation
  // step before a bulk replace goes through.
  pushHistorySnapshot();
  const { html, replaced } = replaceInHtml(textEditor.innerHTML, re, replacement);
  textEditor.innerHTML = html;
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
  Array.from(table.rows).forEach((row, i) => {
    const isHeaderRow = i === 0 && row.cells[0] && row.cells[0].tagName === "TH";
    if (isHeaderRow) {
      const th = document.createElement("th");
      th.contentEditable = "true";
      th.innerHTML = "<br>";
      row.appendChild(th);
    } else {
      row.appendChild(makeCell());
    }
  });
}

// Converts the first row between <td> (plain cells) and <th> (a real header
// row: distinct style, and clicking a header sorts the table by that
// column) — content of each cell is preserved either way.
function toggleTableHeader() {
  const table = currentTable();
  if (!table || !table.rows.length) return;
  const firstRow = table.rows[0];
  const isHeader = firstRow.cells[0] && firstRow.cells[0].tagName === "TH";
  Array.from(firstRow.cells).forEach((cell) => {
    const replacement = document.createElement(isHeader ? "td" : "th");
    replacement.contentEditable = "true";
    replacement.innerHTML = cell.innerHTML;
    cell.replaceWith(replacement);
  });
  scheduleSave();
  showToast(isHeader ? "Ligne d'en-tête retirée" : "Ligne d'en-tête ajoutée (clique dessus pour trier)");
}

// --- Code blocks (with syntax coloring loaded on demand) and callouts ---
const HLJS_CDN = "https://cdn.jsdelivr.net/npm/highlight.js@11/lib/core.min.js";
const HLJS_LANGS_CDN = "https://cdn.jsdelivr.net/npm/highlight.js@11/lib/languages";
const HLJS_CSS_CDN = "https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css";
const HLJS_LANGUAGES = ["javascript", "python", "css", "xml", "json", "bash", "sql"];
let hljsPromise = null;

function loadHljsCss() {
  if (document.getElementById("hljs-theme-css")) return;
  const link = document.createElement("link");
  link.id = "hljs-theme-css";
  link.rel = "stylesheet";
  link.href = HLJS_CSS_CDN;
  document.head.appendChild(link);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`CDN unreachable: ${src}`));
    document.head.appendChild(script);
  });
}

async function getHljs() {
  if (window.hljs) return window.hljs;
  if (!hljsPromise) {
    hljsPromise = (async () => {
      await loadScript(HLJS_CDN);
      for (const lang of HLJS_LANGUAGES) {
        await loadScript(`${HLJS_LANGS_CDN}/${lang}.min.js`).catch(() => {});
      }
      return window.hljs;
    })();
  }
  return hljsPromise;
}

function insertCodeBlock() {
  const pre = document.createElement("pre");
  pre.className = "note-code";
  const code = document.createElement("code");
  code.contentEditable = "true";
  // An empty contenteditable has no text node to anchor a caret in — Chrome's
  // native typing then lands the very next keystroke as a sibling outside
  // the element instead of inside it (the same issue the checklist items
  // solve with a zero-width space placeholder).
  code.textContent = "​";
  const highlightBtn = document.createElement("button");
  highlightBtn.type = "button";
  highlightBtn.className = "note-code-highlight-btn";
  highlightBtn.contentEditable = "false";
  highlightBtn.textContent = "Colorer";
  pre.appendChild(highlightBtn);
  pre.appendChild(code);
  restoreSelection();
  const sel = window.getSelection();
  const range = sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : (() => {
    const r = document.createRange();
    r.selectNodeContents(textEditor);
    r.collapse(false);
    return r;
  })();
  range.collapse(false);
  range.insertNode(pre);
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  pre.after(p);
  code.focus();
  placeCaretAtEnd(code);
  scheduleSave();
}

async function highlightCodeBlock(codeEl) {
  try {
    const hljs = await getHljs();
    if (!hljs) throw new Error("hljs unavailable");
    loadHljsCss();
    codeEl.removeAttribute("data-highlighted");
    hljs.highlightElement(codeEl);
    codeEl.contentEditable = "false";
    scheduleSave();
  } catch {
    showToast("Coloration syntaxique indisponible (connexion requise pour charger le moteur)");
  }
}

// A small always-visible affordance on hover, rather than a separate
// toolbar mode: click "Colorer" right on the code block that needs it.
textEditor.addEventListener("click", (e) => {
  const btn = e.target.closest(".note-code-highlight-btn");
  if (!btn) return;
  e.preventDefault();
  const code = btn.parentElement.querySelector("code");
  if (code) highlightCodeBlock(code);
});

function insertCallout(type) {
  const div = document.createElement("div");
  div.className = `note-callout note-callout-${type}`;
  div.contentEditable = "true";
  div.textContent = type === "warning" ? "Avertissement…" : "Info…";
  restoreSelection();
  const sel = window.getSelection();
  const range = sel.rangeCount && textEditor.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : (() => {
    const r = document.createRange();
    r.selectNodeContents(textEditor);
    r.collapse(false);
    return r;
  })();
  range.collapse(false);
  range.insertNode(div);
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  div.after(p);
  div.focus();
  const selectRange = document.createRange();
  selectRange.selectNodeContents(div);
  sel.removeAllRanges();
  sel.addRange(selectRange);
  scheduleSave();
}

const tableSortState = new WeakMap(); // table -> { colIndex, dir }

textEditor.addEventListener("click", (e) => {
  const th = e.target.closest("table.note-table th");
  if (!th) return;
  const table = th.closest("table");
  const row = th.parentElement;
  const colIndex = Array.from(row.cells).indexOf(th);
  if (colIndex === -1) return;
  const state = tableSortState.get(table) || {};
  const dir = state.colIndex === colIndex && state.dir === "asc" ? "desc" : "asc";
  tableSortState.set(table, { colIndex, dir });
  const bodyRows = Array.from(table.rows).slice(1);
  bodyRows.sort((a, b) => {
    const av = (a.cells[colIndex] && a.cells[colIndex].textContent.trim()) || "";
    const bv = (b.cells[colIndex] && b.cells[colIndex].textContent.trim()) || "";
    const an = parseFloat(av.replace(",", "."));
    const bn = parseFloat(bv.replace(",", "."));
    const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : av.localeCompare(bv, "fr");
    return dir === "asc" ? cmp : -cmp;
  });
  bodyRows.forEach((row) => table.appendChild(row));
  scheduleSave();
});

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
    const cell = node && node.closest ? node.closest("td, th") : null;
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
    // The "checked" DOM property is not reflected in innerHTML, so without
    // this the check state never survives serialization: it looked saved
    // (the strike-through style did persist) but every box reopened empty.
    e.target.toggleAttribute("checked", e.target.checked);
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
const shapeRecognitionBtn = document.getElementById("shape-recognition-btn");
const drawHint = document.getElementById("draw-hint");

const COLORS = ["#1d1d1f", "#a13d3d", "#a8752c", "#3d6b52", "#3a5a8c", "#6b4a8c"];
const HIGHLIGHT_COLORS = ["#ffe066", "#a0e6a0", "#8fd3ff", "#ffb0d6", "#ffb066"];
let drawColor = COLORS[0];
let drawWidth = 3;
let isErasing = false;
let isHighlighting = false;
let activeStroke = null;

const SHAPE_RECOGNITION_PREF_KEY = "noteflow.shapeRecognition";
let shapeRecognitionEnabled = loadPref(SHAPE_RECOGNITION_PREF_KEY, false);

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
setPressed(shapeRecognitionBtn, shapeRecognitionEnabled);
shapeRecognitionBtn.addEventListener("click", () => {
  shapeRecognitionEnabled = !shapeRecognitionEnabled;
  savePref(SHAPE_RECOGNITION_PREF_KEY, shapeRecognitionEnabled);
  setPressed(shapeRecognitionBtn, shapeRecognitionEnabled);
  showToast(shapeRecognitionEnabled ? "Lissage des formes activé" : "Lissage des formes désactivé");
});

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
  strokes.forEach((stroke) => drawStroke(stroke, rect));
}

// Stroke points are stored as fractions (0-1) of the canvas size at the
// moment they were drawn, not raw pixels: a page is exactly as tall as its
// text content, so its canvas resizes constantly (typing more text, "Agrandir
// la page", rotating a phone, opening the same note on a wider screen). Raw
// pixel points would stay put while the canvas around them changed size,
// visibly drifting away from the text they were meant to mark up.
function toCanvasPixels(point, rect) {
  return { x: point.x * rect.width, y: point.y * rect.height };
}

function drawStroke(stroke, rect) {
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
    const px = toCanvasPixels(p, rect);
    if (i === 0) ctx.moveTo(px.x, px.y);
    else ctx.lineTo(px.x, px.y);
  });
  ctx.stroke();
  ctx.restore();
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
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
  const rect = canvas.getBoundingClientRect();
  const pos = pointerPos(e);
  const prev = activeStroke.points[activeStroke.points.length - 1];
  activeStroke.points.push(pos);
  const prevPx = toCanvasPixels(prev, rect);
  const posPx = toCanvasPixels(pos, rect);
  ctx.save();
  ctx.globalCompositeOperation = activeStroke.erase ? "destination-out" : "source-over";
  ctx.globalAlpha = activeStroke.highlight ? 0.4 : 1;
  ctx.strokeStyle = activeStroke.color;
  ctx.lineWidth = activeStroke.width;
  ctx.lineJoin = "round";
  ctx.lineCap = activeStroke.highlight ? "square" : "round";
  ctx.beginPath();
  ctx.moveTo(prevPx.x, prevPx.y);
  ctx.lineTo(posPx.x, posPx.y);
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

// --- Shape recognition: a hand-drawn stroke that's nearly straight becomes
// a clean line; one that loops back close to where it started and stays
// roughly equidistant from its own centroid becomes a clean ellipse. Only
// runs when the toggle is on and only for plain pen strokes (never
// highlighter, which already gets its own straight-bar treatment, or the
// eraser, which has no shape to speak of). ---
function strokeBoundingBox(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function pointDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function recognizeShape(stroke) {
  const pts = stroke.points;
  if (pts.length < 6) return;
  const box = strokeBoundingBox(pts);
  const diag = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
  if (diag < 0.01) return;
  const start = pts[0];
  const end = pts[pts.length - 1];

  // Straight line: every point stays close to the segment joining the
  // stroke's own start and end.
  const lineLen = pointDist(start, end) || 1e-6;
  const dx = (end.x - start.x) / lineLen;
  const dy = (end.y - start.y) / lineLen;
  let maxDeviation = 0;
  pts.forEach((p) => {
    const t = (p.x - start.x) * dx + (p.y - start.y) * dy;
    const projX = start.x + t * dx;
    const projY = start.y + t * dy;
    maxDeviation = Math.max(maxDeviation, pointDist(p, { x: projX, y: projY }));
  });
  if (maxDeviation < diag * 0.045) {
    stroke.points = [start, end];
    return;
  }

  // Closed loop close to circular/elliptical: the path ends near where it
  // started, and every point sits at roughly the same distance from the
  // stroke's centroid.
  if (pointDist(start, end) > diag * 0.3) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const radii = pts.map((p) => pointDist(p, { x: cx, y: cy }));
  const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
  if (meanR < 1e-6) return;
  const variance = radii.reduce((s, r) => s + (r - meanR) ** 2, 0) / radii.length;
  const relSpread = Math.sqrt(variance) / meanR;
  if (relSpread > 0.28) return;
  const rx = (box.maxX - box.minX) / 2;
  const ry = (box.maxY - box.minY) / 2;
  const ellipse = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ellipse.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  stroke.points = ellipse;
}

function endStroke() {
  if (!activeStroke) return;
  const stroke = activeStroke;
  activeStroke = null;
  if (stroke.highlight) {
    snapHighlightStroke(stroke);
    redrawStrokes();
  } else if (shapeRecognitionEnabled && !stroke.erase) {
    recognizeShape(stroke);
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

// --- Local automatic backup (File System Access API, Chromium desktop only)
// A directory handle can be structured-cloned into IndexedDB and survives
// across sessions (with the browser re-prompting for permission on first
// use each session, per the API's security model) — kept in its own tiny
// database rather than bumping the main notes DB's schema version. ---
const BACKUP_DB_NAME = "noteflow-backup";
const BACKUP_STORE = "handles";
const BACKUP_KEY = "backupDir";
let backupDbPromise = null;
function openBackupDB() {
  if (!backupDbPromise) {
    backupDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(BACKUP_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(BACKUP_STORE)) req.result.createObjectStore(BACKUP_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return backupDbPromise;
}
async function saveBackupHandle(handle) {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readwrite");
    tx.objectStore(BACKUP_STORE).put(handle, BACKUP_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function loadBackupHandle() {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readonly");
    const req = tx.objectStore(BACKUP_STORE).get(BACKUP_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function clearBackupHandle() {
  const db = await openBackupDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readwrite");
    tx.objectStore(BACKUP_STORE).delete(BACKUP_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

const localBackupToggle = document.getElementById("local-backup-toggle");
const localBackupPanel = document.getElementById("local-backup-panel");
const localBackupStatusEl = document.getElementById("local-backup-status");
const localBackupChooseBtn = document.getElementById("local-backup-choose-btn");
const localBackupNowBtn = document.getElementById("local-backup-now-btn");
const localBackupDisableBtn = document.getElementById("local-backup-disable-btn");
let backupDirHandle = null;

function setLocalBackupStatus(text) {
  localBackupStatusEl.textContent = text;
}

localBackupToggle.addEventListener("click", () => localBackupPanel.classList.toggle("hidden"));

// Merges an array of notes (from a JSON.parse of some external source — a
// sync file, a WebDAV snapshot) into the in-memory `notes`, same
// last-write-wins-by-updatedAt rule as manual JSON import. Returns counts so
// callers can report something meaningful instead of a generic "done".
async function mergeExternalNotes(imported) {
  let added = 0;
  let updated = 0;
  for (const note of imported) {
    if (!note || !note.id) continue;
    if (note.html) note.html = sanitizeNoteHtml(note.html);
    const index = notes.findIndex((n) => n.id === note.id);
    if (index === -1) {
      notes.push(note);
      added++;
    } else if ((note.updatedAt || 0) > (notes[index].updatedAt || 0)) {
      notes[index] = note;
      updated++;
    }
    if (added || updated) await dbPut(note);
  }
  if (added || updated) renderList();
  return { added, updated };
}

// The same folder written by another device (an iCloud Drive / Google Drive
// desktop-synced folder, picked on both machines) turns this from a one-way
// backup into real two-way sync: read whatever the other device last wrote
// to the stable sync file, merge it in, then write the merged state back —
// both a timestamped backup (history) and the live sync file (merge target).
const LOCAL_SYNC_FILENAME = "noteflow-sync.json";

async function runLocalBackup(silent) {
  if (!backupDirHandle) return;
  try {
    const perm = await backupDirHandle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      setLocalBackupStatus("🔴 Permission refusée pour ce dossier");
      return;
    }
    let mergeResult = { added: 0, updated: 0 };
    try {
      const existingHandle = await backupDirHandle.getFileHandle(LOCAL_SYNC_FILENAME);
      const file = await existingHandle.getFile();
      const imported = JSON.parse(await file.text());
      if (Array.isArray(imported)) mergeResult = await mergeExternalNotes(imported);
    } catch {
      /* no sync file yet on this folder, or it couldn't be read — fine, this write creates it */
    }

    const syncHandle = await backupDirHandle.getFileHandle(LOCAL_SYNC_FILENAME, { create: true });
    const syncWritable = await syncHandle.createWritable();
    await syncWritable.write(JSON.stringify(notes, null, 2));
    await syncWritable.close();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileHandle = await backupDirHandle.getFileHandle(`noteflow-backup-${stamp}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(notes, null, 2));
    await writable.close();

    setLocalBackupStatus(`🟢 Synchronisé : ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`);
    if (!silent) {
      const mergeText = mergeResult.added || mergeResult.updated ? ` (${mergeResult.added} ajoutée(s), ${mergeResult.updated} mise(s) à jour depuis le dossier)` : "";
      showToast("Sauvegarde et synchronisation locale effectuées" + mergeText);
    }
  } catch (err) {
    setLocalBackupStatus("🔴 Échec de la sauvegarde : " + err.message);
  }
}

localBackupChooseBtn.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    showToast("Non disponible sur ce navigateur (Chrome/Edge sur ordinateur uniquement)");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    backupDirHandle = handle;
    await saveBackupHandle(handle);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    setLocalBackupStatus(`🟢 Dossier « ${handle.name} » configuré`);
    await runLocalBackup(true);
  } catch {
    /* user cancelled the picker */
  }
});

localBackupNowBtn.addEventListener("click", () => runLocalBackup(false));

localBackupDisableBtn.addEventListener("click", async () => {
  backupDirHandle = null;
  await clearBackupHandle();
  setLocalBackupStatus("Sauvegarde automatique locale non configurée");
  showToast("Sauvegarde locale désactivée");
});

(async () => {
  try {
    const handle = await loadBackupHandle();
    if (handle) {
      backupDirHandle = handle;
      setLocalBackupStatus(`🟡 Dossier « ${handle.name} » enregistré (autorisation à reconfirmer)`);
    }
  } catch {
    /* no stored handle yet, or File System Access unsupported */
  }
})();

// Every 30 minutes while the app stays open — there is no way to run this
// while genuinely closed without a native background service, which would
// mean a server component this app deliberately doesn't have.
setInterval(() => runLocalBackup(true), 30 * 60 * 1000);

// --- WebDAV sync: an alternative to configuring a Firebase project, for
// anyone who already has a WebDAV server (Nextcloud, ownCloud, most self-
// hosted or classic cloud-storage setups expose one). A single JSON
// snapshot file, fetched with GET/merged locally/pushed back with PUT —
// simpler than Firebase's per-note documents + live listener, since plain
// HTTP has no equivalent of Firestore's realtime subscription. ---
const WEBDAV_KEYS = { url: "noteflow.webdav.url", user: "noteflow.webdav.user" };
const webdavToggle = document.getElementById("webdav-toggle");
const webdavPanel = document.getElementById("webdav-panel");
const webdavStatusEl = document.getElementById("webdav-status");
const webdavUrlInput = document.getElementById("webdav-url-input");
const webdavUserInput = document.getElementById("webdav-user-input");
const webdavPassInput = document.getElementById("webdav-pass-input");
const webdavSaveBtn = document.getElementById("webdav-save-btn");
const webdavSyncNowBtn = document.getElementById("webdav-sync-now-btn");
const webdavDisableBtn = document.getElementById("webdav-disable-btn");

let webdavConfig = null; // { url, user, pass } — pass kept in memory only, never persisted
let webdavInterval = null;

function setWebdavStatus(text) {
  webdavStatusEl.textContent = text;
}

webdavToggle.addEventListener("click", () => webdavPanel.classList.toggle("hidden"));

async function runWebdavSync(silent) {
  if (!webdavConfig) return;
  try {
    setWebdavStatus("Synchronisation…");
    const authHeader = "Basic " + btoa(`${webdavConfig.user}:${webdavConfig.pass}`);
    let mergeResult = { added: 0, updated: 0 };
    const getResp = await fetch(webdavConfig.url, { method: "GET", headers: { Authorization: authHeader } });
    if (getResp.ok) {
      const remoteNotes = await getResp.json();
      if (Array.isArray(remoteNotes)) mergeResult = await mergeExternalNotes(remoteNotes);
    } else if (getResp.status !== 404) {
      throw new Error(`GET ${getResp.status}`);
    }
    const putResp = await fetch(webdavConfig.url, {
      method: "PUT",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(notes),
    });
    if (!putResp.ok) throw new Error(`PUT ${putResp.status}`);
    setWebdavStatus(`🟢 Synchronisé : ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`);
    if (!silent) {
      const mergeText = mergeResult.added || mergeResult.updated ? ` (${mergeResult.added} ajoutée(s), ${mergeResult.updated} mise(s) à jour)` : "";
      showToast("Synchronisation WebDAV effectuée" + mergeText);
    }
  } catch (err) {
    setWebdavStatus("🔴 Échec de la synchronisation : " + err.message + " (vérifie l'URL, les identifiants, et que le serveur autorise CORS)");
  }
}

webdavSaveBtn.addEventListener("click", async () => {
  const url = webdavUrlInput.value.trim();
  const user = webdavUserInput.value.trim();
  const pass = webdavPassInput.value;
  if (!url || !user || !pass) {
    setWebdavStatus("🔴 URL, identifiant et mot de passe sont requis");
    return;
  }
  webdavConfig = { url, user, pass };
  savePref(WEBDAV_KEYS.url, url);
  savePref(WEBDAV_KEYS.user, user);
  webdavPassInput.value = "";
  if (webdavInterval) clearInterval(webdavInterval);
  webdavInterval = setInterval(() => runWebdavSync(true), 5 * 60 * 1000);
  await runWebdavSync(false);
});

webdavSyncNowBtn.addEventListener("click", () => runWebdavSync(false));

webdavDisableBtn.addEventListener("click", () => {
  localStorage.removeItem(WEBDAV_KEYS.url);
  localStorage.removeItem(WEBDAV_KEYS.user);
  webdavConfig = null;
  if (webdavInterval) {
    clearInterval(webdavInterval);
    webdavInterval = null;
  }
  setWebdavStatus("Synchronisation WebDAV non configurée");
  showToast("Synchronisation WebDAV désactivée");
});

(() => {
  const url = loadPref(WEBDAV_KEYS.url, null);
  const user = loadPref(WEBDAV_KEYS.user, null);
  if (url && user) {
    webdavUrlInput.value = url;
    webdavUserInput.value = user;
    webdavPanel.classList.remove("hidden");
    setWebdavStatus("🟡 Synchronisation WebDAV configurée : entre le mot de passe et clique « Activer » pour reprendre");
  }
})();

// --- Journal: a dated note per day, in a "Journal" folder, matched by
// journalDate (not by title, so renaming a day's entry doesn't orphan it)
// with a mini calendar to jump to any date and see which days have one. ---
async function openOrCreateJournalNote(dateStr) {
  let note = notesInActiveVault().find((n) => !n.deletedAt && n.journalDate === dateStr);
  if (!note) {
    note = newNoteObject();
    note.journalDate = dateStr;
    note.folder = "Journal";
    note.title = new Date(dateStr + "T00:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    notes.unshift(note);
    await persistNote(note);
  }
  showList();
  openNote(note.id);
}

document.getElementById("journal-today-btn").addEventListener("click", () => {
  openOrCreateJournalNote(dateKey(Date.now()));
});

const journalCalOverlay = document.getElementById("journal-calendar-overlay");
const journalCalMonthLabel = document.getElementById("journal-cal-month-label");
const journalCalGrid = document.getElementById("journal-cal-grid");
let journalCalViewDate = new Date();

function renderJournalCalendar() {
  const year = journalCalViewDate.getFullYear();
  const month = journalCalViewDate.getMonth();
  journalCalMonthLabel.textContent = journalCalViewDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const entryDates = new Set(notesInActiveVault().filter((n) => !n.deletedAt && n.journalDate).map((n) => n.journalDate));
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = (firstOfMonth.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(Date.now());

  journalCalGrid.innerHTML = "";
  ["L", "M", "M", "J", "V", "S", "D"].forEach((d) => {
    const span = document.createElement("span");
    span.className = "journal-cal-weekday";
    span.textContent = d;
    journalCalGrid.appendChild(span);
  });
  for (let i = 0; i < startWeekday; i++) journalCalGrid.appendChild(document.createElement("span"));
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const key = dateKey(d.getTime());
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "journal-cal-day" + (entryDates.has(key) ? " has-entry" : "") + (key === todayKey ? " today" : "");
    btn.textContent = String(day);
    btn.addEventListener("click", () => {
      journalCalOverlay.classList.add("hidden");
      openOrCreateJournalNote(key);
    });
    journalCalGrid.appendChild(btn);
  }
}

document.getElementById("journal-calendar-btn").addEventListener("click", () => {
  journalCalViewDate = new Date();
  journalCalOverlay.classList.remove("hidden");
  renderJournalCalendar();
});
document.getElementById("journal-cal-prev").addEventListener("click", () => {
  journalCalViewDate.setMonth(journalCalViewDate.getMonth() - 1);
  renderJournalCalendar();
});
document.getElementById("journal-cal-next").addEventListener("click", () => {
  journalCalViewDate.setMonth(journalCalViewDate.getMonth() + 1);
  renderJournalCalendar();
});
journalCalOverlay.addEventListener("click", (e) => {
  if (e.target === journalCalOverlay) journalCalOverlay.classList.add("hidden");
});

// --- Cloud sync (Firebase, optional) ---
// End-to-end encrypted: every note is encrypted on this device, with a key
// derived from a passphrase that is NEVER sent to Firebase, before it ever
// leaves for the sync collection. Firebase (and anyone with read access to
// the project) only ever sees ciphertext + an id + a timestamp — it cannot
// read note content, not even us.
const SYNC_KEYS = { config: "noteflow.sync.config", code: "noteflow.sync.code", e2eeSalt: "noteflow.sync.e2eeSalt" };
const syncToggle = document.getElementById("sync-toggle");
const syncPanel = document.getElementById("sync-panel");
const syncStatusEl = document.getElementById("sync-status");
const syncConfigInput = document.getElementById("sync-config-input");
const syncCodeInput = document.getElementById("sync-code-input");
const syncPassphraseInput = document.getElementById("sync-passphrase-input");
const syncSaveBtn = document.getElementById("sync-save-btn");
const syncDisableBtn = document.getElementById("sync-disable-btn");

let syncDb = null;
let syncCode = "";
let syncFns = null;
let unsubscribeSnapshot = null;
// The derived AES-GCM key lives only in memory, for this session — the
// passphrase itself is never persisted anywhere, so it has to be re-entered
// once per browser session (a deliberate trade-off: convenience vs. genuine
// end-to-end confidentiality).
let syncEncryptionKey = null;

async function encryptNoteForSync(note) {
  const plaintext = JSON.stringify(note);
  const blob = await encryptString(syncEncryptionKey, plaintext);
  return { id: note.id, updatedAt: note.updatedAt, deletedMarker: false, e2ee: true, blob };
}

async function decryptNoteFromSync(remote) {
  const plaintext = await decryptString(syncEncryptionKey, remote.blob);
  return JSON.parse(plaintext);
}
// A Set of note ids, not a single flag: a global boolean meant that any
// local edit autosaved during the awaits inside handleRemoteSnapshot (typing
// in an unrelated note while a snapshot for a different note was still
// being applied) got written to IndexedDB but silently skipped its
// Firestore push — the edit only existed locally until the next remote
// snapshot overwrote it. Scoping the guard to the specific id being applied
// fixes that without losing the original protection (don't echo a remote
// change straight back to Firestore).
let applyingRemoteChangeIds = new Set();

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

async function startSync(config, code, passphrase) {
  try {
    setSyncStatus("Connexion…");
    let saltB64 = loadPref(SYNC_KEYS.e2eeSalt, null);
    let saltBytes;
    if (saltB64) {
      saltBytes = b64ToBytes(saltB64);
    } else {
      saltBytes = crypto.getRandomValues(new Uint8Array(16));
      savePref(SYNC_KEYS.e2eeSalt, bytesToB64(saltBytes));
    }
    syncEncryptionKey = await deriveKey(passphrase, saltBytes);

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
    setSyncStatus("🟢 Synchronisation active (chiffrée de bout en bout)");
  } catch (err) {
    setSyncStatus("🔴 Erreur : " + err.message);
  }
}

async function handleRemoteSnapshot(snapshot) {
  if (!syncEncryptionKey) {
    setSyncStatus("🟡 Synchronisation chiffrée : entre ta phrase secrète pour déchiffrer");
    return;
  }
  for (const change of snapshot.docChanges()) {
    const encryptedRemote = change.doc.data();
    applyingRemoteChangeIds.add(encryptedRemote.id);
    const localIndex = notes.findIndex((n) => n.id === encryptedRemote.id);
    if (change.type === "removed") {
      if (localIndex !== -1) {
        notes.splice(localIndex, 1);
        await dbDelete(encryptedRemote.id);
      }
    } else if (localIndex === -1 || encryptedRemote.updatedAt > notes[localIndex].updatedAt) {
      // Never apply a remote snapshot over a note with an unsaved edit still
      // pending (autosave debounce in flight): replacing textEditor.innerHTML
      // mid-keystroke jumps the caret to the start and can drop the current
      // paragraph, and swapping the `notes[localIndex]` object reference out
      // from under `currentNote` would desync the two silently. Skipping
      // here is safe — the pending flush stamps its own updatedAt = now, so
      // it will win the comparison above on the *next* remote snapshot and
      // push the local edit back out once the user is done typing.
      if (currentNote && currentNote.id === encryptedRemote.id && editorScreen.classList.contains("active") && saveTimer) {
        applyingRemoteChangeIds.delete(encryptedRemote.id);
        continue;
      }
      let remote;
      try {
        remote = encryptedRemote.e2ee ? await decryptNoteFromSync(encryptedRemote) : encryptedRemote;
      } catch {
        // Wrong passphrase (or a device that used a different one) produces
        // undecryptable ciphertext — skip rather than crash the whole sync
        // listener on one bad document.
        applyingRemoteChangeIds.delete(encryptedRemote.id);
        continue;
      }
      if (remote.html) remote.html = sanitizeNoteHtml(remote.html);
      const local = localIndex !== -1 ? notes[localIndex] : null;
      // A real conflict — not just "the remote is newer" (that's the normal
      // case and needs no prompt) — is when THIS device also changed the
      // note since the last time it successfully synced, and the two
      // versions actually differ in content. Silently taking whichever
      // arrived with the later timestamp would drop one edit for good.
      const hasUnsyncedLocalChanges = local && local.lastSyncedAt && local.updatedAt > local.lastSyncedAt;
      const contentDiffers = local && (remote.html !== local.html || remote.title !== local.title);
      if (hasUnsyncedLocalChanges && contentDiffers) {
        queueSyncConflict(local, remote);
        applyingRemoteChangeIds.delete(encryptedRemote.id);
        continue;
      }
      remote.lastSyncedAt = remote.updatedAt;
      if (localIndex === -1) notes.unshift(remote);
      else notes[localIndex] = remote;
      await dbPut(remote);
      if (currentNote && currentNote.id === remote.id && editorScreen.classList.contains("active")) {
        currentNote = remote;
        loadNoteIntoEditor();
      }
    }
    applyingRemoteChangeIds.delete(encryptedRemote.id);
  }
  if (listScreen.classList.contains("active")) renderList();
  setSyncStatus("🟢 Synchronisation active (chiffrée de bout en bout)");
}

// --- Visual conflict resolution: instead of last-write-wins silently
// dropping whichever edit lost the timestamp race, a genuine divergence
// (this device changed the note since its last sync, AND the incoming
// remote version has different content) is queued and surfaced with a diff,
// same word-level algorithm as the version history panel. ---
let pendingConflicts = [];
const conflictBtn = document.getElementById("conflict-btn");
const conflictPanel = document.getElementById("conflict-panel");
const conflictListEl = document.getElementById("conflict-list");
conflictBtn.addEventListener("click", () => {
  showList();
  const opening = conflictPanel.classList.contains("hidden");
  conflictPanel.classList.toggle("hidden");
  if (opening) renderConflictPanel();
});

function queueSyncConflict(local, remote) {
  if (pendingConflicts.some((c) => c.remote.id === remote.id)) return;
  pendingConflicts.push({ local: { ...local }, remote });
  updateConflictBadge();
  showToast(`Conflit détecté sur « ${local.title || "Sans titre"} » — modifiée sur deux appareils à la fois`, () => conflictBtn.click(), {
    actionLabel: "Résoudre",
    ctrlZ: false,
  });
}

function updateConflictBadge() {
  conflictBtn.classList.toggle("hidden", pendingConflicts.length === 0);
  conflictBtn.textContent = `⚠ Conflits (${pendingConflicts.length})`;
}

async function resolveConflict(index, resolution) {
  const conflict = pendingConflicts[index];
  if (!conflict) return;
  const { local, remote } = conflict;
  if (resolution === "local") {
    // Re-push the local version with a fresher timestamp so it wins on the
    // next round-trip instead of the remote version silently reappearing.
    local.updatedAt = Date.now();
    local.lastSyncedAt = local.updatedAt;
    const idx = notes.findIndex((n) => n.id === local.id);
    if (idx !== -1) notes[idx] = local;
    await persistNote(local);
  } else if (resolution === "remote") {
    remote.lastSyncedAt = remote.updatedAt;
    const idx = notes.findIndex((n) => n.id === remote.id);
    if (idx !== -1) notes[idx] = remote;
    else notes.unshift(remote);
    await dbPut(remote);
  } else if (resolution === "both") {
    remote.lastSyncedAt = remote.updatedAt;
    const idx = notes.findIndex((n) => n.id === remote.id);
    if (idx !== -1) notes[idx] = remote;
    else notes.unshift(remote);
    await dbPut(remote);
    const duplicate = { ...local, id: crypto.randomUUID(), title: `${local.title || "Sans titre"} (version en conflit)`, updatedAt: Date.now() };
    duplicate.lastSyncedAt = null;
    notes.unshift(duplicate);
    await persistNote(duplicate);
  }
  pendingConflicts.splice(index, 1);
  updateConflictBadge();
  renderConflictPanel();
  renderList();
  if (currentNote && (currentNote.id === local.id || currentNote.id === remote.id) && editorScreen.classList.contains("active")) {
    const stillThere = notes.find((n) => n.id === currentNote.id);
    if (stillThere) {
      currentNote = stillThere;
      loadNoteIntoEditor();
    }
  }
}

function renderConflictPanel() {
  conflictListEl.innerHTML = "";
  if (!pendingConflicts.length) {
    conflictListEl.innerHTML = '<li class="history-empty">Aucun conflit en attente.</li>';
    return;
  }
  pendingConflicts.forEach((conflict, index) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const title = document.createElement("p");
    title.style.fontWeight = "700";
    title.textContent = conflict.local.title || conflict.remote.title || "Sans titre";
    const diffBox = document.createElement("div");
    diffBox.className = "history-diff";
    const parts = diffWords(stripHtml(conflict.local.html), stripHtml(conflict.remote.html));
    if (parts) {
      parts.forEach((p) => {
        if (p.type === "same") diffBox.appendChild(document.createTextNode(p.text));
        else {
          const mark = document.createElement(p.type === "del" ? "del" : "ins");
          mark.textContent = p.text;
          mark.title = p.type === "del" ? "Seulement dans la version d'ici" : "Seulement dans la version distante";
          diffBox.appendChild(mark);
        }
      });
    } else {
      diffBox.textContent = "Notes trop volumineuses pour un aperçu détaillé.";
    }
    const actions = document.createElement("div");
    actions.className = "sync-actions";
    const keepLocal = document.createElement("button");
    keepLocal.type = "button";
    keepLocal.textContent = "Garder la mienne";
    keepLocal.addEventListener("click", () => resolveConflict(index, "local"));
    const keepRemote = document.createElement("button");
    keepRemote.type = "button";
    keepRemote.textContent = "Garder celle de l'autre appareil";
    keepRemote.addEventListener("click", () => resolveConflict(index, "remote"));
    const keepBoth = document.createElement("button");
    keepBoth.type = "button";
    keepBoth.className = "link-btn";
    keepBoth.textContent = "Garder les deux";
    keepBoth.addEventListener("click", () => resolveConflict(index, "both"));
    actions.appendChild(keepLocal);
    actions.appendChild(keepRemote);
    actions.appendChild(keepBoth);
    li.appendChild(title);
    li.appendChild(diffBox);
    li.appendChild(actions);
    conflictListEl.appendChild(li);
  });
}

async function persistNote(note) {
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
  try {
    await dbPut(note);
    if (syncDb && syncCode && syncEncryptionKey && !applyingRemoteChangeIds.has(note.id)) {
      try {
        const payload = await encryptNoteForSync(note);
        await syncFns.setDoc(syncFns.doc(syncDb, "syncs", syncCode, "notes", note.id), payload);
        // Marks this exact version as the last one known to have reached
        // the sync backend — the conflict check compares against this, not
        // against updatedAt alone, to tell "genuinely diverged" apart from
        // "just hasn't synced yet".
        note.lastSyncedAt = note.updatedAt;
      } catch (err) {
        console.warn("sync push failed", err);
      }
    }
  } finally {
    // In a finally, not just after: if dbPut() threw (quota exceeded, say),
    // the in-memory note was left with html/drawing/history wiped out by the
    // encrypt-for-write swap above, with no write having actually succeeded
    // to justify that — flushSave's own catch block would report "Erreur"
    // while the open note silently looked empty.
    if (restore) {
      note.html = restore.html;
      note.drawing = restore.drawing;
      note.history = restore.history;
    }
  }
}

async function removeNoteEverywhere(id) {
  previewCache.delete(id);
  checklistProgressCache.delete(id);
  await dbDelete(id);
  if (syncDb && syncCode && !applyingRemoteChangeIds.has(id)) {
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
  const passphrase = syncPassphraseInput.value;
  if (!passphrase) {
    setSyncStatus("🔴 La phrase secrète de chiffrement est requise");
    return;
  }
  savePref(SYNC_KEYS.config, config);
  savePref(SYNC_KEYS.code, code);
  syncPassphraseInput.value = "";
  await startSync(config, code, passphrase);
});

syncDisableBtn.addEventListener("click", () => {
  localStorage.removeItem(SYNC_KEYS.config);
  localStorage.removeItem(SYNC_KEYS.code);
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  // Leaving these set meant a second "Activer" click after disabling could
  // call an already-unsubscribed listener, or briefly get treated as still
  // mid-remote-application.
  unsubscribeSnapshot = null;
  syncFns = null;
  syncEncryptionKey = null;
  applyingRemoteChangeIds.clear();
  syncDb = null;
  syncCode = "";
  setSyncStatus("Synchronisation non configurée");
});

// The passphrase is never persisted, so a fresh page load can restore the
// Firebase config/code automatically but can't restore the encryption key —
// the user has to re-enter it once per session before sync actually
// resumes exchanging data (the alternative, storing the key or passphrase
// on disk, would defeat the point of end-to-end encryption).
async function initSyncFromStorage() {
  const config = loadPref(SYNC_KEYS.config, null);
  const code = loadPref(SYNC_KEYS.code, "");
  if (config && code) {
    syncConfigInput.value = JSON.stringify(config, null, 2);
    syncCodeInput.value = code;
    syncPanel.classList.remove("hidden");
    setSyncStatus("🟡 Synchronisation configurée : entre ta phrase secrète et clique « Activer » pour reprendre");
  }
}

// --- Keyboard shortcuts (customizable) ---
// Only the global Ctrl/Cmd+<letter> shortcuts are remappable — context-only
// ones (drawing undo/redo, table navigation) stay fixed, since making those
// safely reassignable would mean plumbing the bindings through several
// unrelated subsystems for comparatively little benefit.
const SHORTCUT_DEFS = [
  { id: "command-palette", label: "Palette de commandes", defaultKey: "k" },
  { id: "new-note", label: "Nouvelle note (liste)", defaultKey: "n" },
  { id: "search", label: "Rechercher", defaultKey: "f" },
  { id: "save", label: "Sauvegarder (éditeur)", defaultKey: "s" },
];
const SHORTCUTS_PREF_KEY = "noteflow.shortcuts";

function loadShortcutBindings() {
  const overrides = loadPref(SHORTCUTS_PREF_KEY, {});
  const bindings = {};
  SHORTCUT_DEFS.forEach((d) => (bindings[d.id] = overrides[d.id] || d.defaultKey));
  return bindings;
}

function saveShortcutBinding(id, key) {
  const overrides = loadPref(SHORTCUTS_PREF_KEY, {});
  overrides[id] = key;
  savePref(SHORTCUTS_PREF_KEY, overrides);
}

// --- Keyboard shortcut settings panel ---
const shortcutsBtn = document.getElementById("shortcuts-btn");
const shortcutsPanel = document.getElementById("shortcuts-panel");
const shortcutsListEl = document.getElementById("shortcuts-list");
const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.toLowerCase().includes("mac");
const MOD_LABEL = isMac ? "⌘" : "Ctrl";

function renderShortcutsPanel() {
  const bindings = loadShortcutBindings();
  shortcutsListEl.innerHTML = "";
  SHORTCUT_DEFS.forEach((def) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("span");
    label.textContent = def.label;
    const keyBadge = document.createElement("kbd");
    keyBadge.className = "shortcut-key";
    keyBadge.textContent = `${MOD_LABEL}+${bindings[def.id].toUpperCase()}`;
    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "link-btn";
    changeBtn.textContent = "Changer";
    changeBtn.addEventListener("click", () => {
      changeBtn.textContent = "Appuie sur une touche…";
      const captureKey = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const newKey = ev.key.toLowerCase();
        if (newKey.length !== 1 || !/[a-z0-9]/.test(newKey)) {
          changeBtn.textContent = "Touche invalide, réessaie";
          return;
        }
        const conflict = SHORTCUT_DEFS.find((d) => d.id !== def.id && loadShortcutBindings()[d.id] === newKey);
        if (conflict) {
          changeBtn.textContent = `Déjà utilisé par « ${conflict.label} »`;
          return;
        }
        saveShortcutBinding(def.id, newKey);
        document.removeEventListener("keydown", captureKey, true);
        renderShortcutsPanel();
      };
      document.addEventListener("keydown", captureKey, true);
    });
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    wrap.appendChild(keyBadge);
    wrap.appendChild(changeBtn);
    li.appendChild(label);
    li.appendChild(wrap);
    shortcutsListEl.appendChild(li);
  });
  const resetLi = document.createElement("li");
  resetLi.className = "history-item";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "link-btn";
  resetBtn.textContent = "Réinitialiser tous les raccourcis";
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(SHORTCUTS_PREF_KEY);
    renderShortcutsPanel();
    showToast("Raccourcis réinitialisés");
  });
  resetLi.appendChild(resetBtn);
  shortcutsListEl.appendChild(resetLi);
}

shortcutsBtn.addEventListener("click", () => {
  const opening = shortcutsPanel.classList.contains("hidden");
  shortcutsPanel.classList.toggle("hidden");
  if (opening) renderShortcutsPanel();
});

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
    [reminderPanel, historyPanel, backlinksPanel, outlinePanel, ephemeralPanel, colorPanel, paperPanel, findPanel].forEach((p) => p.classList.add("hidden"));
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  const bindings = loadShortcutBindings();

  if (key === bindings["command-palette"]) {
    e.preventDefault();
    if (cmdkOverlay.classList.contains("hidden")) openCommandPalette();
    else closeCommandPalette();
    return;
  }

  // Undo (Ctrl/Cmd+Z): an active "undo this action" toast (delete, archive,
  // clear drawing…) always takes priority, on either screen. Fixed, not
  // remappable — "Z" for undo is universal enough it's not worth the
  // confusion of letting it be reassigned.
  if (key === "z" && !e.shiftKey && triggerToastUndo()) {
    e.preventDefault();
    return;
  }

  if (listScreen.classList.contains("active")) {
    if (key === bindings["new-note"]) {
      e.preventDefault();
      newNoteBtn.click();
    } else if (key === bindings["search"]) {
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

  if (key === bindings["save"]) {
    e.preventDefault();
    flushSave(false);
  } else if (key === bindings["search"]) {
    // Otherwise ⌘F only ever opened the browser's own find bar in the
    // editor, even though a real find/replace panel exists right there —
    // inconsistent with the list screen, where ⌘F already focuses search.
    e.preventDefault();
    findPanel.classList.remove("hidden");
    findInput.focus();
    updateFindCount();
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
  restoreModalFocus();
}

function openCommandPalette() {
  modalReturnFocusEl = document.activeElement;
  cmdkOverlay.classList.remove("hidden");
  cmdkInput.value = "";
  renderCmdkResults("");
  setTimeout(() => cmdkInput.focus(), 30);
}

// --- Modal focus trap: while the command palette or the lock overlay is
// open, Tab/Shift+Tab stay inside it instead of leaking into the screen
// underneath (which the user believes is inaccessible — most concretely,
// tabbing "through" a locked note's overlay used to land back in that
// note's own editor). Focus returns to whatever opened the modal on close.
let modalReturnFocusEl = null;

function restoreModalFocus() {
  if (modalReturnFocusEl && document.body.contains(modalReturnFocusEl)) modalReturnFocusEl.focus();
  modalReturnFocusEl = null;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const openModal = [cmdkOverlay, lockOverlay].find((el) => !el.classList.contains("hidden"));
  if (!openModal) return;
  const focusable = Array.from(
    openModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

async function goToNote(id) {
  if (editorScreen.classList.contains("active")) await flushSave(true);
  showList();
  openNote(id);
}

function cmdkActionItems(query) {
  const inEditor = editorScreen.classList.contains("active") && currentNote;
  const items = [
    { label: "Nouvelle note", sub: "Créer une note vide", action: () => newNoteBtn.click() },
    { label: "Basculer le thème", sub: "Auto / clair / sombre", action: () => themeToggle.click() },
    { label: "Voir les archives", sub: "", action: () => { showList(); setListView("archived"); } },
    { label: "Voir la corbeille", sub: "", action: () => { showList(); setListView("trash"); } },
    { label: "Sélection multiple", sub: "Archiver / déplacer / supprimer plusieurs notes", action: () => { showList(); setSelectionMode(true); } },
    { label: "Note du jour", sub: "Journal", action: () => document.getElementById("journal-today-btn").click() },
    { label: "Vue graphe", sub: "", action: () => document.getElementById("graph-view-btn").click() },
    { label: "Toutes les tâches", sub: "", action: () => document.getElementById("tasks-view-btn").click() },
  ];
  // These only make sense with a note actually open — listed here instead of
  // buried in the editor's own "..." menu, since ⌘K is meant to be the one
  // place that reaches every action without hunting through menus.
  if (inEditor) {
    items.push(
      { label: currentNote.locked ? "Retirer le verrou" : "Verrouiller la note", sub: "", action: () => lockBtn.click() },
      { label: "Dupliquer la note", sub: "", action: () => duplicateNoteBtn.click() },
      { label: "Scinder par titres (H2)", sub: "", action: () => document.getElementById("split-note-btn").click() },
      { label: "Extraire les tâches", sub: "", action: () => document.getElementById("extract-tasks-btn").click() },
      { label: "Reporter les tâches non faites", sub: "", action: () => document.getElementById("carry-over-tasks-btn").click() },
      { label: "Exporter cette note", sub: "JSON", action: () => document.getElementById("export-note-btn").click() },
      { label: "Exporter en Markdown", sub: "", action: () => document.getElementById("export-markdown-btn").click() },
      { label: "Mode dessin & surlignage", sub: "", action: () => modeDrawBtn.click() },
      { label: "Mode focus", sub: "", action: () => focusBtn.click() },
      { label: "Mode lecture", sub: "", action: () => readingModeBtn.click() },
      { label: "Rechercher / remplacer", sub: "Dans cette note", action: () => document.getElementById("find-btn").click() },
      { label: "Sommaire", sub: "", action: () => document.getElementById("outline-btn").click() },
      { label: "Volet secondaire", sub: "Voir une autre note à côté", action: () => document.getElementById("split-view-btn").click() },
      { label: "Archiver la note", sub: "", action: () => archiveBtn.click() },
      { label: "Supprimer la note", sub: "", action: () => deleteNoteBtn.click() }
    );
  }
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((it) => it.label.toLowerCase().includes(q));
}

function renderCmdkResults(rawQuery) {
  // Prefixes narrow the palette to one kind of result, Slack/Spotlight-style:
  // ">" actions only, "#" tags, "/" folders — otherwise it's the default mix
  // of actions + matching notes (now searched by content too, not just
  // title/folder).
  const mode = rawQuery[0] === ">" || rawQuery[0] === "#" || rawQuery[0] === "/" ? rawQuery[0] : null;
  const query = mode ? rawQuery.slice(1) : rawQuery;
  const q = query.trim().toLowerCase();

  if (mode === "#") {
    const tagItems = allTags()
      .filter((t) => !q || t.toLowerCase().includes(q))
      .map((t) => ({
        label: "#" + t,
        sub: `${notesInActiveVault().filter((n) => !n.deletedAt && (n.tags || []).includes(t)).length} note(s)`,
        action: () => {
          showList();
          activeTagFilter = t;
          renderList();
        },
      }));
    cmdkItems = tagItems;
  } else if (mode === "/") {
    const folderItems = allFolders()
      .filter((f) => !q || f.toLowerCase().includes(q))
      .map((f) => ({
        label: f,
        sub: `${notesInActiveVault().filter((n) => !n.deletedAt && (n.folder === f || (n.folder || "").startsWith(f + "/"))).length} note(s)`,
        action: () => {
          showList();
          activeFolderFilter = f;
          renderList();
        },
      }));
    cmdkItems = folderItems;
  } else if (mode === ">") {
    cmdkItems = cmdkActionItems(q);
  } else {
    let candidateNotes = notesInActiveVault().filter((n) => !n.deletedAt);
    if (!q) {
      const recentIds = loadPref(RECENT_NOTES_KEY, []);
      const recentSet = new Set(recentIds);
      candidateNotes = recentIds.map((id) => notes.find((n) => n.id === id && !n.deletedAt && (n.vaultId || DEFAULT_VAULT_ID) === activeVaultId)).filter(Boolean);
      if (!candidateNotes.length) candidateNotes = notesInActiveVault().filter((n) => !n.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    } else {
      candidateNotes = candidateNotes
        .filter((n) => {
          const haystack = (n.title || "sans titre") + " " + (n.folder || "") + " " + (n.tags || []).join(" ") + " " + (n.locked ? "" : getPreview(n));
          return haystack.toLowerCase().includes(q);
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8);
    }
    const noteItems = candidateNotes.map((n) => ({
      label: n.locked ? "🔒 " + (n.title || "Sans titre") : n.title || "Sans titre",
      sub: n.folder || "Note",
      action: () => goToNote(n.id),
    }));
    cmdkItems = [...cmdkActionItems(q), ...noteItems];
  }

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

// --- Réception de partage entrant (Web Share Target API) ---
// D'autres apps (navigateur, Notes, Photos…) peuvent "Partager vers NoteFlow" ;
// le système ouvre alors index.html avec ces paramètres de requête (voir
// manifest.json > share_target). On les convertit en une nouvelle note puis
// on nettoie l'URL pour ne pas recréer la note à chaque rechargement.
async function handleIncomingShare() {
  const params = new URLSearchParams(window.location.search);
  const sharedTitle = params.get("shared_title");
  const sharedText = params.get("shared_text");
  const sharedUrl = params.get("shared_url");
  if (!sharedTitle && !sharedText && !sharedUrl) return;

  window.history.replaceState({}, "", window.location.pathname);

  const note = newNoteObject();
  note.title = sharedTitle || "";
  const bodyParts = [];
  if (sharedText) bodyParts.push(`<p>${escapeHtml(sharedText)}</p>`);
  if (sharedUrl) bodyParts.push(`<p><a href="${escapeHtml(sharedUrl)}">${escapeHtml(sharedUrl)}</a></p>`);
  note.html = bodyParts.join("");
  notes.unshift(note);
  await persistNote(note);
  currentNote = note;
  loadNoteIntoEditor();
  showEditor();
  showToast("Contenu partagé ajouté à une nouvelle note");
}

// --- Onboarding: a 3-step interactive tutorial shown once, on first launch
// (no notes yet and the flag never set) — [[wikilinks]], ⌘K, and a closing
// pointer to the rest of the app (shortcuts, ⋯ menus). Replayable anytime
// from the list menu. ---
const ONBOARDING_DONE_KEY = "noteflow.onboarding.done";
const onboardingOverlay = document.getElementById("onboarding-overlay");
const onboardingStepEl = document.getElementById("onboarding-step");
const onboardingDotsEl = document.getElementById("onboarding-dots");
const onboardingNextBtn = document.getElementById("onboarding-next-btn");
const onboardingSkipBtn = document.getElementById("onboarding-skip-btn");
let onboardingStepIndex = 0;

const ONBOARDING_STEPS = [
  {
    title: "Bienvenue dans NoteFlow",
    body: "Un carnet de notes local, rapide, et privé. Ce tour rapide te montre deux réflexes qui changent tout : les liens entre notes, et la palette de commandes.",
  },
  {
    title: "Relie tes notes avec [[ ]]",
    body: 'Dans le texte, tape <code>[[</code> puis le début du titre d\'une autre note : un menu apparaît pour la choisir (ou en créer une nouvelle à la volée). Le lien devient cliquable, et le panneau "Notes liées" montre les allers-retours dans les deux sens.',
  },
  {
    title: "Va n'importe où avec ⌘K",
    body: "Appuie sur <kbd class=\"shortcut-key\">Ctrl/⌘+K</kbd> à tout moment pour ouvrir une note par son titre ou son contenu, ou lancer une action (nouvelle note, thème, archives…) sans lâcher le clavier. Essaie <kbd class=\"shortcut-key\">&gt;</kbd>, <kbd class=\"shortcut-key\">#</kbd> ou <kbd class=\"shortcut-key\">/</kbd> en début de recherche pour filtrer par actions, tags ou dossiers.",
  },
  {
    title: "C'est parti",
    body: 'Le reste s\'explore au fil de l\'écriture : le menu "⋯" de chaque note cache verrouillage, historique, export, mode focus… et tu peux revoir ce tutoriel depuis le menu de la liste.',
  },
];

function renderOnboardingStep() {
  const step = ONBOARDING_STEPS[onboardingStepIndex];
  onboardingStepEl.innerHTML = `<h2>${escapeHtml(step.title)}</h2><p>${step.body}</p>`;
  onboardingDotsEl.innerHTML = "";
  ONBOARDING_STEPS.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "onboarding-dot" + (i === onboardingStepIndex ? " active" : "");
    onboardingDotsEl.appendChild(dot);
  });
  const isLast = onboardingStepIndex === ONBOARDING_STEPS.length - 1;
  onboardingNextBtn.textContent = isLast ? "Commencer" : "Suivant";
}

function openOnboarding() {
  onboardingStepIndex = 0;
  onboardingOverlay.classList.remove("hidden");
  renderOnboardingStep();
}

function closeOnboarding() {
  onboardingOverlay.classList.add("hidden");
  savePref(ONBOARDING_DONE_KEY, true);
}

onboardingNextBtn.addEventListener("click", () => {
  if (onboardingStepIndex < ONBOARDING_STEPS.length - 1) {
    onboardingStepIndex++;
    renderOnboardingStep();
  } else {
    closeOnboarding();
  }
});
onboardingSkipBtn.addEventListener("click", closeOnboarding);
document.getElementById("replay-onboarding-btn").addEventListener("click", () => {
  showList();
  openOnboarding();
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
  await handleIncomingShare();
  summarizeMissedReminders();
  initSyncFromStorage();
  if (!loadPref(ONBOARDING_DONE_KEY, false)) openOnboarding();
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
