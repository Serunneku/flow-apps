const STORAGE_KEYS = {
  tasks: "focusflow.tasks",
  habits: "focusflow.habits",
  theme: "focusflow.theme",
  density: "focusflow.density",
  activeTab: "focusflow.activeTab",
  onboarded: "focusflow.onboarded",
  tasksCompletedTotal: "focusflow.stats.tasksCompletedTotal",
  lastBackupPrompt: "focusflow.lastBackupPrompt",
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const load = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let tasks = load(STORAGE_KEYS.tasks, []);
let habits = load(STORAGE_KEYS.habits, []);

// Reset recurring tasks that were completed on a previous day
{
  const today = todayKey();
  let changed = false;
  tasks.forEach((task) => {
    if (task.recurring && task.done && task.doneDate !== today) {
      task.done = false;
      task.doneDate = null;
      changed = true;
    }
  });
  if (changed) save(STORAGE_KEYS.tasks, tasks);
}

// --- Onboarding ---
const onboarding = document.getElementById("onboarding");
if (!load(STORAGE_KEYS.onboarded, false)) {
  onboarding.classList.remove("hidden");
}
document.getElementById("onboarding-dismiss").addEventListener("click", () => {
  onboarding.classList.add("hidden");
  save(STORAGE_KEYS.onboarded, true);
});

// --- Theme ---
const themeToggle = document.getElementById("theme-toggle");
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "🌓", light: "☀️", dark: "🌙" };

function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeToggle.textContent = THEME_LABEL[t];
}

let theme = load(STORAGE_KEYS.theme, "auto");
applyTheme(theme);
themeToggle.addEventListener("click", () => {
  theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  save(STORAGE_KEYS.theme, theme);
  applyTheme(theme);
});

// --- Density ---
const densityToggle = document.getElementById("density-toggle");
let density = load(STORAGE_KEYS.density, "comfortable");

function applyDensity(d) {
  document.documentElement.setAttribute("data-density", d);
  densityToggle.title = d === "compact" ? "Densité : compacte" : "Densité : confortable";
}
applyDensity(density);
densityToggle.addEventListener("click", () => {
  density = density === "compact" ? "comfortable" : "compact";
  save(STORAGE_KEYS.density, density);
  applyDensity(density);
});

// --- Backup menu (export/import/copy) ---
const menuToggle = document.getElementById("menu-toggle");
const backupMenu = document.getElementById("backup-menu");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const copyBtn = document.getElementById("copy-btn");

menuToggle.addEventListener("click", () => backupMenu.classList.toggle("hidden"));

