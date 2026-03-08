import { invoke } from "@tauri-apps/api/core";

const statusEl = document.getElementById("status");
const saveStatusEl = document.getElementById("save-status");
const rebuildIndexBtn = document.getElementById("rebuild-index-btn");
const noteTreeEl = document.getElementById("note-tree");
const lensListEl = document.getElementById("lens-list");
const lifeSummaryEl = document.getElementById("life-summary");
const noteTitleEl = document.getElementById("note-title");
const noteBodyEl = document.getElementById("note-body");
const searchInputEl = document.getElementById("search");
const searchResultsEl = document.getElementById("search-results");
const newNoteBtn = document.getElementById("new-note-btn");
const modeReviewBtn = document.getElementById("mode-review-btn");
const modeCaptureBtn = document.getElementById("mode-capture-btn");
const modeSynthesizeBtn = document.getElementById("mode-synthesize-btn");
const modeHintEl = document.getElementById("mode-hint");
const metricQueueEl = document.getElementById("metric-queue");
const metricLoopsEl = document.getElementById("metric-loops");
const metricFocusEl = document.getElementById("metric-focus");
const memoryListEl = document.getElementById("memory-list");
const captureRitualsEl = document.getElementById("capture-rituals");
const chatInputEl = document.getElementById("chat-input");
const chatThreadEl = document.getElementById("chat-thread");
const chatModelSelectEl = document.getElementById("chat-model-select");
const deleteDialogEl = document.getElementById("delete-dialog");
const deleteConfirmBtn = document.getElementById("delete-confirm-btn");
const deleteNoteNameEl = document.getElementById("delete-note-name");

let notes = [];
let currentPath = null;
let saveTimer = null;
let searchTimer = null;
/** Set of folder paths (e.g. "folder", "folder/sub") that are expanded */
let expandedFolders = new Set();
let indexUsable = true;
let indexErrorMessage = null;
let activeLens = "all";
let activeMode = "review";
let pendingDeletePath = null;
let memoryCards = [];
let memoryEngineMessage = null;
const LIFE_LENSES = [
  {
    id: "all",
    label: "all life",
    keywords: [],
  },
  {
    id: "self",
    label: "self",
    keywords: ["journal", "reflect", "mind", "self", "emotion", "personal"],
  },
  {
    id: "work",
    label: "work",
    keywords: ["work", "career", "project", "meeting", "client", "task"],
  },
  {
    id: "health",
    label: "health",
    keywords: ["health", "fitness", "sleep", "workout", "meal", "run", "meditation"],
  },
  {
    id: "relationships",
    label: "relationships",
    keywords: ["family", "friend", "partner", "relationship", "team", "people"],
  },
  {
    id: "money",
    label: "money",
    keywords: ["money", "finance", "budget", "expense", "invest", "salary"],
  },
  {
    id: "home",
    label: "home",
    keywords: ["home", "house", "admin", "errand", "chore", "life"],
  },
  {
    id: "ideas",
    label: "ideas",
    keywords: ["idea", "research", "learn", "reading", "writing", "build"],
  },
];

function inferLensForNote(note) {
  const text = `${note.path} ${note.title || ""}`.toLowerCase();
  for (const lens of LIFE_LENSES) {
    if (lens.id === "all") continue;
    if (lens.keywords.some((kw) => text.includes(kw))) {
      return lens.id;
    }
  }
  return "ideas";
}

function getFilteredNotes() {
  if (activeLens === "all") return notes;
  return notes.filter((n) => inferLensForNote(n) === activeLens);
}

