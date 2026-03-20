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
let sidebarPinned = false;

const SIDEBAR_HIDE_DELAY_MS = 120;
const SIDEBAR_OPEN_TRANSITION_MS = 220;
const SIDEBAR_CLOSE_TRANSITION_MS = 160;

let utilityQuery = "";
let filterResults = [];
let searchResults = [];
let searchError = "";
let isSearching = false;
let askResponse = null;
let isAsking = false;
let utilityMode = "idle";
let utilityFocused = false;
let utilityHideTimer = null;
let utilityModelExitTimer = null;
let utilityPanelSignature = "";

let chatModels = [];
let selectedModel = null;

let createPromise = null;

const UTILITY_PANEL_EXIT_MS = 140;
const UTILITY_MODEL_EXIT_DELAY_MS = 200;
const STATUS_FADE_MS = 200;

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

  sidebarPinned = localStorage.getItem("noema.sidebarPinned") === "1";

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
      { className: "border-t border-stone-100 px-4 py-3 flex gap-4 items-center" },
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
          id: "sidebar-pin-btn",
          className:
            "text-sm text-stone-400 hover:text-stone-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded",
          "aria-pressed": sidebarPinned ? "true" : "false",
          onClick: () => setSidebarPinned(!sidebarPinned),
        },
        sidebarPinned ? "pinned" : "pin",
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
      if (utilityResultsEl?.contains(document.activeElement)) return;
      utilityFocused = false;
      updateUtilityPanel();
    }, 150);
  });

  utilityResultsEl = h("div", {
    className:
      "hidden mb-1 transition duration-150 ease-out opacity-0 translate-y-1",
  });
  let panelHover = false;
  utilityResultsEl.addEventListener("mouseenter", () => { panelHover = true; });
  utilityResultsEl.addEventListener("mouseleave", () => {
    panelHover = false;
    if (utilityResultsEl.contains(document.activeElement)) return;
    if (!utilityInputEl.matches(":focus")) {
      utilityFocused = false;
      updateUtilityPanel();
    }
  });
  utilityResultsEl.addEventListener("mousedown", () => { panelHover = true; });

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
        "fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-20 w-full max-w-xl px-6",
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
            "text-sm text-stone-400 hover:text-stone-700 focus:outline-none rounded",
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

  if (sidebarPinned) slideSidebar(true);

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

  const statusLine = h(
    "div",
    {
      className: "flex justify-end items-center gap-3 mb-6 min-h-5",
      "data-status-line": "",
    },
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
  patchStatus();

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
  if (sidebarPinned) visible = true;
  sidebarVisible = visible;
  sidebarEl.style.transition = visible
    ? `translate ${SIDEBAR_OPEN_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
    : `translate ${SIDEBAR_CLOSE_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
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
  if (sidebarPinned) return;
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => slideSidebar(false), SIDEBAR_HIDE_DELAY_MS);
}

function toggleSidebar() {
  clearTimeout(sidebarTimer);
  slideSidebar(!sidebarVisible);
}

function setSidebarPinned(next) {
  sidebarPinned = Boolean(next);
  localStorage.setItem("noema.sidebarPinned", sidebarPinned ? "1" : "0");

  const btn = document.getElementById("sidebar-pin-btn");
  if (btn) {
    btn.textContent = sidebarPinned ? "pinned" : "pin";
    btn.setAttribute("aria-pressed", sidebarPinned ? "true" : "false");
  }

  if (sidebarPinned) {
    clearTimeout(sidebarTimer);
    slideSidebar(true);
  }
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
  const p = note?.path?.trim();
  if (!p) return "new note";
  const rawTitle = String(note?.title ?? "").trim();
  const filename = p.split("/").pop() || p;
  const stem = filename.replace(/\.md$/i, "");
  const looksGeneratedUntitled = /^note-[a-f0-9-]+$/i.test(stem);
  const titleIsFallbackPath =
    rawTitle === p ||
    rawTitle === filename;
  if (!rawTitle || (looksGeneratedUntitled && titleIsFallbackPath)) {
    return "new note";
  }
  if (rawTitle) {
    return rawTitle;
  }
  const pretty = stem.replaceAll("-", " ").replaceAll(/ {2,}/g, " ").trim();
  return pretty || "new note";
}

function filenameFromTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  const base = t
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(/[:*?"<>|]/g, "-")
    .replaceAll(".", "-")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
  return base ? `${base}.md` : null;
}

async function maybeRenameNoteToMatchTitle() {
  if (!selectedNote?.path) return;
  const desiredFilename = filenameFromTitle(selectedNote.title);
  if (!desiredFilename) return;

  const parts = selectedNote.path.split("/");
  const currentFilename = parts.pop() || "";
  if (currentFilename.toLowerCase() === desiredFilename.toLowerCase()) return;

  const folder = parts.join("/");
  const base = desiredFilename.replace(/\.md$/i, "");
  for (let i = 0; i < 20; i++) {
    const suffix = i === 0 ? "" : `-${i + 1}`;
    const dest = folder ? `${folder}/${base}${suffix}.md` : `${base}${suffix}.md`;
    try {
      await invoke("move_note", { source: selectedNote.path, dest });
      selectedNote.path = dest;
      return;
    } catch (e) {
      const msg = String(e ?? "");
      const looksLikeCollision =
        /exist/i.test(msg) || /already/i.test(msg) || /collision/i.test(msg);
      if (!looksLikeCollision) throw e;
    }
  }
  throw new Error("too many filename collisions");
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
        "border border-stone-200 rounded-xl bg-white shadow-sm px-5 py-4",
    },
    ...children,
  );
}

function cleanNoteLabel(path) {
  return String(path || "").replace(/\.md$/i, "");
}

function sourceTitle(source) {
  return source.title?.trim() || cleanNoteLabel(source.note_path);
}

function sourceMetaLabel(source) {
  const pathLabel = cleanNoteLabel(source.note_path);
  if (!pathLabel || pathLabel === sourceTitle(source)) {
    return source.kind === "title" ? "title excerpt" : "body excerpt";
  }
  return `${pathLabel} · ${source.kind === "title" ? "title excerpt" : "body excerpt"}`;
}

function renderAskSource(source, index) {
  return h(
    "button",
    {
      className:
        "group block w-full rounded-lg border border-stone-200 px-3 py-3 text-left hover:border-stone-300 hover:bg-stone-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400",
      onClick: () => {
        selectNote(source.note_path);
        clearUtility();
      },
    },
    h(
      "div",
      { className: "flex items-start gap-3" },
      h(
        "span",
        {
          className:
            "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] text-stone-500 tabular-nums",
        },
        String(index + 1),
      ),
      h(
        "div",
        { className: "min-w-0 flex-1" },
        h("p", { className: "text-sm text-stone-800 text-pretty" }, sourceTitle(source)),
        h("p", { className: "mt-0.5 text-xs text-stone-400 truncate" }, sourceMetaLabel(source)),
        source.excerpt
          ? h("p", { className: "mt-2 text-sm text-stone-500 text-pretty leading-relaxed" }, source.excerpt)
          : null,
      ),
    ),
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
      h("p", {
        className:
          "text-sm text-stone-700 leading-relaxed text-pretty whitespace-pre-wrap",
      }, askResponse.answer),
    ];
    if (askResponse.sources?.length > 0) {
      items.push(
        h("div", { className: "mt-4 border-t border-stone-100 pt-4" },
          h("p", { className: "mb-3 text-xs uppercase text-stone-400" }, "Sources"),
          h("div", { className: "space-y-2" },
            ...askResponse.sources.map((s, i) => renderAskSource(s, i)),
          ),
        ),
      );
    }
    return h("div", {
      className:
        "border border-stone-200 rounded-xl bg-white shadow-sm px-5 py-4 max-h-[28rem] overflow-y-auto",
    }, ...items);
  }

  return h("div", { className: "border border-stone-200 rounded-xl bg-white shadow-sm px-5 py-3" },
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
        h("span", { className: "text-stone-700" }, cleanNoteLabel(r.note_path)),
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
      if (utilityModelExitTimer) clearTimeout(utilityModelExitTimer);
      utilityModelExitTimer = setTimeout(() => {
        utilityModelExitTimer = null;
        hideUtilityResults();
      }, UTILITY_MODEL_EXIT_DELAY_MS);
    });
    items.push(modelRow);
  }

  if (items.length === 0) return null;

  return h("div", {
    className: "border border-stone-200 rounded-lg bg-white shadow-sm overflow-hidden",
  }, ...items);
}

function replaceUtilityPanel(panelEl) {
  if (!utilityResultsEl) return;
  utilityResultsEl.innerHTML = "";
  utilityResultsEl.appendChild(panelEl);
}

function showUtilityResults(panelEl, signature = "", animate = true) {
  if (!utilityResultsEl) return;
  const wasHidden = utilityResultsEl.classList.contains("hidden");
  if (utilityModelExitTimer) {
    clearTimeout(utilityModelExitTimer);
    utilityModelExitTimer = null;
  }
  if (utilityHideTimer) {
    clearTimeout(utilityHideTimer);
    utilityHideTimer = null;
  }
  utilityResultsEl.classList.remove("hidden");
  replaceUtilityPanel(panelEl);
  const shouldAnimate =
    animate ||
    wasHidden ||
    signature !== utilityPanelSignature;
  utilityPanelSignature = signature;
  if (!shouldAnimate) {
    utilityResultsEl.classList.remove("opacity-0", "translate-y-1");
    utilityResultsEl.classList.add("opacity-100", "translate-y-0");
    return;
  }
  // Reset to a known "hidden" visual state so entry always animates.
  utilityResultsEl.classList.remove("opacity-100", "translate-y-0");
  utilityResultsEl.classList.add("opacity-0", "translate-y-1");
  requestAnimationFrame(() => {
    utilityResultsEl.classList.remove("opacity-0", "translate-y-1");
    utilityResultsEl.classList.add("opacity-100", "translate-y-0");
  });
}