function exportData() {
  const payload = { tasks, habits, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `focusflow-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  save(STORAGE_KEYS.lastBackupPrompt, Date.now());
}

exportBtn.addEventListener("click", () => {
  exportData();
  backupMenu.classList.add("hidden");
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks) || !Array.isArray(data.habits)) throw new Error("format invalide");
    tasks = data.tasks;
    habits = data.habits;
    save(STORAGE_KEYS.tasks, tasks);
    save(STORAGE_KEYS.habits, habits);
    renderTasks();
    renderHabits();
    renderStats();
    showToast("Sauvegarde importée ✓");
  } catch {
    showToast("Fichier de sauvegarde invalide");
  }
  importFile.value = "";
  backupMenu.classList.add("hidden");
});

copyBtn.addEventListener("click", async () => {
  const active = getActiveTab();
  let text = "";
  if (active === "habits") {
    text = habits.map((h) => `${h.emoji || "•"} ${h.name}`).join("\n");
  } else {
    text = tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n");
  }
  try {
    if (navigator.share) {
      await navigator.share({ text, title: "FocusFlow" });
    } else {
      await navigator.clipboard.writeText(text);
      showToast("Copié dans le presse-papiers ✓");
    }
  } catch {
    /* user cancelled share/clipboard prompt */
  }
  backupMenu.classList.add("hidden");
});

// --- Backup reminder (weekly nudge) ---
const backupReminder = document.getElementById("backup-reminder");
{
  const last = load(STORAGE_KEYS.lastBackupPrompt, 0);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if ((tasks.length > 0 || habits.length > 0) && Date.now() - last > weekMs) {
    backupReminder.classList.remove("hidden");
  }
}
document.getElementById("backup-reminder-export").addEventListener("click", () => {
  exportData();
  backupReminder.classList.add("hidden");
});
document.getElementById("backup-reminder-dismiss").addEventListener("click", () => {
  save(STORAGE_KEYS.lastBackupPrompt, Date.now());
  backupReminder.classList.add("hidden");
});

// --- Toast (with optional undo) + global Cmd/Ctrl+Z ---
const toastEl = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastUndo = document.getElementById("toast-undo");
let toastTimer = null;
let lastUndoAction = null;

function showToast(message, onUndo) {
  clearTimeout(toastTimer);
  toastText.textContent = message;
  toastUndo.classList.toggle("hidden", !onUndo);
  toastEl.classList.remove("hidden");
  lastUndoAction = onUndo || null;
  toastUndo.onclick = () => runUndo();
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
    lastUndoAction = null;
  }, 5000);
}

function runUndo() {
  if (lastUndoAction) lastUndoAction();
  toastEl.classList.add("hidden");
  clearTimeout(toastTimer);
  lastUndoAction = null;
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    if (lastUndoAction) {
      e.preventDefault();
      runUndo();
    }
  }
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    activateTab("tasks");
    taskInput.focus();
  }
});

// --- Tabs ---
const tabs = document.querySelectorAll(".tab");
const panels = {
  tasks: document.getElementById("tasks-panel"),
  habits: document.getElementById("habits-panel"),
  stats: document.getElementById("stats-panel"),
};

function getActiveTab() {
  return Object.keys(panels).find((key) => panels[key].classList.contains("active")) || "tasks";
}

function activateTab(name) {
  tabs.forEach((t) => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", String(isActive));
  });
  Object.entries(panels).forEach(([key, panel]) => panel.classList.toggle("active", key === name));
  save(STORAGE_KEYS.activeTab, name);
  if (name === "stats") renderStats();
}

tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
activateTab(load(STORAGE_KEYS.activeTab, "tasks"));

// --- Date header ---
document.getElementById("today").textContent = new Date().toLocaleDateString("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

// --- Shared helpers ---
function bindEscapeClear(input) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
    }
  });
}

function startInlineEdit(labelEl, currentText, onSave) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-input";
  input.maxLength = 200;
  input.value = currentText;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => onSave(input.value.trim() || currentText);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = currentText;
      input.blur();
    }
  });
}

function tagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function enableDragReorder(listEl, items, onReorder) {
  let draggedId = null;
  listEl.addEventListener("dragstart", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    draggedId = li.dataset.id;
    li.classList.add("dragging");
  });
  listEl.addEventListener("dragend", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) li.classList.remove("dragging");
    listEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  });
  listEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    const li = e.target.closest("li[data-id]");
    if (!li || li.dataset.id === draggedId) return;
    listEl.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    li.classList.add("drag-over");
  });
  listEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = e.target.closest("li[data-id]");
    if (!li || !draggedId || li.dataset.id === draggedId) return;
    const fromIndex = items.findIndex((i) => i.id === draggedId);
    const toIndex = items.findIndex((i) => i.id === li.dataset.id);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    onReorder();
  });
}

// --- Tasks state ---
const taskForm = document.getElementById("task-form");
const taskInput = document.getElementById("task-input");
const taskSearch = document.getElementById("task-search");
const taskList = document.getElementById("task-list");
const taskEmpty = document.getElementById("task-empty");
const taskCounter = document.getElementById("task-counter");
const clearDoneBtn = document.getElementById("clear-done-btn");
const tagFiltersEl = document.getElementById("tag-filters");
const selectModeBtn = document.getElementById("select-mode-btn");
const bulkBar = document.getElementById("bulk-bar");
const bulkCount = document.getElementById("bulk-count");
bindEscapeClear(taskInput);
bindEscapeClear(taskSearch);

let currentFilter = "all";
let activeTagFilter = null;
let selectMode = false;
const selectedIds = new Set();
const expandedTaskIds = new Set();
const expandedHabitIds = new Set();

document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.filter;
    document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === btn));
    renderTasks();
  });
});

taskSearch.addEventListener("input", renderTasks);

selectModeBtn.addEventListener("click", () => {
  selectMode = !selectMode;
  selectedIds.clear();
  selectModeBtn.textContent = selectMode ? "Annuler" : "Sélectionner";
  renderTasks();
});

function updateBulkBar() {
  bulkBar.classList.toggle("hidden", !selectMode || selectedIds.size === 0);
  bulkCount.textContent = `${selectedIds.size} sélectionnée(s)`;
}

document.getElementById("bulk-done-btn").addEventListener("click", () => {
  const today = todayKey();
  tasks.forEach((t) => {
    if (selectedIds.has(t.id) && !t.done) {
      t.done = true;
      t.doneDate = today;
      save(STORAGE_KEYS.tasksCompletedTotal, load(STORAGE_KEYS.tasksCompletedTotal, 0) + 1);
    }
  });
  save(STORAGE_KEYS.tasks, tasks);
  selectedIds.clear();
  renderTasks();
});

document.getElementById("bulk-delete-btn").addEventListener("click", () => {
  const removed = tasks.filter((t) => selectedIds.has(t.id));
  const removedIndices = removed.map((t) => tasks.findIndex((x) => x.id === t.id));
  tasks = tasks.filter((t) => !selectedIds.has(t.id));
  save(STORAGE_KEYS.tasks, tasks);
  selectedIds.clear();
  renderTasks();
  showToast(`${removed.length} tâche(s) supprimée(s)`, () => {
    removed.forEach((t, i) => tasks.splice(Math.min(removedIndices[i], tasks.length), 0, t));
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
});

function allTags() {
  return [...new Set(tasks.map((t) => t.tag).filter(Boolean))];
}

function renderTagFilters() {
  const tags = allTags();
  tagFiltersEl.classList.toggle("hidden", tags.length === 0);
  tagFiltersEl.innerHTML = "";
  tags.forEach((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter-chip" + (activeTagFilter === tag ? " active" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      renderTasks();
    });
    tagFiltersEl.appendChild(chip);
  });
}

function formatDue(due) {
  const d = new Date(due + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function buildTaskExpand(task) {
  const wrap = document.createElement("div");
  wrap.className = "item-expand";
  wrap.innerHTML = `
    <div class="expand-grid">
      <label>Priorité
        <select class="f-priority">
          <option value="low">Basse</option>
          <option value="normal">Normale</option>
          <option value="high">Haute</option>
        </select>
      </label>
      <label>Échéance
        <input type="date" class="f-due" />
      </label>
    </div>
    <label>Étiquette
      <input type="text" class="f-tag" maxlength="30" placeholder="ex: Perso, Travail…" />
    </label>
    <label>Note
      <textarea class="f-note" maxlength="1000" placeholder="Détails…"></textarea>
    </label>
    <div class="recurring-row">
      <input type="checkbox" class="f-recurring" id="recurring-${task.id}" />
      <label for="recurring-${task.id}">Tâche récurrente quotidienne</label>
    </div>
    <div class="subtasks-wrap">
      <ul class="subtasks"></ul>
      <form class="add-subtask">
        <input type="text" maxlength="120" placeholder="Ajouter une sous-tâche…" autocomplete="off" />
        <button type="submit" class="link-btn">+</button>
      </form>
    </div>
  `;
  wrap.querySelector(".f-priority").value = task.priority || "normal";
  wrap.querySelector(".f-due").value = task.due || "";
  wrap.querySelector(".f-tag").value = task.tag || "";
  wrap.querySelector(".f-note").value = task.note || "";
  wrap.querySelector(".f-recurring").checked = !!task.recurring;

  wrap.querySelector(".f-priority").addEventListener("change", (e) => {
    task.priority = e.target.value;
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
  wrap.querySelector(".f-due").addEventListener("change", (e) => {
    task.due = e.target.value || "";
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
  wrap.querySelector(".f-tag").addEventListener("change", (e) => {
    task.tag = e.target.value.trim();
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
  wrap.querySelector(".f-note").addEventListener("blur", (e) => {
    task.note = e.target.value;
    save(STORAGE_KEYS.tasks, tasks);
  });
  wrap.querySelector(".f-recurring").addEventListener("change", (e) => {
    task.recurring = e.target.checked;
    save(STORAGE_KEYS.tasks, tasks);
  });

  const subUl = wrap.querySelector(".subtasks");
  (task.subtasks || []).forEach((sub) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" class="sub-check" />
      <span class="sub-label"></span>
      <button type="button" class="sub-remove" aria-label="Supprimer">✕</button>
    `;
    li.querySelector(".sub-check").checked = sub.done;
    const label = li.querySelector(".sub-label");
    label.textContent = sub.text;
    label.classList.toggle("done", sub.done);
    li.querySelector(".sub-check").addEventListener("change", (e) => {
      sub.done = e.target.checked;
      save(STORAGE_KEYS.tasks, tasks);
      renderTasks();
    });
    li.querySelector(".sub-remove").addEventListener("click", () => {
      task.subtasks = task.subtasks.filter((s) => s.id !== sub.id);
      save(STORAGE_KEYS.tasks, tasks);
      renderTasks();
    });
    subUl.appendChild(li);
  });

  wrap.querySelector(".add-subtask").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    task.subtasks = task.subtasks || [];
    task.subtasks.push({ id: crypto.randomUUID(), text, done: false });
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });

  return wrap;
}