function renderLifeLenses() {
  if (!lensListEl) return;
  const counts = {};
  LIFE_LENSES.forEach((l) => {
    counts[l.id] = 0;
  });
  counts.all = notes.length;
  notes.forEach((n) => {
    const lens = inferLensForNote(n);
    counts[lens] = (counts[lens] || 0) + 1;
  });
  lensListEl.innerHTML = LIFE_LENSES.map((l) => {
    const isActive = l.id === activeLens;
    return `<button type="button" class="lens-btn${
      isActive ? " active" : ""
    }" data-lens="${l.id}" aria-pressed="${isActive ? "true" : "false"}">
      <span>${escapeHtml(l.label)}</span>
      <span class="lens-count">${counts[l.id] || 0}</span>
    </button>`;
  }).join("");

  if (lifeSummaryEl) {
    const visible = getFilteredNotes().length;
    lifeSummaryEl.textContent =
      activeLens === "all"
        ? `${notes.length} total notes`
        : `${visible} notes in ${activeLens}`;
  }
}

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function setSaveStatus(text) {
  if (!saveStatusEl) return;
  saveStatusEl.textContent = text || "";
}

function setMode(mode) {
  activeMode = mode;
  document.body.classList.remove("mode-review", "mode-capture", "mode-synthesize");
  document.body.classList.add(`mode-${mode}`);
  if (modeReviewBtn) modeReviewBtn.classList.toggle("active", mode === "review");
  if (modeCaptureBtn) modeCaptureBtn.classList.toggle("active", mode === "capture");
  if (modeSynthesizeBtn) modeSynthesizeBtn.classList.toggle("active", mode === "synthesize");
  if (modeReviewBtn) modeReviewBtn.setAttribute("aria-pressed", String(mode === "review"));
  if (modeCaptureBtn) modeCaptureBtn.setAttribute("aria-pressed", String(mode === "capture"));
  if (modeSynthesizeBtn) modeSynthesizeBtn.setAttribute("aria-pressed", String(mode === "synthesize"));
  if (modeHintEl) {
    if (mode === "review") {
      modeHintEl.textContent =
        "Review surfaced notes and keep your next move clear.";
    } else if (mode === "capture") {
      modeHintEl.textContent =
        "Capture quickly: choose a ritual template, then write in the editor.";
    } else {
      modeHintEl.textContent =
        "Synthesize: ask the assistant to connect notes and surface patterns.";
    }
  }
  if (mode === "capture" && noteTitleEl) {
    noteTitleEl.focus();
  }
  if (mode === "synthesize" && chatInputEl) {
    chatInputEl.focus();
  }
}

function updateWorkflowMetrics() {
  if (metricQueueEl) metricQueueEl.textContent = String(memoryCards.length || 0);
  if (metricLoopsEl) {
    const loops = memoryCards.reduce((sum, card) => sum + (Number(card.open_loops) || 0), 0);
    metricLoopsEl.textContent = String(loops);
  }
  if (metricFocusEl) {
    const selected = notes.find((n) => n.path === currentPath);
    metricFocusEl.textContent = selected ? selected.title || "untitled" : "none";
  }
}

async function initStatus() {
  try {
    const root = await invoke("get_notes_root");
    if (root) {
      setStatus(`notes: ${root}`);
      return true;
    } else {
      const entered = window.prompt(
        "Enter the full path to your notes folder to get started:"
      );
      if (entered && entered.trim()) {
        const savedRoot = await invoke("set_notes_root", { path: entered.trim() });
        setStatus(`notes: ${savedRoot}`);
        return true;
      }
      setStatus("no notes root configured.");
      return false;
    }
  } catch (e) {
    setStatus(String(e), true);
    return false;
  }
}

