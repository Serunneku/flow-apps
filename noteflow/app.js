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
const PREF_KEYS = { theme: "noteflow.theme", sort: "noteflow.sort" };
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

// --- Theme ---
const themeToggle = document.getElementById("theme-toggle");
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "🌓", light: "☀️", dark: "🌙" };
let theme = loadPref(PREF_KEYS.theme, "auto");

function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeToggle.textContent = THEME_LABEL[t];
}
applyTheme(theme);
themeToggle.addEventListener("click", () => {
  theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  savePref(PREF_KEYS.theme, theme);
  applyTheme(theme);
});

// --- Toast (with optional undo) ---
const toastEl = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastUndo = document.getElementById("toast-undo");
let toastTimer = null;

function showToast(message, onUndo) {
  clearTimeout(toastTimer);
  toastText.textContent = message;
  toastUndo.classList.toggle("hidden", !onUndo);
  toastEl.classList.remove("hidden");
  toastUndo.onclick = () => {
    if (onUndo) onUndo();
    toastEl.classList.add("hidden");
    clearTimeout(toastTimer);
  };
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 5000);
}

// --- Screens ---
const listScreen = document.getElementById("list-screen");
const editorScreen = document.getElementById("editor-screen");

function showList() {
  listScreen.classList.add("active");
  editorScreen.classList.remove("active");
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

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || "").trim();
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

