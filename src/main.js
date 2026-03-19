// Noema – local-first AI-powered knowledge assistant.
// Minimal vanilla JS frontend: full-screen note canvas, floating sidebar,
// floating utility bar (search + ask) at bottom center.

import { invoke } from "@tauri-apps/api/core";
import "./style.css";

// ─── State ──────────────────────────────────────────

let notesRoot = null;
let notes = [];
let selectedNote = null;
let isDirty = false;
let saveTimer = null;
let saveStatus = "";

let sidebarVisible = false;
let sidebarTimer = null;
let selectedFolder = null;

let utilityQuery = "";
let filterResults = [];
let searchResults = [];
let searchError = "";
let isSearching = false;
let askResponse = null;
let isAsking = false;
let utilityMode = "idle";
let utilityFocused = false;

let chatModels = [];
let selectedModel = null;

let createPromise = null;

// ─── DOM refs (set once in renderApp) ───────────────

let canvasEl = null;
let sidebarEl = null;
let folderListEl = null;
let noteListEl = null;
let utilityInputEl = null;
let utilityResultsEl = null;
let titleInputEl = null;
let bodyAreaEl = null;
let errorBarEl = null;

// ─── DOM helper ─────────────────────────────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "className") {
      el.className = v;
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "value" || k === "checked" || k === "disabled") {
      el[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return el;
}

// ─── Init ───────────────────────────────────────────

async function init() {
  try {
    notesRoot = await invoke("get_notes_root");
  } catch {
    notesRoot = null;
  }

  if (!notesRoot) {
    renderSetup();
    return;
  }

  await refreshNotes();
  await loadModels();
  renderApp();
}

async function refreshNotes() {
  try {
    notes = await invoke("list_notes");
  } catch {
    notes = [];
  }
}

async function loadModels() {
  try {
    chatModels = await invoke("list_chat_models");
    if (chatModels.length > 0 && !selectedModel) {
      selectedModel = chatModels[0];
    }
  } catch {
    chatModels = [];
  }
}

// ─── Setup view ─────────────────────────────────────

function renderSetup() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const errorEl = h("p", { className: "text-xs text-red-500 mt-3 hidden" });
  const input = h("input", {
    type: "text",
    placeholder: "/path/to/your/notes",
    "aria-label": "Notes folder path",
    className:
      "w-full py-1 text-sm border-b border-stone-300 bg-transparent focus:outline-none focus:border-stone-900",
  });

  async function submit() {
    const path = input.value.trim();
    if (!path) return;
    try {
      await invoke("set_notes_root", { path });
      notesRoot = path;
      await refreshNotes();
      renderApp();
    } catch (e) {
      errorEl.textContent = String(e);
      errorEl.classList.remove("hidden");
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  app.appendChild(
    h(
      "div",
      { className: "flex h-dvh items-center justify-center" },
      h(
        "div",
        { className: "w-full max-w-xs px-6" },
        h("h1", { className: "text-sm text-stone-900 mb-6" }, "noema"),
        input,
        errorEl,
        h(
          "button",
          {
            className:
              "text-xs text-stone-500 text-pretty mt-4 hover:text-stone-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
            onClick: submit,
          },
          "open \u2192",
        ),
      ),
    ),
  );

  input.focus();
}

// ─── Main app layout ────────────────────────────────

function renderApp() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  // Error bar
  errorBarEl = h("div", {
    role: "alert",
    className:
      "fixed top-4 left-1/2 -translate-x-1/2 text-xs text-red-500 z-30 hidden",
  });

  // Canvas
  canvasEl = h("main", { className: "h-dvh flex flex-col" });

  // Sidebar hover trigger
  const sidebarTrigger = h("div", {
    className: "fixed left-0 top-0 bottom-0 w-8 z-10",
    onMouseenter: onSidebarEnter,
  });

  // Sidebar panel — two-column layout
  folderListEl = h("div", {
    className: "w-40 border-r border-stone-100 pt-4 pb-2 overflow-y-auto shrink-0",
  });
  noteListEl = h("div", {
    className: "flex-1 pt-4 pb-2 overflow-y-auto",
  });
  sidebarEl = h(
    "aside",
    {
      className:
        "fixed left-4 top-4 bottom-4 w-96 bg-white border border-stone-200 rounded-xl shadow-sm z-10 sidebar-slide -translate-x-[calc(100%+32px)] flex flex-col",
      onMouseenter: onSidebarEnter,
      onMouseleave: onSidebarLeave,
    },
    h("div", { className: "flex flex-1 min-h-0" }, folderListEl, noteListEl),
    h(
      "div",
      { className: "border-t border-stone-100 px-4 py-3 flex gap-4" },
      h(
        "button",
        {
          className:
            "text-sm text-stone-400 hover:text-stone-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
          onClick: showNewFolderInput,
        },
        "+ new folder",
      ),
      h(
        "button",
        {
          className:
            "text-sm text-stone-400 hover:text-stone-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
          onClick: rebuildIndex,
        },
        "rebuild index",
      ),
    ),
  );

  // Utility bar
  utilityInputEl = h("input", {
    type: "text",
    placeholder: "search or ?ask\u2026",
    "aria-label": "Search or ask",
    className:
      "w-full px-5 py-3 text-sm bg-transparent focus:outline-none placeholder:text-stone-300",
  });
  utilityInputEl.addEventListener("input", onUtilityInput);
  utilityInputEl.addEventListener("keydown", onUtilityKeydown);
  utilityInputEl.addEventListener("focus", () => {
    utilityFocused = true;
    updateUtilityPanel();
  });
  utilityInputEl.addEventListener("blur", () => {
    setTimeout(() => {
      if (panelHover) return;
      utilityFocused = false;
      updateUtilityPanel();
    }, 150);
  });

  utilityResultsEl = h("div", { className: "hidden mb-1" });
  let panelHover = false;
  utilityResultsEl.addEventListener("mouseenter", () => { panelHover = true; });
  utilityResultsEl.addEventListener("mouseleave", () => {
    panelHover = false;
    if (!utilityInputEl.matches(":focus")) {
      utilityFocused = false;
      updateUtilityPanel();
    }
  });

  const newNoteBarBtn = h("button", {
    className:
      "shrink-0 px-4 text-sm text-stone-300 hover:text-stone-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
    "aria-label": "New note",
    onClick: () => newNote(),
  }, "+");

  const utilityBar = h(
    "div",
    {
      className:
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-20 w-full max-w-lg px-6",
    },
    utilityResultsEl,
    h(
      "div",
      { className: "border border-stone-200 rounded-lg bg-white shadow-sm flex items-center" },
      utilityInputEl,
      newNoteBarBtn,
    ),
  );

  // Delete dialog
  const deleteDialog = h(
    "dialog",
    {
      id: "delete-dialog",
      className: "m-auto rounded-xl p-8 shadow-lg backdrop:bg-black/10 max-w-xs",
    },
    h("p", { className: "text-sm text-stone-900 text-center mb-1" }, "delete this note?"),
    h(
      "p",
      { className: "text-sm text-stone-400 text-pretty text-center mb-8" },
      "this cannot be undone.",
    ),
    h(
      "div",
      { className: "flex justify-center gap-6" },
      h(
        "button",
        {
          className:
            "text-sm text-stone-400 hover:text-stone-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
          onClick: () => document.getElementById("delete-dialog").close(),
        },
        "cancel",
      ),
      h(
        "button",
        {
          className:
            "text-sm text-red-500 hover:text-red-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400 rounded",
          onClick: doDelete,
        },
        "delete",
      ),
    ),
  );

  app.appendChild(errorBarEl);
  app.appendChild(canvasEl);
  app.appendChild(sidebarTrigger);
  app.appendChild(sidebarEl);
  app.appendChild(utilityBar);
  app.appendChild(deleteDialog);

  updateCanvas();
  updateSidebarContent();
}

// ─── Canvas ─────────────────────────────────────────

function updateCanvas() {
  if (!canvasEl) return;
  canvasEl.innerHTML = "";

  titleInputEl = h("input", {
    type: "text",
    value: selectedNote?.title ?? "",
    placeholder: "Untitled",
    "aria-label": "Note title",
    className:
      "w-full text-base font-medium text-stone-900 bg-transparent focus:outline-none placeholder:text-stone-300 text-balance",
  });

  bodyAreaEl = h("textarea", {
    "aria-label": "Note body",
    className:
      "flex-1 w-full min-h-0 text-sm text-stone-600 bg-transparent resize-none focus:outline-none placeholder:text-stone-300 leading-relaxed",
  });
  bodyAreaEl.value = selectedNote?.body ?? "";

  titleInputEl.addEventListener("input", onTitleInput);
  titleInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      bodyAreaEl.focus();
    }
  });
  bodyAreaEl.addEventListener("input", onBodyInput);

  const statusItems = [];
  if (saveStatus) {
    const isError = saveStatus.startsWith("Error");
    let label = saveStatus;
    if (saveStatus === "saved") label = "saved";
    else if (saveStatus === "saving") label = "saving\u2026";
    statusItems.push(
      h(
        "span",
        { className: `text-xs ${isError ? "text-red-500" : "text-stone-400"}` },
        label,
      ),
    );
  }
  if (selectedNote) {
    statusItems.push(
      h(
        "button",
        {
          className:
            "text-xs text-stone-400 hover:text-red-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded px-1 py-0.5",
          onClick: () =>
            document.getElementById("delete-dialog")?.showModal(),
          "aria-label": "Delete note",
        },
        "delete",
      ),
    );
  }

  const statusLine = h(
    "div",
    {
      className: "flex justify-end items-center gap-3 mb-6 min-h-5",
      "data-status-line": "",
    },
    ...statusItems,
  );

  canvasEl.appendChild(
    h(
      "div",
      { className: "flex-1 flex flex-col pt-12 pb-24 px-8" },
      h(
        "div",
        { className: "w-full max-w-xl mx-auto flex flex-col flex-1" },
        statusLine,
        titleInputEl,
        h("div", { className: "mt-4 flex-1 flex flex-col" }, bodyAreaEl),
      ),
    ),
  );

  if (!selectedNote?.title) {
    titleInputEl.focus();
  }
}