/** Build a tree from flat note list. Paths are relative, e.g. "foo/bar/note.md". */
function buildNoteTree(notesList) {
  const root = { type: "folder", name: "", path: "", children: [] };
  for (const n of notesList) {
    const parts = n.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const segment = parts[i];
      if (isLast) {
        current.children.push({
          type: "note",
          name: n.title || segment,
          path: n.path,
        });
      } else {
        let folder = current.children.find(
          (c) => c.type === "folder" && c.name === segment
        );
        if (!folder) {
          const folderPath = parts.slice(0, i + 1).join("/");
          folder = { type: "folder", name: segment, path: folderPath, children: [] };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }
  function sortNode(node) {
    if (!node.children) return node;
    node.children.sort((a, b) => {
      if (a.type === "folder" && b.type === "note") return -1;
      if (a.type === "note" && b.type === "folder") return 1;
      return (a.name || a.path || "").localeCompare(b.name || b.path || "", undefined, { sensitivity: "base" });
    });
    node.children.forEach(sortNode);
    return node;
  }
  sortNode(root);
  return root;
}

function renderTreeLevel(node, folderPathPrefix = "") {
  if (!node.children || node.children.length === 0) return "";
  const parts = [];
  for (const c of node.children) {
    if (c.type === "folder") {
      const pathKey = folderPathPrefix ? `${folderPathPrefix}/${c.name}` : c.name;
      const isExpanded = expandedFolders.has(pathKey);
      parts.push(
        `<button type="button" class="tree-folder" data-folder="${encodeURIComponent(pathKey)}">
          <span class="tree-folder-prefix">${isExpanded ? "v" : ">"}</span>
          <span class="tree-folder-name">${escapeHtml(c.name)}</span>
        </button>`
      );
      if (isExpanded) {
        const childHtml = renderTreeLevel(c, pathKey);
        if (childHtml) {
          parts.push(`<div class="tree-children">${childHtml}</div>`);
        }
      }
    } else {
      const active = c.path === currentPath ? " active" : "";
      parts.push(
        `<div class="tree-note${active}">
          <button type="button" class="tree-note-open" data-path="${encodeURIComponent(c.path)}">
            <span class="tree-note-prefix">—</span>
            <span class="tree-note-title" title="${escapeHtml(c.path)}">${escapeHtml(c.name)}</span>
          </button>
          <button type="button" class="tree-note-delete" aria-label="Delete note ${escapeHtml(
            c.name
          )}" data-path="${encodeURIComponent(c.path)}">×</button>
        </div>`
      );
    }
  }
  return parts.join("");
}

function renderNoteTree() {
  if (!noteTreeEl) return;
  if (!notes.length) {
    noteTreeEl.innerHTML = `<div class="muted">no notes yet. press + new note.</div>`;
    return;
  }
  const filtered = getFilteredNotes();
  if (!filtered.length) {
    noteTreeEl.innerHTML = `<div class="muted">no notes in this lens. choose another lens.</div>`;
    return;
  }
  // Keep ancestors of current note expanded so it stays visible
  if (currentPath) {
    const parts = currentPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      expandedFolders.add(parts.slice(0, i).join("/"));
    }
  }
  const tree = buildNoteTree(filtered);
  noteTreeEl.innerHTML = renderTreeLevel(tree);
}

function bindNoteTreeEvents() {
  if (!noteTreeEl) return;
  noteTreeEl.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const deletePath = target.closest(".tree-note-delete")?.dataset.path;
    if (target.closest(".tree-note-delete") && deletePath) {
      e.stopPropagation();
      showDeleteDialog(decodeURIComponent(deletePath));
      return;
    }
    const folderKey = target.closest(".tree-folder")?.dataset.folder;
    if (folderKey) {
      const key = decodeURIComponent(folderKey);
      if (expandedFolders.has(key)) {
        expandedFolders.delete(key);
      } else {
        expandedFolders.add(key);
      }
      renderNoteTree();
      return;
    }
    const notePath = target.closest(".tree-note-open")?.dataset.path;
    if (notePath) {
      await openNote(decodeURIComponent(notePath));
    }
  });
}

async function loadNotes() {
  try {
    const list = await invoke("list_notes");
    notes = Array.isArray(list) ? list : [];
    await refreshMemoryOverview();
    renderLifeLenses();
    renderMemoryCues();
    renderNoteTree();
    updateWorkflowMetrics();
    if (!currentPath && notes.length > 0) {
      await openNote(notes[0].path);
    } else if (currentPath && notes.every((n) => n.path !== currentPath)) {
      // current note was deleted
      currentPath = null;
      clearEditor();
    }
  } catch (e) {
    noteTreeEl.innerHTML = `<div class="error">${escapeHtml(String(e))}</div>`;
  }
}

