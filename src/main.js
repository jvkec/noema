import { invoke } from "@tauri-apps/api/core";

const statusEl = document.getElementById("status");
const saveStatusEl = document.getElementById("save-status");
const noteTreeEl = document.getElementById("note-tree");
const noteTitleEl = document.getElementById("note-title");
const noteBodyEl = document.getElementById("note-body");
const searchInputEl = document.getElementById("search");
const searchResultsEl = document.getElementById("search-results");
const newNoteBtn = document.getElementById("new-note-btn");
const chatInputEl = document.getElementById("chat-input");
const chatThreadEl = document.getElementById("chat-thread");
const chatModelSelectEl = document.getElementById("chat-model-select");

let notes = [];
let currentPath = null;
let saveTimer = null;
let searchTimer = null;
/** Set of folder paths (e.g. "folder", "folder/sub") that are expanded */
let expandedFolders = new Set();
let indexUsable = true;
let indexErrorMessage = null;

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function setSaveStatus(text) {
  if (!saveStatusEl) return;
  saveStatusEl.textContent = text || "";
}

async function initStatus() {
  try {
    const root = await invoke("get_notes_root");
    if (root) {
      setStatus(`notes: ${root}`);
    } else {
      setStatus("no notes root. run: noema set-root <path>");
    }
  } catch (e) {
    setStatus(String(e), true);
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
        `<div class="tree-folder" data-folder="${encodeURIComponent(pathKey)}" role="button">
          <span class="tree-folder-prefix">${isExpanded ? "v" : ">"}</span>
          <span class="tree-folder-name">${escapeHtml(c.name)}</span>
        </div>`
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
        `<div class="tree-note${active}" data-path="${encodeURIComponent(c.path)}" role="button">
          <span class="tree-note-prefix">—</span>
          <span class="tree-note-title" title="${escapeHtml(c.path)}">${escapeHtml(c.name)}</span>
          <button class="tree-note-delete" data-path="${encodeURIComponent(c.path)}">×</button>
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
  // Keep ancestors of current note expanded so it stays visible
  if (currentPath) {
    const parts = currentPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      expandedFolders.add(parts.slice(0, i).join("/"));
    }
  }
  const tree = buildNoteTree(notes);
  noteTreeEl.innerHTML = renderTreeLevel(tree);
}

function bindNoteTreeEvents() {
  if (!noteTreeEl) return;
  noteTreeEl.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const deletePath = target.dataset.path;
    if (target.classList.contains("tree-note-delete") && deletePath) {
      e.stopPropagation();
      await deleteNote(decodeURIComponent(deletePath));
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
    const noteRow = target.closest(".tree-note");
    if (noteRow) {
      const path = noteRow.dataset.path;
      if (path) {
        await openNote(decodeURIComponent(path));
      }
    }
  });
}

async function loadNotes() {
  try {
    const list = await invoke("list_notes");
    notes = Array.isArray(list) ? list : [];
    renderNoteTree();
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
    } catch (e) {
      setSaveStatus("save failed");
      setStatus(String(e), true);
    }
  }, 500);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function renderSearchResults(results, query) {
  if (!searchResultsEl) return;
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
        <div class="search-result-item" data-path="${encodeURIComponent(r.note_path)}">
          <div class="search-result-path">${escapeHtml(r.note_path)}</div>
          <p class="search-result-preview">${highlighted}</p>
          <div class="search-result-score">${(r.score * 100).toFixed(0)}%</div>
        </div>
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
          "index not ready. run `noema init` in the CLI, then restart the app.";
        searchResultsEl.innerHTML = `<div class="muted">${escapeHtml(msg)}</div>`;
        searchResultsEl.classList.remove("hidden");
      }
      return;
    }
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      if (searchResultsEl) searchResultsEl.classList.add("hidden");
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const results = await invoke("query", { query: q, k: 16 });
        renderSearchResults(results, q);
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("Run `noema init` first") ||
          msg.includes("Could not determine index path") ||
          msg.includes("Index is empty")
        ) {
          indexUsable = false;
          indexErrorMessage = "index not built. run `noema init` in the CLI, then restart the app.";
        }
        if (searchResultsEl) {
          const display = indexErrorMessage || msg;
          searchResultsEl.innerHTML = `<div class="error">${escapeHtml(display)}</div>`;
          searchResultsEl.classList.remove("hidden");
        }
      }
    }, 200);
  });

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInputEl.value = "";
      if (searchResultsEl) searchResultsEl.classList.add("hidden");
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
          if (searchResultsEl) searchResultsEl.classList.add("hidden");
          searchInputEl.value = "";
          await openNote(decodeURIComponent(path));
        }
      }
    });
  }
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
          "index not built. run `noema init` in the CLI, then restart the app."
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
            "no answer. check that `noema init` has been run and Ollama is running."
          );
          return;
        }
        appendChatAnswer(resp.answer, resp.sources || []);
      } catch (err) {
        pending?.remove();
        const msg = String(err);
        if (
          msg.includes("Run `noema init` first") ||
          msg.includes("Index is empty") ||
          msg.includes("Could not determine index path")
        ) {
          indexUsable = false;
          indexErrorMessage =
            "index not built. run `noema init` in the CLI, then restart the app.";
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
      btn.textContent = s.title || s.note_path || `source ${idx + 1}`;
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
  await initStatus();
  bindNoteTreeEvents();
  bindEditorEvents();
  bindSearchEvents();
  bindNewNoteButton();
  await initChatModels();
  bindChat();
  await loadNotes();

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