function renderTasks() {
  renderTagFilters();
  const today = todayKey();
  const query = taskSearch.value.trim().toLowerCase();

  let visible = tasks.filter((t) => {
    if (currentFilter === "active" && t.done) return false;
    if (currentFilter === "done" && !t.done) return false;
    if (activeTagFilter && t.tag !== activeTagFilter) return false;
    if (query && !t.text.toLowerCase().includes(query)) return false;
    return true;
  });

  taskList.innerHTML = "";
  taskEmpty.classList.toggle("show", visible.length === 0);

  const doneCount = tasks.filter((t) => t.done).length;
  taskCounter.textContent = tasks.length ? `${doneCount}/${tasks.length} terminées` : "";
  clearDoneBtn.classList.toggle("hidden", doneCount === 0);
  updateBulkBar();

  const ordered = [...visible].sort((a, b) => Number(a.done) - Number(b.done));

  ordered.forEach((task) => {
    const li = document.createElement("li");
    li.className = "item" + (task.done ? " done" : "");
    li.dataset.id = task.id;
    li.draggable = !selectMode;

    const overdue = task.due && task.due < today && !task.done;
    const subtaskProgress = task.subtasks && task.subtasks.length
      ? `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}`
      : "";

    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      ${selectMode ? '<input type="checkbox" class="select-checkbox" />' : '<span class="drag-handle">⠿</span>'}
      <button class="check" aria-label="Basculer" aria-pressed="${task.done}">${task.done ? "✓" : ""}</button>
      <div class="body">
        <span class="label"></span>
        <div class="meta-row"></div>
      </div>
      <button class="expand-toggle" aria-label="Détails">▾</button>
      <button class="remove" aria-label="Supprimer">✕</button>
    `;
    row.querySelector(".label").textContent = task.text;

    const meta = row.querySelector(".meta-row");
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "priority-dot";
    dot.dataset.priority = task.priority || "normal";
    dot.title = "Priorité";
    dot.addEventListener("click", () => {
      const order = ["low", "normal", "high"];
      task.priority = order[(order.indexOf(task.priority || "normal") + 1) % order.length];
      save(STORAGE_KEYS.tasks, tasks);
      renderTasks();
    });
    meta.appendChild(dot);

    if (task.due) {
      const badge = document.createElement("span");
      badge.className = "due-badge" + (overdue ? " overdue" : "");
      badge.textContent = (overdue ? "⚠️ " : "📅 ") + formatDue(task.due);
      meta.appendChild(badge);
    }
    if (task.tag) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.style.background = tagColor(task.tag);
      chip.textContent = task.tag;
      meta.appendChild(chip);
    }
    if (subtaskProgress) {
      const sp = document.createElement("span");
      sp.className = "due-badge";
      sp.textContent = `☑ ${subtaskProgress}`;
      meta.appendChild(sp);
    }
    if (task.recurring) {
      const rec = document.createElement("span");
      rec.className = "due-badge";
      rec.textContent = "🔁";
      meta.appendChild(rec);
    }

    if (selectMode) {
      const checkbox = row.querySelector(".select-checkbox");
      checkbox.checked = selectedIds.has(task.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIds.add(task.id);
        else selectedIds.delete(task.id);
        updateBulkBar();
      });
    }

    row.querySelector(".check").addEventListener("click", () => {
      task.done = !task.done;
      if (task.done) {
        task.doneDate = today;
        save(STORAGE_KEYS.tasksCompletedTotal, load(STORAGE_KEYS.tasksCompletedTotal, 0) + 1);
      } else {
        task.doneDate = null;
      }
      save(STORAGE_KEYS.tasks, tasks);
      renderTasks();
    });
    row.querySelector(".label").addEventListener("dblclick", (e) => {
      startInlineEdit(e.target, task.text, (value) => {
        task.text = value;
        save(STORAGE_KEYS.tasks, tasks);
        renderTasks();
      });
    });
    row.querySelector(".remove").addEventListener("click", () => {
      const index = tasks.findIndex((t) => t.id === task.id);
      const removed = tasks[index];
      tasks = tasks.filter((t) => t.id !== task.id);
      save(STORAGE_KEYS.tasks, tasks);
      renderTasks();
      showToast("Tâche supprimée", () => {
        tasks.splice(index, 0, removed);
        save(STORAGE_KEYS.tasks, tasks);
        renderTasks();
      });
    });

    const expand = buildTaskExpand(task);
    const toggleBtn = row.querySelector(".expand-toggle");
    if (expandedTaskIds.has(task.id)) {
      expand.classList.add("show");
      toggleBtn.textContent = "▲";
    }
    toggleBtn.addEventListener("click", () => {
      const willShow = !expand.classList.contains("show");
      expand.classList.toggle("show", willShow);
      toggleBtn.textContent = willShow ? "▲" : "▾";
      if (willShow) expandedTaskIds.add(task.id);
      else expandedTaskIds.delete(task.id);
    });

    li.appendChild(row);
    li.appendChild(expand);
    taskList.appendChild(li);
  });

  enableDragReorder(taskList, tasks, () => {
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
}

taskForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = taskInput.value.trim();
  if (!text) return;
  tasks.push({
    id: crypto.randomUUID(),
    text,
    done: false,
    priority: "normal",
    due: "",
    tag: "",
    note: "",
    recurring: false,
    doneDate: null,
    subtasks: [],
  });
  save(STORAGE_KEYS.tasks, tasks);
  taskInput.value = "";
  renderTasks();
});

clearDoneBtn.addEventListener("click", () => {
  const removed = tasks.filter((t) => t.done);
  if (!removed.length) return;
  tasks = tasks.filter((t) => !t.done);
  save(STORAGE_KEYS.tasks, tasks);
  renderTasks();
  showToast(`${removed.length} tâche(s) effacée(s)`, () => {
    tasks = [...tasks, ...removed];
    save(STORAGE_KEYS.tasks, tasks);
    renderTasks();
  });
});

// --- Habits ---
const habitForm = document.getElementById("habit-form");
const habitInput = document.getElementById("habit-input");
const habitList = document.getElementById("habit-list");
const habitEmpty = document.getElementById("habit-empty");
bindEscapeClear(habitInput);

const HABIT_EMOJIS = ["✅", "💧", "🏃", "📚", "🧘", "🥗", "😴", "✍️", "🎯", "🙏"];

function currentStreak(dates) {
  const set = new Set(dates);
  let streak = 0;
  const cursor = new Date();
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function bestStreak(dates) {
  if (!dates.length) return 0;
  const sorted = [...dates].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diffDays = Math.round((new Date(sorted[i]) - new Date(sorted[i - 1])) / 86400000);
    run = diffDays === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function renderHabits() {
  habitList.innerHTML = "";
  habitEmpty.classList.toggle("show", habits.length === 0);
  const today = todayKey();
  const week = lastDays(7);

  habits.forEach((habit) => {
    const doneToday = habit.dates.includes(today);
    const streak = currentStreak(habit.dates);
    const best = bestStreak(habit.dates);
    const weeklyGoal = habit.weeklyGoal || 7;
    const weekCount = habit.dates.filter((d) => week.includes(d)).length;

    const li = document.createElement("li");
    li.className = "item" + (doneToday ? " done" : "");

    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <button class="check" aria-label="Basculer" aria-pressed="${doneToday}">${doneToday ? "✓" : ""}</button>
      <div class="body">
        <span class="label"><span class="habit-emoji"></span> <span class="label-text"></span></span>
        <div class="streak-row">
          <span class="habit-grid"></span>
          <span class="streak-text"></span>
        </div>
        <div class="weekly-goal-text"></div>
      </div>
      <button class="expand-toggle" aria-label="Détails">▾</button>
      <button class="remove" aria-label="Supprimer">✕</button>
    `;
    row.querySelector(".habit-emoji").textContent = habit.emoji || "✅";
    row.querySelector(".label-text").textContent = habit.name;

    const grid = row.querySelector(".habit-grid");
    week.forEach((day) => {
      const dot = document.createElement("span");
      dot.className = "day-dot" + (habit.dates.includes(day) ? " filled" : "") + (day === today ? " today" : "");
      grid.appendChild(dot);
    });

    const parts = [];
    if (streak > 0) parts.push(`🔥 ${streak}j`);
    if (best > streak) parts.push(`record ${best}j`);
    row.querySelector(".streak-text").textContent = parts.join(" · ");
    row.querySelector(".weekly-goal-text").textContent = `${weekCount}/${weeklyGoal} cette semaine`;

    row.querySelector(".check").addEventListener("click", () => {
      if (habit.dates.includes(today)) habit.dates = habit.dates.filter((d) => d !== today);
      else habit.dates.push(today);
      save(STORAGE_KEYS.habits, habits);
      renderHabits();
    });
    row.querySelector(".label-text").addEventListener("dblclick", (e) => {
      startInlineEdit(e.target, habit.name, (value) => {
        habit.name = value;
        save(STORAGE_KEYS.habits, habits);
        renderHabits();
      });
    });
    row.querySelector(".remove").addEventListener("click", () => {
      const index = habits.findIndex((h) => h.id === habit.id);
      const removed = habits[index];
      habits = habits.filter((h) => h.id !== habit.id);
      save(STORAGE_KEYS.habits, habits);
      renderHabits();
      showToast("Habitude supprimée", () => {
        habits.splice(index, 0, removed);
        save(STORAGE_KEYS.habits, habits);
        renderHabits();
      });
    });

    const expand = document.createElement("div");
    expand.className = "item-expand";
    expand.innerHTML = `
      <label>Emoji
        <div class="emoji-row"></div>
      </label>
      <label>Objectif hebdomadaire
        <select class="f-goal">
          ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n}x / semaine</option>`).join("")}
        </select>
      </label>
    `;
    expand.querySelector(".f-goal").value = String(weeklyGoal);
    expand.querySelector(".f-goal").addEventListener("change", (e) => {
      habit.weeklyGoal = Number(e.target.value);
      save(STORAGE_KEYS.habits, habits);
      renderHabits();
    });
    const emojiRow = expand.querySelector(".emoji-row");
    HABIT_EMOJIS.forEach((emoji) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emoji-btn" + (habit.emoji === emoji ? " selected" : "");
      btn.textContent = emoji;
      btn.addEventListener("click", () => {
        habit.emoji = emoji;
        save(STORAGE_KEYS.habits, habits);
        renderHabits();
      });
      emojiRow.appendChild(btn);
    });

    const habitToggleBtn = row.querySelector(".expand-toggle");
    if (expandedHabitIds.has(habit.id)) {
      expand.classList.add("show");
      habitToggleBtn.textContent = "▲";
    }
    habitToggleBtn.addEventListener("click", () => {
      const willShow = !expand.classList.contains("show");
      expand.classList.toggle("show", willShow);
      habitToggleBtn.textContent = willShow ? "▲" : "▾";
      if (willShow) expandedHabitIds.add(habit.id);
      else expandedHabitIds.delete(habit.id);
    });

    li.dataset.id = habit.id;
    li.draggable = true;
    li.appendChild(row);
    li.appendChild(expand);
    habitList.appendChild(li);
  });

  enableDragReorder(habitList, habits, () => {
    save(STORAGE_KEYS.habits, habits);
    renderHabits();
  });

  maybeRemindHabits();
}

habitForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = habitInput.value.trim();
  if (!name) return;
  habits.push({ id: crypto.randomUUID(), name, dates: [], emoji: "✅", weeklyGoal: 7 });
  save(STORAGE_KEYS.habits, habits);
  habitInput.value = "";
  renderHabits();
});

// --- Daily habit reminder notification ---
function maybeRemindHabits() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const today = todayKey();
  const incomplete = habits.filter((h) => !h.dates.includes(today));
  if (incomplete.length === 0) return;
  const lastNotified = load("focusflow.lastHabitNotify", "");
  if (lastNotified === today) return;
  const hour = new Date().getHours();
  if (hour < 19) return;
  new Notification("FocusFlow", {
    body: `${incomplete.length} habitude(s) à cocher aujourd'hui`,
  });
  save("focusflow.lastHabitNotify", today);
}