function clearEditor() {
  currentPath = null;
  if (noteTitleEl) noteTitleEl.value = "";
  if (noteBodyEl) noteBodyEl.value = "";
  setSaveStatus("");
  updateWorkflowMetrics();
}

async function openNote(path) {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const detail = await invoke("read_note", { path });
    currentPath = detail.path;
    if (noteTitleEl) noteTitleEl.value = detail.title || "";
    if (noteBodyEl) noteBodyEl.value = detail.body || "";
    setSaveStatus("");
    renderNoteTree();
    updateWorkflowMetrics();
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function createNote() {
  try {
    const detail = await invoke("create_note");
    currentPath = detail.path;
    if (noteTitleEl) noteTitleEl.value = detail.title || "";
    if (noteBodyEl) noteBodyEl.value = detail.body || "";
    setSaveStatus("");
    await loadNotes();
    focusTitle();
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function deleteNote(path) {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      setSaveStatus("");
    }
    await invoke("delete_note", { path });
    if (currentPath === path) {
      clearEditor();
    }
    await loadNotes();
  } catch (e) {
    setStatus(String(e), true);
  }
}

function focusTitle() {
  if (noteTitleEl) {
    noteTitleEl.focus();
    noteTitleEl.select();
  }
}

function scheduleSave() {
  if (!currentPath) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  setSaveStatus("saving...");
  saveTimer = setTimeout(async () => {
    try {
      await invoke("save_note", {
        path: currentPath,
        title: noteTitleEl ? noteTitleEl.value : "",
        body: noteBodyEl ? noteBodyEl.value : "",
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 2000);
      // keep list titles in sync
      const idx = notes.findIndex((n) => n.path === currentPath);
      if (idx !== -1 && noteTitleEl) {
        notes[idx].title = noteTitleEl.value || notes[idx].path;
        renderNoteTree();
      }
      await refreshMemoryOverview();
      renderLifeLenses();
      renderMemoryCues();
      updateWorkflowMetrics();
    } catch (e) {
      setSaveStatus("save failed");
      setStatus(String(e), true);
    }
  }, 500);
}

async function refreshMemoryOverview() {
  try {
    const overview = await invoke("memory_overview", { limit: 8 });
    memoryCards =
      overview && Array.isArray(overview.cards) ? overview.cards : [];
    memoryEngineMessage = null;
    updateWorkflowMetrics();
  } catch (e) {
    memoryCards = [];
    memoryEngineMessage = String(e);
    updateWorkflowMetrics();
  }
}

function renderMemoryCues() {
  if (!memoryListEl) return;
  if (memoryEngineMessage) {
    memoryListEl.innerHTML = `<div class="error">${escapeHtml(
      memoryEngineMessage
    )}</div>`;
    return;
  }
  if (!memoryCards.length) {
    memoryListEl.innerHTML = `<div class="muted">start by creating your first note.</div>`;
    return;
  }

  memoryListEl.innerHTML = memoryCards
    .map((card) => {
      const areas = Array.isArray(card.life_areas)
        ? card.life_areas.join(" · ")
        : "";
      const why =
        Array.isArray(card.rationale) && card.rationale.length > 0
          ? card.rationale[0]
          : "ranked by memory salience";
      const salience =
        typeof card.salience === "number"
          ? `${(card.salience * 100).toFixed(0)}%`
          : "";
      return `<button type="button" class="memory-item memory-card" data-open-path="${encodeURIComponent(
        card.note_path || ""
      )}">
        <span class="memory-item-title">${escapeHtml(
          card.title || card.note_path || "untitled"
        )}</span>
        <span class="memory-item-meta">${escapeHtml(areas)}</span>
        <span class="memory-item-why">${escapeHtml(why)}</span>
        <span class="memory-item-score">${escapeHtml(salience)}</span>
      </button>`;
    })
    .join("");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function renderSearchResults(results, query) {
  if (!searchResultsEl) return;
  searchResultsEl.setAttribute("aria-hidden", "false");
  if (!results || results.length === 0) {
    searchResultsEl.innerHTML = `<div class="muted">no matches for "${escapeHtml(query)}"</div>`;
    searchResultsEl.classList.remove("hidden");
    return;
  }
  const lower = query.toLowerCase();
  const items = results
    .map((r) => {
      const preview = r.preview || "";
      const idx = preview.toLowerCase().indexOf(lower);
      let highlighted = escapeHtml(preview);
      if (idx !== -1 && query.length > 0) {
        const before = escapeHtml(preview.slice(0, idx));
        const match = escapeHtml(preview.slice(idx, idx + query.length));
        const after = escapeHtml(preview.slice(idx + query.length));
        highlighted = `${before}<span class="highlight">${match}</span>${after}`;
      }
      return `
        <button type="button" class="search-result-item" data-path="${encodeURIComponent(r.note_path)}">
          <div class="search-result-path">${escapeHtml(r.note_path)}</div>
          <p class="search-result-preview">${highlighted}</p>
          <div class="search-result-score">${(r.score * 100).toFixed(0)}%</div>
        </button>
      `;
    })
    .join("");
  searchResultsEl.innerHTML = items;
  searchResultsEl.classList.remove("hidden");
}

function bindSearchEvents() {
  if (!searchInputEl) return;
  searchInputEl.addEventListener("input", () => {
    const q = searchInputEl.value.trim();
    if (!indexUsable) {
      if (searchResultsEl) {
        const msg =
          indexErrorMessage ||
          "index not ready. rebuild index in the app.";
        searchResultsEl.innerHTML = `<div class="muted">${escapeHtml(msg)}</div>`;
        searchResultsEl.classList.remove("hidden");
        searchResultsEl.setAttribute("aria-hidden", "false");
      }
      return;
    }
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      if (searchResultsEl) {
        searchResultsEl.classList.add("hidden");
        searchResultsEl.setAttribute("aria-hidden", "true");
      }
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const results = await invoke("query", { query: q, k: 16 });
        renderSearchResults(results, q);
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("Rebuild the index in the app") ||
          msg.includes("Could not determine index path") ||
          msg.includes("Index is empty")
        ) {
          indexUsable = false;
          indexErrorMessage = "index not built. rebuild index in the app.";
        }
        if (searchResultsEl) {
          const display = indexErrorMessage || msg;
          searchResultsEl.innerHTML = `<div class="error">${escapeHtml(display)}</div>`;
          searchResultsEl.classList.remove("hidden");
          searchResultsEl.setAttribute("aria-hidden", "false");
        }
      }
    }, 200);
  });

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInputEl.value = "";
      if (searchResultsEl) {
        searchResultsEl.classList.add("hidden");
        searchResultsEl.setAttribute("aria-hidden", "true");
      }
      searchInputEl.blur();
    }
  });

  if (searchResultsEl) {
    searchResultsEl.addEventListener("click", async (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest(".search-result-item");
      if (item) {
        const path = item.dataset.path;
        if (path) {
          if (searchResultsEl) {
            searchResultsEl.classList.add("hidden");
            searchResultsEl.setAttribute("aria-hidden", "true");
          }
          searchInputEl.value = "";
          await openNote(decodeURIComponent(path));
        }
      }
    });
  }
}