async function onTitleInput() {
  await ensureNote();
  if (!selectedNote) return;
  selectedNote.title = titleInputEl.value;
  scheduleSave();
}

async function onBodyInput() {
  await ensureNote();
  if (!selectedNote) return;
  selectedNote.body = bodyAreaEl.value;
  scheduleSave();
}

async function ensureNote() {
  if (selectedNote) return;
  if (createPromise) {
    await createPromise;
    return;
  }
  const folder =
    selectedFolder && selectedFolder !== "__root__" ? selectedFolder : null;
  createPromise = (async () => {
    try {
      selectedNote = await invoke("create_note", { folder });
      await refreshNotes();
      updateSidebarContent();
    } catch (e) {
      showError("Failed to create note: " + e);
    }
  })();
  await createPromise;
  createPromise = null;
}

// ─── Sidebar ────────────────────────────────────────

function slideSidebar(visible) {
  sidebarVisible = visible;
  sidebarEl.style.transition = visible
    ? "translate 1200ms cubic-bezier(0.22, 1, 0.36, 1)"
    : "translate 400ms cubic-bezier(0.4, 0, 0.2, 1)";
  if (visible) {
    sidebarEl.classList.remove("-translate-x-[calc(100%+32px)]");
    sidebarEl.classList.add("translate-x-0");
  } else {
    sidebarEl.classList.add("-translate-x-[calc(100%+32px)]");
    sidebarEl.classList.remove("translate-x-0");
  }
}

