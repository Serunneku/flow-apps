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
let listView = "active"; // "active" | "archived" | "trash"

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
themeToggle.addEventListener("click", () => {
  theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  savePref(PREF_KEYS.theme, theme);
  applyTheme(theme);
});

// --- Overflow menus (list + editor "more" menus) ---
function setupMenu(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panel.classList.contains("hidden");
    document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
    if (willOpen) panel.classList.remove("hidden");
  });
  panel.addEventListener("click", (e) => {
    if (e.target.closest(".menu-item")) panel.classList.add("hidden");
  });
  return panel;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) {
    document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".menu-panel").forEach((p) => p.classList.add("hidden"));
});
setupMenu("list-menu-btn", "list-menu");
setupMenu("editor-menu-btn", "editor-menu");

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

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("format invalide");
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
    chip.addEventListener("dragover", (e) => e.preventDefault());
    chip.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggedNoteId) return;
      const note = notes.find((n) => n.id === draggedNoteId);
      if (note) {
        note.folder = folder;
        persistNote(note);
        renderList();
      }
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
  viewBanner.classList.toggle("hidden", view === "active");
  viewBannerTitle.textContent = VIEW_LABEL[view] || "";
  renderList();
}
viewBannerClose.addEventListener("click", () => setListView("active"));
document.getElementById("view-archive-btn").addEventListener("click", () => setListView("archived"));
document.getElementById("view-trash-btn").addEventListener("click", () => setListView("trash"));