function bindLifeLensEvents() {
  if (!lensListEl) return;
  lensListEl.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const lens = target.closest(".lens-btn")?.dataset.lens;
    if (!lens) return;
    activeLens = lens;
    renderLifeLenses();
    renderNoteTree();
  });
}

function bindMemoryCueEvents() {
  if (!memoryListEl) return;
  memoryListEl.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const path = target.closest(".memory-item")?.dataset.openPath;
    if (!path) return;
    await openNote(decodeURIComponent(path));
  });
}

function getCaptureTemplate(kind) {
  const date = new Date().toISOString().slice(0, 10);
  if (kind === "reflection") {
    return {
      title: `Reflection - ${date}`,
      body: "What happened?\n\nWhat mattered?\n\nWhat to carry forward?",
    };
  }
  if (kind === "decision") {
    return {
      title: `Decision Log - ${date}`,
      body: "Decision:\n\nContext:\n\nOptions considered:\n\nWhy this choice:\n\nFollow-up date:",
    };
  }
  return {
    title: `Memory Snapshot - ${date}`,
    body: "Moment:\n\nWho was there:\n\nWhy this might matter later:\n\n1 sentence summary:",
  };
}

async function createTemplatedNote(kind) {
  try {
    const detail = await invoke("create_note");
    const template = getCaptureTemplate(kind);
    await invoke("save_note", {
      path: detail.path,
      title: template.title,
      body: template.body,
    });
    await loadNotes();
    await openNote(detail.path);
    focusTitle();
  } catch (e) {
    setStatus(String(e), true);
  }
}