function onSidebarEnter() {
  clearTimeout(sidebarTimer);
  if (!sidebarVisible) slideSidebar(true);
}

function onSidebarLeave() {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => slideSidebar(false), 500);
}

function toggleSidebar() {
  clearTimeout(sidebarTimer);
  slideSidebar(!sidebarVisible);
}

function showNewFolderInput() {
  if (!folderListEl) return;
  const existing = folderListEl.querySelector("[data-folder-input]");
  if (existing) {
    existing.focus();
    return;
  }

  const input = h("input", {
    type: "text",
    placeholder: "folder name",
    "aria-label": "New folder name",
    "data-folder-input": "",
    className:
      "w-full px-4 py-1 mt-1 text-sm border-b border-stone-300 bg-transparent focus:outline-none focus:border-stone-900 placeholder:text-stone-300",
  });

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const name = input.value.trim();
      if (name) await createFolder(name);
      input.remove();
    }
    if (e.key === "Escape") input.remove();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => input.remove(), 150);
  });

  folderListEl.appendChild(input);
  input.focus();
}

function noteDisplayName(note) {
  const t = note.title?.trim();
  if (!t || t === note.path || /^note-\d+/.test(t)) return "new note";
  return t;
}

function buildTree(notesList) {
  const root = { folders: new Map(), files: [] };
  for (const note of notesList) {
    const segments = note.path.split("/");
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dir = segments[i];
      if (!node.folders.has(dir)) {
        node.folders.set(dir, { folders: new Map(), files: [] });
      }
      node = node.folders.get(dir);
    }
    node.files.push(note);
  }
  return root;
}