function hideUtilityResults() {
  if (!utilityResultsEl) return;
  utilityPanelSignature = "";
  utilityResultsEl.classList.remove("opacity-100", "translate-y-0");
  utilityResultsEl.classList.add("opacity-0", "translate-y-1");
  if (utilityHideTimer) clearTimeout(utilityHideTimer);
  utilityHideTimer = setTimeout(() => {
    // Only fully hide if nothing reopened it.
    if (utilityResultsEl.classList.contains("opacity-0")) {
      utilityResultsEl.classList.add("hidden");
      utilityResultsEl.innerHTML = "";
    }
    utilityHideTimer = null;
  }, UTILITY_PANEL_EXIT_MS);
}

function updateUtilityPanel() {
  if (!utilityResultsEl) return;

  if (utilityMode === "ask") {
    showUtilityResults(
      renderAskPanel(),
      `ask:${isAsking ? "loading" : askResponse?.error ? `error:${askResponse.error}` : askResponse?.answer ? `answer:${askResponse.answer}` : "idle"}`,
      false,
    );
    return;
  }

  if (utilityMode === "search") {
    showUtilityResults(
      renderSearchPanel(),
      `search:${isSearching ? "loading" : searchError ? `error:${searchError}` : searchResults.map((r) => `${r.note_path}:${r.score.toFixed(3)}`).join("|")}`,
      false,
    );
    return;
  }

  if (utilityMode === "filter") {
    // Avoid rendering an empty bordered panel (shows as a thin grey line).
    if (filterResults.length === 0) {
      hideUtilityResults();
      return;
    }
    showUtilityResults(
      renderFilterPanel(),
      `filter:${filterResults.map((n) => n.path).join("|")}`,
      false,
    );
    return;
  }

  const caretActive =
    utilityInputEl?.matches(":focus") ||
    utilityResultsEl.contains(document.activeElement);

  if (caretActive && utilityMode === "idle") {
    const panel = renderDefaultPanel();
    if (panel) {
      showUtilityResults(panel, `idle:${selectedModel || ""}`, false);
      return;
    }
  }

  hideUtilityResults();
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

    try {
      await maybeRenameNoteToMatchTitle();
    } catch (e) {
      showError("Failed to rename file: " + e);
    }

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

function fadeInNextFrame(el) {
  requestAnimationFrame(() => el.classList.remove("opacity-0"));
}

function patchStatus() {
  const line = canvasEl?.querySelector("[data-status-line]");
  if (!line) return;

  function updateSaveStatus() {
    const statusEl = line.querySelector("[data-save-status]");
    if (!saveStatus) {
      if (!statusEl) return;
      statusEl.classList.add("opacity-0");
      setTimeout(() => {
        if (statusEl.isConnected && saveStatus === "") statusEl.remove();
      }, STATUS_FADE_MS);
      return;
    }

    const isError = saveStatus.startsWith("Error");
    let label = saveStatus;
    if (saveStatus === "saved") label = "saved";
    else if (saveStatus === "saving") label = "saving\u2026";

    if (statusEl) {
      statusEl.textContent = label;
      statusEl.classList.toggle("text-red-500", isError);
      statusEl.classList.toggle("text-stone-400", !isError);
      statusEl.classList.remove("opacity-0");
      return;
    }

    const el = h(
      "span",
      {
        "data-save-status": "",
        className: `text-xs transition-opacity ease-out opacity-0 duration-[${STATUS_FADE_MS}ms] ${isError ? "text-red-500" : "text-stone-400"}`,
      },
      label,
    );
    line.prepend(el);
    fadeInNextFrame(el);
  }

  function updateDeleteBtn() {
    const deleteBtn = line.querySelector("[data-delete-btn]");
    if (!selectedNote) {
      if (!deleteBtn) return;
      deleteBtn.classList.add("opacity-0");
      setTimeout(() => {
        if (deleteBtn.isConnected && selectedNote === null) deleteBtn.remove();
      }, STATUS_FADE_MS);
      return;
    }

    if (deleteBtn) {
      deleteBtn.classList.remove("opacity-0");
      return;
    }

    const btn = h(
      "button",
      {
        "data-delete-btn": "",
        className:
          `text-xs text-stone-400 hover:text-red-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-stone-400 rounded px-1 py-0.5 transition-opacity ease-out opacity-0 duration-[${STATUS_FADE_MS}ms]`,
        onClick: () =>
          document.getElementById("delete-dialog")?.showModal(),
        "aria-label": "Delete note",
      },
      "delete",
    );
    line.appendChild(btn);
    fadeInNextFrame(btn);
  }

  updateSaveStatus();
  updateDeleteBtn();
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