function bindCaptureRituals() {
  if (!captureRitualsEl) return;
  captureRitualsEl.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const kind = target.closest(".ritual-btn")?.dataset.template;
    if (!kind) return;
    await createTemplatedNote(kind);
  });
}

function showDeleteDialog(path) {
  pendingDeletePath = path;
  if (deleteNoteNameEl) {
    deleteNoteNameEl.textContent = ` (${path})`;
  }
  if (deleteDialogEl && typeof deleteDialogEl.showModal === "function") {
    deleteDialogEl.showModal();
    return;
  }
  if (window.confirm(`Delete this note?\n${path}`)) {
    deleteNote(path);
  }
}

function bindDeleteDialog() {
  if (!deleteDialogEl || !deleteConfirmBtn) return;
  deleteConfirmBtn.addEventListener("click", async () => {
    const toDelete = pendingDeletePath;
    pendingDeletePath = null;
    deleteDialogEl.close("confirm");
    if (toDelete) {
      await deleteNote(toDelete);
    }
  });
  deleteDialogEl.addEventListener("close", () => {
    pendingDeletePath = null;
  });
}

function bindEditorEvents() {
  if (noteTitleEl) {
    noteTitleEl.addEventListener("input", scheduleSave);
  }
  if (noteBodyEl) {
    noteBodyEl.addEventListener("input", scheduleSave);
  }
}

function bindNewNoteButton() {
  if (!newNoteBtn) return;
  newNoteBtn.addEventListener("click", () => {
    createNote();
  });
}

function bindRebuildIndexButton() {
  if (!rebuildIndexBtn) return;
  rebuildIndexBtn.addEventListener("click", async () => {
    rebuildIndexBtn.disabled = true;
    setStatus("rebuilding index... this may take a minute");
    try {
      const message = await invoke("rebuild_index");
      indexUsable = true;
      indexErrorMessage = null;
      await loadNotes();
      setStatus(typeof message === "string" && message ? message : "index rebuilt");
    } catch (e) {
      const msg = String(e);
      setStatus(msg, true);
      if (msg.toLowerCase().includes("index")) {
        indexUsable = false;
        indexErrorMessage = msg;
      }
    } finally {
      rebuildIndexBtn.disabled = false;
    }
  });
}

function bindModeButtons() {
  if (modeReviewBtn) {
    modeReviewBtn.addEventListener("click", () => setMode("review"));
  }
  if (modeCaptureBtn) {
    modeCaptureBtn.addEventListener("click", () => setMode("capture"));
  }
  if (modeSynthesizeBtn) {
    modeSynthesizeBtn.addEventListener("click", () => setMode("synthesize"));
  }
}