if (habits.length > 0 && "Notification" in window && Notification.permission === "default") {
  const reminderBtn = document.createElement("button");
  reminderBtn.type = "button";
  reminderBtn.className = "link-btn";
  reminderBtn.textContent = "🔔 Activer les rappels";
  reminderBtn.style.marginBottom = "10px";
  reminderBtn.addEventListener("click", () => {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") showToast("Rappels activés (à partir de 19h)");
      reminderBtn.remove();
    });
  });
  document.getElementById("habits-panel").insertBefore(reminderBtn, habitList);
}
setInterval(maybeRemindHabits, 5 * 60 * 1000);

// --- Stats ---
function renderStats() {
  const container = document.getElementById("stats-content");
  const totalDone = load(STORAGE_KEYS.tasksCompletedTotal, 0);
  const bestOverall = habits.reduce((max, h) => Math.max(max, bestStreak(h.dates)), 0);
  const week = lastDays(7);
  const habitRate = habits.length
    ? Math.round(
        (habits.reduce((sum, h) => sum + h.dates.filter((d) => week.includes(d)).length, 0) /
          (habits.length * 7)) *
          100
      )
    : 0;

  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Tâches terminées (total)</div>
      <div class="stat-value">${totalDone}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Meilleure série d'habitude jamais atteinte</div>
      <div class="stat-value">${bestOverall}j</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Taux de complétion des habitudes (7 derniers jours)</div>
      <div class="stat-value">${habits.length ? habitRate + "%" : "—"}</div>
      <div id="stats-habit-rows"></div>
    </div>
  `;

  const rowsEl = container.querySelector("#stats-habit-rows");
  habits.forEach((h) => {
    const count = h.dates.filter((d) => week.includes(d)).length;
    const row = document.createElement("div");
    row.className = "stat-habit-row";
    row.innerHTML = `<span>${h.emoji || "✅"} ${h.name}</span><span>${count}/7</span>`;
    rowsEl.appendChild(row);
  });
}

renderTasks();
renderHabits();

// --- PWA service worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