function countNotes(node) {
  let total = node.files.length;
  for (const child of node.folders.values()) {
    total += countNotes(child);
  }
  return total;
}

function collectNotes(node) {
  const result = [...node.files];
  for (const child of node.folders.values()) {
    result.push(...collectNotes(child));
  }
  return result;
}

const sidebarBtnBase =
  "block w-full text-left px-4 py-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded";

function makeFolderBtn(label, count, folderKey, depth = 0) {
  const active = selectedFolder === folderKey;
  const btn = h(
    "button",
    {
      className: `${sidebarBtnBase} transition-colors ${active ? "text-stone-900" : "text-stone-400 hover:text-stone-700"}`,
      style: { paddingLeft: `${16 + depth * 12}px` },
      onClick: () => {
        selectedFolder = folderKey;
        updateSidebarContent();
      },
    },
    h(
      "span",
      { className: "flex justify-between pointer-events-none" },
      h("span", { className: "truncate" }, label),
      h(
        "span",
        { className: "tabular-nums text-stone-300 ml-2" },
        String(count),
      ),
    ),
  );

  return btn;
}

function rootFolderName() {
  if (!notesRoot) return "noema";
  const parts = notesRoot.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.pop() || "noema";
}

function renderFolderList(tree) {
  folderListEl.appendChild(
    makeFolderBtn(rootFolderName(), notes.length, null, 0),
  );

  function renderFolderNode(node, prefix, depth) {
    for (const [name, child] of node.folders) {
      const folderKey = prefix ? `${prefix}/${name}` : name;
      folderListEl.appendChild(
        makeFolderBtn(name, countNotes(child), folderKey, depth),
      );
      renderFolderNode(child, folderKey, depth + 1);
    }
  }

  renderFolderNode(tree, "", 1);
}

function getFolderNodeByKey(tree, folderKey) {
  if (!folderKey) return tree;
  const segments = folderKey.split("/").filter(Boolean);
  let node = tree;
  for (const seg of segments) {
    const next = node.folders.get(seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

function getDisplayNotes(tree) {
  if (selectedFolder === null) return notes;
  const folderNode = getFolderNodeByKey(tree, selectedFolder);
  return folderNode ? collectNotes(folderNode) : [];
}

function renderNoteList(displayNotes) {
  if (displayNotes.length === 0) {
    noteListEl.appendChild(
      h("p", { className: "px-4 text-sm text-stone-400" }, "no notes."),
    );
    return;
  }

  for (const note of displayNotes) {
    const active = selectedNote?.path === note.path;
    const label = noteDisplayName(note);
    const item = h(
      "div",
      {
        role: "button",
        tabindex: "0",
        className: `${sidebarBtnBase} truncate ${active ? "text-stone-900 bg-stone-100" : "text-stone-500 hover:text-stone-900"}`,
        onClick: () => selectNote(note.path),
      },
      label,
    );
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectNote(note.path);
      }
    });

    noteListEl.appendChild(item);
  }
}