function bindChat() {
  if (!chatInputEl || !chatThreadEl) return;
  chatInputEl.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = chatInputEl.value.trim();
      if (!text) return;
      appendChatMessage("user", text);
      chatInputEl.value = "";
      if (!indexUsable) {
        appendChatMessage(
          "agent",
          "index not built. rebuild index in the app."
        );
        return;
      }
      const pending = appendChatMessage("agent", "thinking...");
      const selectedModel =
        (chatModelSelectEl && chatModelSelectEl.value.trim()) || "";
      try {
        const resp = await invoke("ask", {
          question: text,
          k: 6,
          model: selectedModel || null,
        });
        pending?.remove();
        if (!resp || !resp.answer) {
          appendChatMessage(
            "agent",
            "no answer. check that index has been rebuilt and Ollama is running."
          );
          return;
        }
        appendChatAnswer(resp.answer, resp.sources || []);
      } catch (err) {
        pending?.remove();
        const msg = String(err);
        if (
          msg.includes("Rebuild the index in the app") ||
          msg.includes("Index is empty") ||
          msg.includes("Could not determine index path")
        ) {
          indexUsable = false;
          indexErrorMessage =
            "index not built. rebuild index in the app.";
          appendChatMessage("agent", indexErrorMessage);
        } else {
          appendChatMessage("agent", msg);
        }
      }
    }
  });
}

function appendChatMessage(kind, text) {
  const div = document.createElement("div");
  div.className = `chat-message ${kind}`;
  div.textContent = text;
  chatThreadEl.appendChild(div);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
  return div;
}

function appendChatAnswer(answer, sources) {
  if (!chatThreadEl) return;
  const container = document.createElement("div");
  container.className = "chat-message agent";

  const body = document.createElement("div");
  body.className = "chat-answer-text";
  body.textContent = answer;
  container.appendChild(body);

  if (Array.isArray(sources) && sources.length > 0) {
    const sourcesDiv = document.createElement("div");
    sourcesDiv.className = "chat-sources";

    const label = document.createElement("span");
    label.className = "chat-sources-label";
    label.textContent = "sources:";
    sourcesDiv.appendChild(label);

    sources.forEach((s, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-source-link";
      const sourceLabel = s.title || s.note_path || `source ${idx + 1}`;
      btn.textContent = `[${idx + 1}]`;
      btn.title = sourceLabel;
      btn.setAttribute("aria-label", `Open source ${idx + 1}: ${sourceLabel}`);
      btn.addEventListener("click", () => {
        if (s.note_path) {
          openNote(s.note_path);
        }
      });
      sourcesDiv.appendChild(btn);
    });

    container.appendChild(sourcesDiv);
  }

  chatThreadEl.appendChild(container);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

async function initChatModels() {
  if (!chatModelSelectEl) return;
  try {
    const models = await invoke("list_chat_models");
    chatModelSelectEl.innerHTML = "";

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "default (config)";
    chatModelSelectEl.appendChild(defaultOpt);

    if (Array.isArray(models)) {
      models.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        chatModelSelectEl.appendChild(opt);
      });
    }
  } catch (_e) {
    chatModelSelectEl.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "models unavailable";
    chatModelSelectEl.appendChild(opt);
    chatModelSelectEl.disabled = true;
  }
}

async function bootstrap() {
  const ready = await initStatus();
  bindNoteTreeEvents();
  bindEditorEvents();
  bindSearchEvents();
  bindLifeLensEvents();
  bindMemoryCueEvents();
  bindCaptureRituals();
  bindDeleteDialog();
  bindNewNoteButton();
  bindRebuildIndexButton();
  bindModeButtons();
  await initChatModels();
  bindChat();
  if (ready) {
    await loadNotes();
  } else {
    clearEditor();
    renderLifeLenses();
    renderMemoryCues();
    renderNoteTree();
    updateWorkflowMetrics();
  }
  setMode(activeMode);

  // Global shortcuts (macOS-first): cmd+n, cmd+k, cmd+j
  window.addEventListener("keydown", (e) => {
    if (!e.metaKey) return;
    const tag = (e.target && e.target.tagName) || "";
    const isEditable = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

    if (e.key === "n") {
      e.preventDefault();
      createNote();
    } else if (e.key === "k") {
      e.preventDefault();
      if (searchInputEl) {
        searchInputEl.focus();
        searchInputEl.select();
      }
    } else if (e.key === "j") {
      e.preventDefault();
      if (chatInputEl) {
        chatInputEl.focus();
        if (!chatInputEl.value) {
          chatInputEl.value = "";
        }
      }
    }
  });
}

bootstrap();