function renderList() {
  renderFolderFilters();
  const query = searchQuery.trim().toLowerCase();
  let visible = notes.filter((n) => {
    if (listView === "trash" && !n.deletedAt) return false;
    if (listView === "archived" && (!n.archived || n.deletedAt)) return false;
    if (listView === "active" && (n.archived || n.deletedAt)) return false;
    if (activeFolderFilter && n.folder !== activeFolderFilter) return false;
    if (query) {
      const haystack = (n.title + " " + (n.folder || "") + " " + (n.locked ? "" : stripHtml(n.html))).toLowerCase();
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

  visible.forEach((note) => {
    const li = document.createElement("li");
    li.className = "note-item";
    const preview = note.locked
      ? "Note verrouillée"
      : stripHtml(note.html) || (note.drawing && note.drawing.strokes.length ? "Dessin" : "Note vide");
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
    li.querySelector(".note-date").textContent = timeAgo(note.updatedAt);
    if (note.reminderAt && note.reminderAt > Date.now()) {
      const rem = document.createElement("span");
      rem.className = "note-reminder-chip";
      rem.innerHTML =
        '<svg class="icon"><use href="#icon-bell"/></svg> ' +
        new Date(note.reminderAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      li.querySelector(".note-meta").appendChild(rem);
    }
    if (note.folder) {
      const chip = document.createElement("span");
      chip.className = "note-folder-chip";
      chip.style.background = folderColor(note.folder);
      chip.textContent = note.folder;
      li.querySelector(".note-meta").appendChild(chip);
    }
    li.querySelector(".note-main").addEventListener("click", () => {
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
      if (action === "delete") deleteNote(note.id);
      else if (action === "restore") restoreNote(note.id);
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

searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderList();
});

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function deleteNote(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.deletedAt = Date.now();
  await persistNote(note);
  renderList();
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
    pinned: false,
    createdAt: now,
    updatedAt: now,
    order: notes.length ? Math.min(...notes.map((n) => n.order ?? 0)) - 1 : 0,
    drawing: null,
    pageHeight: 700,
    fontSize: 15,
    locked: false,
    pinCode: null,
    reminderAt: null,
    reminderFired: false,
    history: [],
    color: null,
    paperStyle: "blank",
    archived: false,
    deletedAt: null,
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
  if (currentNote.locked) {
    showLockOverlay();
    return;
  }
  loadNoteIntoEditor();
  showEditor();
}

function loadNoteIntoEditor() {
  titleInput.value = currentNote.title || "";
  folderInput.value = currentNote.folder || "";
  textEditor.innerHTML = currentNote.html || "";
  pinBtn.classList.toggle("active", !!currentNote.pinned);
  setLockIcon(!!currentNote.locked);
  lockBtn.classList.toggle("active", !!currentNote.locked);
  saveIndicator.textContent = "";
  notePage.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.minHeight = (currentNote.pageHeight || 700) + "px";
  textEditor.style.fontSize = (currentNote.fontSize || 15) + "px";
  sizeSelect.value = String(currentNote.fontSize || 15);
  if (sizeSelect._customSelectRefresh) sizeSelect._customSelectRefresh();
  reminderPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
  colorPanel.classList.add("hidden");
  paperPanel.classList.add("hidden");
  findPanel.classList.add("hidden");
  reminderInput.value = currentNote.reminderAt ? toLocalDatetimeValue(currentNote.reminderAt) : "";
  editorScreen.classList.remove("focus-mode");
  notePage.style.backgroundColor = currentNote.color || "";
  notePage.dataset.paper = currentNote.paperStyle || "blank";
  updateNoteColorSelection();
  updatePaperStyleSelection();
  updateArchiveMenuItem();
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

function pushHistorySnapshot() {
  if (!currentNote.history) currentNote.history = [];
  currentNote.history.push({ title: currentNote.title, html: currentNote.html, ts: Date.now() });
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
  currentNote.html = newHtml;
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
  drawHint.classList.toggle("hidden", mode !== "draw");
  textEditor.contentEditable = mode === "text" ? "true" : "false";
  if (mode === "text") setTimeout(() => textEditor.focus(), 0);
}

modeTextBtn.addEventListener("click", () => setMode("text"));
modeDrawBtn.addEventListener("click", () => setMode("draw"));

// --- Focus mode ---
const focusBtn = document.getElementById("focus-btn");
focusBtn.addEventListener("click", () => {
  editorScreen.classList.toggle("focus-mode");
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

async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const hash = await hashPin(lockInput.value);
  if (hash === note.pinCode) {
    lockOverlay.classList.add("hidden");
    currentNote = note;
    loadNoteIntoEditor();
    showEditor();
  } else {
    lockError.classList.remove("hidden");
    lockInput.value = "";
    lockInput.focus();
  }
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
    currentNote.pinCode = await hashPin(pin);
    currentNote.locked = true;
    setLockIcon(true);
    lockBtn.classList.add("active");
    scheduleSave();
    showToast("Note verrouillée");
  } else {
    const pin = window.prompt("Entre le code pour retirer le verrou :");
    if (pin === null) return;
    const hash = await hashPin(pin);
    if (hash === currentNote.pinCode) {
      currentNote.locked = false;
      currentNote.pinCode = null;
      setLockIcon(false);
      lockBtn.classList.remove("active");
      scheduleSave();
      showToast("Verrou retiré");
    } else {
      showToast("Code incorrect");
    }
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

// --- Markdown-style shortcuts while typing ---
// Runs on "input" (after the space is already committed to the DOM). The line
// is converted with direct DOM moves rather than execCommand("formatBlock"/
// "insertUnorderedList"): on a collapsed caret those commands proved unreliable
// (no-op on the first line of a fresh note, or wrapping unrelated content).
function placeCaretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
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

function insertImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    restoreSelection();
    const img = document.createElement("img");
    img.src = reader.result;
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
  };
  reader.readAsDataURL(file);
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
  table.remove();
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
  if (row) row.remove();
  if (!table.rows.length) table.remove();
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
  Array.from(table.rows).forEach((row) => {
    if (row.cells[colIndex]) row.cells[colIndex].remove();
  });
  if (table.rows[0] && table.rows[0].cells.length === 0) table.remove();
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
    btn.classList.toggle("active", active);
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
  penBtn.classList.toggle("active", tool === "pen");
  highlighterBtn.classList.toggle("active", tool === "highlighter");
  eraserBtn.classList.toggle("active", tool === "eraser");
  renderColorRow();
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
      eraserBtn.classList.remove("active");
      colorRow.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
    });
    colorRow.appendChild(swatch);
  });
}
renderColorRow();

penBtn.addEventListener("click", () => setTool("pen"));
highlighterBtn.addEventListener("click", () => setTool("highlighter"));

document.querySelectorAll(".width-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    drawWidth = Number(btn.dataset.width);
    document.querySelectorAll(".width-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

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
  await purgeOldTrash();
  showList();
  initSyncFromStorage();
})();

// --- PWA service worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