function folderColor(folder) {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = folder.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 28%, 38%)`;
}

function allFolders() {
  return [...new Set(notes.map((n) => n.folder).filter(Boolean))];
}

function renderFolderFilters() {
  const folders = allFolders();
  folderFiltersEl.classList.toggle("hidden", folders.length === 0);
  folderFiltersEl.innerHTML = "";
  folders.forEach((folder) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter-chip" + (activeFolderFilter === folder ? " active" : "");
    chip.textContent = folder;
    chip.addEventListener("click", () => {
      activeFolderFilter = activeFolderFilter === folder ? null : folder;
      renderList();
    });
    folderFiltersEl.appendChild(chip);
  });
}

function renderList() {
  renderFolderFilters();
  const query = searchQuery.trim().toLowerCase();
  let visible = notes.filter((n) => {
    if (activeFolderFilter && n.folder !== activeFolderFilter) return false;
    if (query) {
      const haystack = (n.title + " " + stripHtml(n.html)).toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  visible.sort((a, b) => {
    if (!!b.pinned - !!a.pinned !== 0) return !!b.pinned - !!a.pinned;
    if (sortMode === "title") return (a.title || "").localeCompare(b.title || "", "fr");
    if (sortMode === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });

  notesListEl.innerHTML = "";
  notesEmptyEl.classList.toggle("show", visible.length === 0);

  visible.forEach((note) => {
    const li = document.createElement("li");
    li.className = "note-item";
    const preview = stripHtml(note.html) || (note.drawing && note.drawing.strokes.length ? "🖊️ Dessin" : "Note vide");
    li.innerHTML = `
      <div class="note-main">
        <div class="note-title"></div>
        <div class="note-preview"></div>
        <div class="note-meta">
          <span class="note-date"></span>
        </div>
      </div>
      <button class="note-delete" aria-label="Supprimer">✕</button>
    `;
    li.querySelector(".note-title").textContent = (note.pinned ? "📌 " : "") + (note.title || "Sans titre");
    li.querySelector(".note-preview").textContent = preview;
    li.querySelector(".note-date").textContent = timeAgo(note.updatedAt);
    if (note.folder) {
      const chip = document.createElement("span");
      chip.className = "note-folder-chip";
      chip.style.background = folderColor(note.folder);
      chip.textContent = note.folder;
      li.querySelector(".note-meta").appendChild(chip);
    }
    li.querySelector(".note-main").addEventListener("click", () => openNote(note.id));
    li.querySelector(".note-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNote(note.id);
    });
    notesListEl.appendChild(li);
  });
}

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderList();
});

async function deleteNote(id) {
  const index = notes.findIndex((n) => n.id === id);
  const removed = notes[index];
  notes = notes.filter((n) => n.id !== id);
  await removeNoteEverywhere(id);
  renderList();
  showToast("Note supprimée", async () => {
    notes.splice(index, 0, removed);
    await persistNote(removed);
    renderList();
  });
}

// --- Editor ---
const titleInput = document.getElementById("title-input");
const folderInput = document.getElementById("folder-input");
const textEditor = document.getElementById("text-editor");
const backBtn = document.getElementById("back-btn");
const pinBtn = document.getElementById("pin-btn");
const deleteNoteBtn = document.getElementById("delete-note-btn");
const saveIndicator = document.getElementById("save-indicator");
const newNoteBtn = document.getElementById("new-note-btn");
const duplicateNoteBtn = document.getElementById("duplicate-note-btn");
const wordCountEl = document.getElementById("word-count");
const sizeSelect = document.getElementById("size-select");

function newNoteObject() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    html: "",
    folder: "",
    pinned: false,
    createdAt: now,
    updatedAt: now,
    drawing: null,
    pageHeight: 700,
    fontSize: 15,
  };
}

function updateWordCount() {
  const text = textEditor.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.length;
  wordCountEl.textContent = words ? `${words} mot${words > 1 ? "s" : ""} · ${chars} car.` : "";
}

async function openNote(id) {
  currentNote = notes.find((n) => n.id === id);
  if (!currentNote) return;
  loadNoteIntoEditor();
  showEditor();
}

function loadNoteIntoEditor() {
  titleInput.value = currentNote.title || "";
  folderInput.value = currentNote.folder || "";
  textEditor.innerHTML = currentNote.html || "";
  pinBtn.classList.toggle("active", !!currentNote.pinned);
  saveIndicator.textContent = "";
  notePage.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.fontSize = (currentNote.fontSize || 15) + "px";
  sizeSelect.value = String(currentNote.fontSize || 15);
  updateWordCount();
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

newNoteBtn.addEventListener("click", async () => {
  currentNote = newNoteObject();
  notes.unshift(currentNote);
  await persistNote(currentNote);
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
  pinBtn.classList.toggle("active", currentNote.pinned);
  scheduleSave();
});

deleteNoteBtn.addEventListener("click", () => {
  const id = currentNote.id;
  showList();
  deleteNote(id);
});

let saveTimer = null;
function scheduleSave() {
  saveIndicator.textContent = "…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(false), 500);
}

async function flushSave(immediate) {
  if (!currentNote) return;
  clearTimeout(saveTimer);
  currentNote.title = titleInput.value.trim();
  currentNote.folder = folderInput.value.trim();
  currentNote.html = textEditor.innerHTML;
  currentNote.updatedAt = Date.now();
  await persistNote(currentNote);
  if (!immediate) saveIndicator.textContent = "Enregistré";
}

titleInput.addEventListener("input", scheduleSave);
folderInput.addEventListener("change", scheduleSave);
textEditor.addEventListener("input", () => {
  scheduleSave();
  updateWordCount();
});

// --- Mode switch (unified page: text vs draw) ---
const notePage = document.getElementById("note-page");
const modeTextBtn = document.getElementById("mode-text-btn");
const modeDrawBtn = document.getElementById("mode-draw-btn");
const drawToolbar = document.getElementById("draw-toolbar");
const growPageBtn = document.getElementById("grow-page-btn");

function setMode(mode) {
  notePage.classList.toggle("mode-text", mode === "text");
  notePage.classList.toggle("mode-draw", mode === "draw");
  modeTextBtn.classList.toggle("active", mode === "text");
  modeDrawBtn.classList.toggle("active", mode === "draw");
  document.getElementById("format-toolbar").classList.toggle("hidden", mode !== "text");
  drawToolbar.classList.toggle("hidden", mode !== "draw");
  textEditor.contentEditable = mode === "text" ? "true" : "false";
  if (mode === "text") setTimeout(() => textEditor.focus(), 0);
}

modeTextBtn.addEventListener("click", () => setMode("text"));
modeDrawBtn.addEventListener("click", () => setMode("draw"));

growPageBtn.addEventListener("click", () => {
  currentNote.pageHeight = (currentNote.pageHeight || 700) + 400;
  notePage.style.minHeight = currentNote.pageHeight + "px";
  textEditor.style.minHeight = currentNote.pageHeight + "px";
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
  if (cmd === "heading") {
    const isHeading = document.queryCommandValue("formatBlock") === "h2";
    document.execCommand("formatBlock", false, isHeading ? "p" : "h2");
  } else if (cmd === "checklist") {
    insertChecklistItem();
  } else {
    document.execCommand(cmd, false, null);
  }
  scheduleSave();
  updateToolbarState();
});

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
fontSelect.addEventListener("mousedown", (e) => e.stopPropagation());
fontSelect.addEventListener("change", () => {
  restoreSelection();
  if (fontSelect.value) document.execCommand("fontName", false, fontSelect.value);
  scheduleSave();
  fontSelect.value = "";
});

function insertChecklistItem() {
  const sel = window.getSelection();
  const li = document.createElement("li");
  li.className = "checklist-item";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const span = document.createElement("span");
  span.style.fontWeight = "normal";
  span.style.fontStyle = "normal";
  span.textContent = " ";
  li.appendChild(checkbox);
  li.appendChild(span);
  const ul = document.createElement("ul");
  ul.appendChild(li);

  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(ul);
    range.setStartAfter(span.firstChild || span);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    textEditor.appendChild(ul);
  }
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
      if (cmd === "heading") active = document.queryCommandValue("formatBlock") === "h2";
      else if (cmd === "checklist") active = false;
      else active = document.queryCommandState(cmd);
    } catch {
      active = false;
    }
    btn.classList.toggle("active", active);
  });
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

const COLORS = ["#1d1d1f", "#a13d3d", "#a8752c", "#3d6b52", "#3a5a8c", "#6b4a8c"];
let drawColor = COLORS[0];
let drawWidth = 3;
let isErasing = false;
let activeStroke = null;

COLORS.forEach((color, i) => {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "color-swatch" + (i === 0 ? " selected" : "");
  swatch.style.background = color;
  swatch.addEventListener("click", () => {
    drawColor = color;
    isErasing = false;
    eraserBtn.classList.remove("active");
    colorRow.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
    swatch.classList.add("selected");
  });
  colorRow.appendChild(swatch);
});

document.querySelectorAll(".width-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    drawWidth = Number(btn.dataset.width);
    document.querySelectorAll(".width-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

eraserBtn.addEventListener("click", () => {
  isErasing = !isErasing;
  eraserBtn.classList.toggle("active", isErasing);
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
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
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
  activeStroke = { points: [pos], color: drawColor, width: drawWidth, erase: isErasing };
  ensureDrawing().strokes.push(activeStroke);
});

canvas.addEventListener("pointermove", (e) => {
  if (!activeStroke) return;
  const pos = pointerPos(e);
  const prev = activeStroke.points[activeStroke.points.length - 1];
  activeStroke.points.push(pos);
  ctx.save();
  ctx.globalCompositeOperation = activeStroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = activeStroke.color;
  ctx.lineWidth = activeStroke.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  ctx.restore();
});

function endStroke() {
  if (!activeStroke) return;
  activeStroke = null;
  scheduleSave();
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

undoStrokeBtn.addEventListener("click", () => {
  const drawing = ensureDrawing();
  if (!drawing.strokes.length) return;
  const removed = drawing.strokes.pop();
  redrawStrokes();
  scheduleSave();
  showToast("Trait annulé", () => {
    drawing.strokes.push(removed);
    redrawStrokes();
    scheduleSave();
  });
});

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
  await dbPut(note);
  if (syncDb && syncCode && !applyingRemoteChange) {
    try {
      await syncFns.setDoc(syncFns.doc(syncDb, "syncs", syncCode, "notes", note.id), note);
    } catch (err) {
      console.warn("sync push failed", err);
    }
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
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (listScreen.classList.contains("active")) {
    if (key === "n") {
      e.preventDefault();
      newNoteBtn.click();
    } else if (key === "f") {
      e.preventDefault();
      searchInput.focus();
    }
  }
});

// --- Init ---
(async () => {
  notes = await dbGetAll();
  showList();
  initSyncFromStorage();
})();

// --- PWA service worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