function updateSidebarContent() {
  if (!folderListEl || !noteListEl) return;
  folderListEl.innerHTML = "";
  noteListEl.innerHTML = "";

  const tree = buildTree(notes);
  renderFolderList(tree);
  renderNoteList(getDisplayNotes(tree));
}

// ─── Utility bar ────────────────────────────────────

function onUtilityInput() {
  utilityQuery = utilityInputEl.value;

  if (!utilityQuery.trim()) {
    clearUtilityResults();
    return;
  }

  if (utilityQuery.startsWith("?")) {
    utilityMode = "ask";
    filterResults = [];
    updateUtilityPanel();
    return;
  }

  utilityMode = "filter";
  const q = utilityQuery.toLowerCase();
  filterResults = notes
    .filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q),
    )
    .slice(0, 8);
  updateUtilityPanel();
}

async function onUtilityKeydown(e) {
  if (e.key === "Escape") {
    utilityInputEl.value = "";
    utilityInputEl.blur();
    clearUtilityResults();
    return;
  }

  if (e.key !== "Enter" || !utilityQuery.trim()) return;
  e.preventDefault();

  if (utilityQuery.startsWith("?")) {
    const question = utilityQuery.slice(1).trim();
    if (question) await doAsk(question);
  } else {
    await doSearch(utilityQuery.trim());
  }
}

function resultCard(...children) {
  return h(
    "div",
    {
      className:
        "border border-stone-200 rounded-lg bg-white shadow-sm px-5 py-3",
    },
    ...children,
  );
}

function renderAskPanel() {
  if (isAsking) return resultCard(h("p", { className: "text-sm text-stone-400" }, "thinking\u2026"));

  if (askResponse?.error) {
    const showRebuild =
      askResponse.error.toLowerCase().includes("index") ||
      askResponse.error.toLowerCase().includes("rebuild");
    return resultCard(
      h("p", { className: "text-sm text-red-500 text-pretty" }, askResponse.error),
      showRebuild
        ? h("button", { className: "text-sm text-red-400 underline mt-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400 rounded", onClick: rebuildIndex }, "rebuild index")
        : null,
    );
  }

  if (askResponse?.answer) {
    const items = [
      h("p", { className: "text-sm text-stone-700 leading-relaxed text-pretty whitespace-pre-wrap" }, askResponse.answer),
    ];
    if (askResponse.sources?.length > 0) {
      items.push(
        h("div", { className: "mt-3 pt-2 border-t border-stone-100" },
          ...askResponse.sources.map((s, i) =>
            h("button", {
              className: "block text-sm text-stone-400 hover:text-stone-700 py-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
              onClick: () => { selectNote(s.note_path); clearUtility(); },
            }, `[${i + 1}] ${s.title || s.note_path}`),
          ),
        ),
      );
    }
    return h("div", { className: "border border-stone-200 rounded-lg bg-white shadow-sm px-5 py-3 max-h-64 overflow-y-auto" }, ...items);
  }

  return h("div", { className: "border border-stone-200 rounded-lg bg-white shadow-sm px-5 py-2.5" },
    h("p", { className: "text-sm text-stone-300" }, "press enter to ask"),
  );
}

function renderSearchPanel() {
  if (isSearching) return resultCard(h("p", { className: "text-sm text-stone-400" }, "searching\u2026"));

  if (searchError) {
    return resultCard(
      h("p", { className: "text-sm text-red-500 text-pretty" }, searchError),
      h("button", { className: "text-sm text-red-400 underline mt-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400 rounded", onClick: rebuildIndex }, "rebuild index"),
    );
  }

  if (searchResults.length === 0) return resultCard(h("p", { className: "text-sm text-stone-400" }, "no results found."));

  return h("div", { className: "border border-stone-200 rounded-lg bg-white shadow-sm overflow-hidden max-h-64 overflow-y-auto" },
    ...searchResults.map((r) =>
      h("button", {
        className: "block w-full text-left px-5 py-2.5 text-sm hover:bg-stone-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
        onClick: () => { selectNote(r.note_path); clearUtility(); },
      },
        h("span", { className: "text-stone-700" }, r.note_path.replace(/\.md$/i, "")),
        h("span", { className: "text-stone-300 tabular-nums ml-2" }, r.score.toFixed(2)),
        r.preview ? h("p", { className: "text-stone-400 truncate mt-0.5 text-pretty" }, r.preview) : null,
      ),
    ),
  );
}

function renderFilterPanel() {
  const noteItems = filterResults.map((note) => {
    const label = noteDisplayName(note);
    const folder = note.path.includes("/") ? note.path.split("/").slice(0, -1).join("/") : null;
    return h("button", {
      className: "block w-full text-left px-5 py-2.5 text-sm text-stone-600 hover:text-stone-900 hover:bg-stone-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
      onClick: () => { selectNote(note.path); clearUtility(); },
    },
      label,
      folder ? h("span", { className: "text-stone-300 ml-2" }, folder) : null,
    );
  });

  return h("div", { className: "border border-stone-200 rounded-lg bg-white shadow-sm overflow-hidden" },
    ...noteItems,
  );
}

function renderDefaultPanel() {
  const items = [];

  if (chatModels.length > 0) {
    const modelLabel = selectedModel || chatModels[0];
    const modelRow = h(
      "div",
      { className: "flex items-center justify-between px-5 py-2.5" },
      h("span", { className: "text-sm text-stone-400" }, "model"),
      h("select", {
        className: "text-sm text-stone-600 bg-transparent focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded cursor-pointer",
        "aria-label": "Select chat model",
      },
        ...chatModels.map((m) =>
          h("option", { value: m, selected: m === modelLabel ? "selected" : null }, m),
        ),
      ),
    );
    const select = modelRow.querySelector("select");
    select.addEventListener("change", (e) => {
      selectedModel = e.target.value;
    });
    items.push(modelRow);
  }

  if (items.length === 0) return null;

  return h("div", {
    className: "border border-stone-200 rounded-lg bg-white shadow-sm overflow-hidden",
  }, ...items);
}

function updateUtilityPanel() {
  if (!utilityResultsEl) return;
  utilityResultsEl.innerHTML = "";

  if (utilityMode === "ask") {
    utilityResultsEl.classList.remove("hidden");
    utilityResultsEl.appendChild(renderAskPanel());
    return;
  }

  if (utilityMode === "search") {
    utilityResultsEl.classList.remove("hidden");
    utilityResultsEl.appendChild(renderSearchPanel());
    return;
  }

  if (utilityMode === "filter") {
    utilityResultsEl.classList.remove("hidden");
    utilityResultsEl.appendChild(renderFilterPanel());
    return;
  }

  if (utilityFocused && utilityMode === "idle") {
    const panel = renderDefaultPanel();
    if (panel) {
      utilityResultsEl.classList.remove("hidden");
      utilityResultsEl.appendChild(panel);
      return;
    }
  }

  utilityResultsEl.classList.add("hidden");
}

function clearUtilityResults() {
  utilityQuery = "";
  filterResults = [];
  searchResults = [];
  searchError = "";
  askResponse = null;
  utilityMode = "idle";
  isSearching = false;
  isAsking = false;
  updateUtilityPanel();
}

function clearUtility() {
  if (utilityInputEl) utilityInputEl.value = "";
  clearUtilityResults();
}

// ─── Actions ────────────────────────────────────────

async function selectNote(path) {
  if (selectedNote && isDirty) await flushSave();
  try {
    selectedNote = await invoke("read_note", { path });
    isDirty = false;
    saveStatus = "";
    updateCanvas();
    updateSidebarContent();
  } catch (e) {
    showError("Failed to read note: " + e);
  }
}

function scheduleSave() {
  isDirty = true;
  saveStatus = "";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

async function flushSave() {
  if (!selectedNote || !isDirty) return;
  clearTimeout(saveTimer);
  saveStatus = "saving";
  patchStatus();

  try {
    await invoke("save_note", {
      path: selectedNote.path,
      title: selectedNote.title,
      body: selectedNote.body,
    });
    isDirty = false;
    saveStatus = "saved";
    patchStatus();

    await refreshNotes();
    updateSidebarContent();

    setTimeout(() => {
      if (saveStatus === "saved") {
        saveStatus = "";
        patchStatus();
      }
    }, 2000);
  } catch (e) {
    saveStatus = "Error: " + e;
    patchStatus();
  }
}

function patchStatus() {
  const line = canvasEl?.querySelector("[data-status-line]");
  if (!line) return;
  line.innerHTML = "";

  if (saveStatus) {
    const isError = saveStatus.startsWith("Error");
    let label = saveStatus;
    if (saveStatus === "saved") label = "saved";
    else if (saveStatus === "saving") label = "saving\u2026";
    line.appendChild(
      h(
        "span",
        {
          className: `text-xs ${isError ? "text-red-500" : "text-stone-400"}`,
        },
        label,
      ),
    );
  }

  if (selectedNote) {
    line.appendChild(
      h(
        "button",
        {
          className:
            "text-xs text-stone-400 hover:text-red-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded px-1 py-0.5",
          onClick: () =>
            document.getElementById("delete-dialog")?.showModal(),
          "aria-label": "Delete note",
        },
        "delete",
      ),
    );
  }
}

async function doDelete() {
  document.getElementById("delete-dialog")?.close();
  if (!selectedNote) return;
  try {
    await invoke("delete_note", { path: selectedNote.path });
    selectedNote = null;
    isDirty = false;
    saveStatus = "";
    await refreshNotes();
    updateCanvas();
    updateSidebarContent();
  } catch (e) {
    showError("Failed to delete: " + e);
  }
}

async function newNote() {
  if (selectedNote && isDirty) await flushSave();
  selectedNote = null;
  isDirty = false;
  saveStatus = "";
  updateCanvas();
}

async function createFolder(name) {
  const safeName = name.trim().replaceAll(/[/\\]/g, "-");
  if (!safeName) return;
  const path = `${safeName}/untitled.md`;
  try {
    await invoke("save_note", { path, title: "", body: "" });
    await refreshNotes();
    updateSidebarContent();
    selectNote(path);
  } catch (e) {
    showError("Failed to create folder: " + e);
  }
}

async function doSearch(query) {
  utilityMode = "search";
  isSearching = true;
  searchResults = [];
  searchError = "";
  updateUtilityPanel();
  try {
    searchResults = await invoke("query", { query });
  } catch (e) {
    searchError = String(e);
  }
  isSearching = false;
  updateUtilityPanel();
}

async function doAsk(question) {
  utilityMode = "ask";
  isAsking = true;
  askResponse = null;
  updateUtilityPanel();
  try {
    const res = await invoke("ask", { question, model: selectedModel });
    askResponse = { answer: res.answer, sources: res.sources, error: "" };
  } catch (e) {
    askResponse = { answer: "", sources: [], error: String(e) };
  }
  isAsking = false;
  updateUtilityPanel();
}

async function rebuildIndex() {
  try {
    await invoke("rebuild_index");
  } catch (e) {
    showError("Rebuild failed: " + e);
  }
}

function showError(msg) {
  if (!errorBarEl) return;
  errorBarEl.textContent = msg;
  errorBarEl.classList.remove("hidden");
  setTimeout(() => errorBarEl.classList.add("hidden"), 5000);
}

// ─── Keyboard shortcuts ─────────────────────────────

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "n") {
    e.preventDefault();
    newNote();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    utilityInputEl?.focus();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "/") {
    e.preventDefault();
    toggleSidebar();
  }
});

// ─── Start ──────────────────────────────────────────

await init();
