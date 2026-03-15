/*
 * Noema — 2D graph life repository
 *
 * Full-viewport force-directed 2D graph. Central "My Life" node with
 * topic clusters branching off. Notes orbit their inferred topic.
 * Floating glassmorphism bar at bottom: Search, New, Filter, Chat, Index.
 * Clicking a note node opens a slide-in editor panel on the right.
 */

import { invoke } from "@tauri-apps/api/core";
import ForceGraph2D from "force-graph";

// ─── Constants ───

const BG_COLOR = "#0f1117";

const TOPIC_COLORS = {
  learning: "#6B8FD4",
  self_care: "#D4A06B",
  work: "#8B6BD4",
  health: "#6BD4A0",
  relationships: "#D46B8F",
  money: "#D4D06B",
  home: "#6BD4D4",
};

const TOPIC_LABELS = {
  learning: "Learning",
  self_care: "Self",
  work: "Work",
  health: "Health",
  relationships: "Relationships",
  money: "Money",
  home: "Home",
};

const TOPIC_KEYWORDS = {
  learning: ["learn", "study", "read", "research", "idea", "ai", "tool", "code", "dev", "prompt", "note"],
  self_care: ["journal", "reflect", "mind", "personal", "values", "emotion", "thought", "day", "morning"],
  work: ["work", "career", "project", "meeting", "client", "task", "ship", "team", "sprint"],
  health: ["health", "sleep", "workout", "meal", "run", "exercise", "meditation", "fitness"],
  relationships: ["family", "friend", "partner", "relationship", "people", "mentor", "coffee", "chat"],
  money: ["money", "finance", "budget", "expense", "salary", "invest", "cost"],
  home: ["home", "house", "chore", "errand", "admin", "maintenance", "move"],
};

// ─── DOM refs ───

const splashEl = document.getElementById("splash");
const graphContainer = document.getElementById("graph-container");
const setupDialogEl = document.getElementById("setup-dialog");
const setupPathEl = document.getElementById("setup-path");
const statNotesEl = document.getElementById("stat-notes");
const statTopicsEl = document.getElementById("stat-topics");
const editorPanelEl = document.getElementById("editor-panel");
const editorCloseBtn = document.getElementById("editor-close");
const noteTitleEl = document.getElementById("note-title");
const noteBodyEl = document.getElementById("note-body");
const saveStatusEl = document.getElementById("save-status");
const deleteNoteBtn = document.getElementById("delete-note-btn");
const searchPanelEl = document.getElementById("search-panel");
const searchInputEl = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");
const filterPanelEl = document.getElementById("filter-panel");
const filterListEl = document.getElementById("filter-list");
const chatPanelEl = document.getElementById("chat-panel");
const chatThreadEl = document.getElementById("chat-thread");
const chatInputEl = document.getElementById("chat-input");
const chatModelSelectEl = document.getElementById("chat-model-select");
const searchBtn = document.getElementById("search-btn");
const newBtn = document.getElementById("new-btn");
const filterBtn = document.getElementById("filter-btn");
const chatBtn = document.getElementById("chat-btn");
const rebuildBtn = document.getElementById("rebuild-btn");
const deleteDialogEl = document.getElementById("delete-dialog");
const deleteConfirmBtn = document.getElementById("delete-confirm-btn");
const deleteNoteNameEl = document.getElementById("delete-note-name");

// ─── State ───

let notes = [];
let graph = null;
let fullGraphData = { nodes: [], links: [] };
let connectionMap = new Map();
let hoveredNode = null;
let selectedNode = null;
let currentPath = null;
let saveTimer = null;
let searchTimer = null;
let activeFilters = new Set(Object.keys(TOPIC_COLORS));
let activePanel = null;
let indexUsable = true;
let indexErrorMessage = null;
let pendingDeletePath = null;
let relatedLinks = [];

// ─── Utilities ───

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function inferTopic(note) {
  const text = `${note.path} ${note.title || ""}`.toLowerCase();
  let best = "learning";
  let bestCount = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const count = keywords.filter((kw) => text.includes(kw)).length;
    if (count > bestCount) {
      bestCount = count;
      best = topic;
    }
  }
  return best;
}

// ─── Graph data construction ───

function buildGraphData(notesList) {
  const nodes = [];
  const links = [];

  nodes.push({
    id: "life",
    label: "My Life",
    type: "center",
    group: "center",
    fx: 0,
    fy: 0,
  });

  const topicNotes = {};
  for (const n of notesList) {
    const topic = inferTopic(n);
    if (!topicNotes[topic]) topicNotes[topic] = [];
    topicNotes[topic].push(n);
  }

  const topics = Object.keys(topicNotes);
  const angleStep = (2 * Math.PI) / Math.max(topics.length, 1);

  topics.forEach((topic, i) => {
    const angle = i * angleStep;
    nodes.push({
      id: `topic:${topic}`,
      label: TOPIC_LABELS[topic] || topic,
      type: "topic",
      group: topic,
      x: Math.cos(angle) * 160,
      y: Math.sin(angle) * 160,
    });
    links.push({ source: "life", target: `topic:${topic}`, type: "life-topic" });
  });

  for (const [topic, list] of Object.entries(topicNotes)) {
    const topicNode = nodes.find((n) => n.id === `topic:${topic}`);
    for (const n of list) {
      nodes.push({
        id: `note:${n.path}`,
        label: n.title || "Untitled",
        type: "note",
        group: topic,
        path: n.path,
        x: (topicNode?.x || 0) + (Math.random() - 0.5) * 100,
        y: (topicNode?.y || 0) + (Math.random() - 0.5) * 100,
      });
      links.push({ source: `topic:${topic}`, target: `note:${n.path}`, type: "topic-note" });
    }
  }

  return { nodes, links };
}

function rebuildConnectionMap(data) {
  connectionMap.clear();
  for (const link of data.links) {
    const sid = typeof link.source === "object" ? link.source.id : link.source;
    const tid = typeof link.target === "object" ? link.target.id : link.target;
    if (!connectionMap.has(sid)) connectionMap.set(sid, new Set());
    if (!connectionMap.has(tid)) connectionMap.set(tid, new Set());
    connectionMap.get(sid).add(tid);
    connectionMap.get(tid).add(sid);
  }
}

function isConnected(a, b) {
  return connectionMap.get(a?.id)?.has(b?.id) || false;
}

function getFilteredGraphData() {
  const nodes = fullGraphData.nodes.filter((n) => {
    if (n.type === "center") return true;
    return activeFilters.has(n.group);
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = fullGraphData.links.filter((l) => {
    const sid = typeof l.source === "object" ? l.source.id : l.source;
    const tid = typeof l.target === "object" ? l.target.id : l.target;
    return nodeIds.has(sid) && nodeIds.has(tid);
  });
  return { nodes, links };
}

// ─── Node / link helpers ───

function linkSourceId(link) {
  return typeof link.source === "object" ? link.source.id : link.source;
}

function linkTargetId(link) {
  return typeof link.target === "object" ? link.target.id : link.target;
}

function nodeSize(node) {
  if (node.type === "center") return 14;
  if (node.type === "topic") return 9;
  return 4;
}

function baseNodeColor(node) {
  if (node.type === "center") return "#5B8C6A";
  if (node.type === "topic") return TOPIC_COLORS[node.group] || "#888";
  return "#E8E4DC";
}

function nodeColor(node) {
  const active = selectedNode || hoveredNode;
  const base = baseNodeColor(node);
  if (!active) return base;
  if (node.id === active.id) return node.type === "note" ? "#ffffff" : base;
  if (isConnected(active, node)) return base;
  return "#2a2a30";
}

function baseLinkColor(link) {
  if (link.type === "life-topic") {
    const topic = linkTargetId(link).replace("topic:", "");
    return TOPIC_COLORS[topic] || "rgba(255,255,255,0.1)";
  }
  if (link.type === "related") return "rgba(91,140,106,0.5)";
  return "rgba(255,255,255,0.06)";
}

function activeLinkColor(link) {
  if (link.type === "related") return "#5B8C6A";
  if (link.type === "life-topic") {
    const topic = linkTargetId(link).replace("topic:", "");
    return TOPIC_COLORS[topic] || "rgba(255,255,255,0.4)";
  }
  return "rgba(255,255,255,0.25)";
}

function linkColor(link) {
  const active = selectedNode || hoveredNode;
  if (!active) return baseLinkColor(link);
  const sid = linkSourceId(link);
  const tid = linkTargetId(link);
  if (sid === active.id || tid === active.id) return activeLinkColor(link);
  return "rgba(255,255,255,0.015)";
}

function linkWidth(link) {
  if (link.type === "life-topic") return 1.8;
  if (link.type === "related") return 1.2;
  return 0.4;
}

function linkParticles(link) {
  if (link.type === "life-topic") return 2;
  if (link.type === "related") return 1;
  return 0;
}

// ─── 2D graph init ───

function initGraph() {
  if (!graphContainer) return;

  graph = ForceGraph2D()(graphContainer)
    .backgroundColor(BG_COLOR)
    .nodeId("id")
    .nodeLabel((n) => (n.type === "note" ? n.label : ""))
    .nodeColor(nodeColor)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkDirectionalParticles(linkParticles)
    .linkDirectionalParticleWidth(2)
    .linkDirectionalParticleSpeed(0.004)
    .linkDirectionalParticleColor(linkColor)
    .onNodeHover((node) => {
      graphContainer.style.cursor = node ? "pointer" : "default";
      hoveredNode = node || null;
    })
    .onNodeClick((node) => {
      if (!node) return;
      if (node.type === "note" && node.path) {
        selectedNode = node;
        openNoteEditor(node.path);
        focusOnNode(node);
      } else {
        selectedNode = node;
        focusOnNode(node);
      }
    })
    .onBackgroundClick(() => {
      if (selectedNode) {
        selectedNode = null;
      }
      closeEditor();
    })
    .nodeCanvasObject((node, ctx, globalScale) => {
      const size = nodeSize(node);
      const color = nodeColor(node);

      // Glow ring for center and topic nodes
      if (node.type === "center" || node.type === "topic") {
        ctx.beginPath();
        ctx.arc(node.x, node.y, size * 1.7, 0, 2 * Math.PI);
        ctx.fillStyle = color + "18";
        ctx.fill();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Selected / hovered ring
      const active = selectedNode || hoveredNode;
      if (active && node.id === active.id) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, size + 2, 0, 2 * Math.PI);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // Labels for center and topic (always visible)
      if (node.type === "center" || node.type === "topic") {
        const fontSize = node.type === "center" ? 6 : 4;
        ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.fillText(node.label, node.x, node.y + size + 3);
      }

      // Labels for notes when zoomed in
      if (node.type === "note" && globalScale > 2.5) {
        const fontSize = 3;
        ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        const maxLen = 20;
        const label = node.label.length > maxLen ? node.label.slice(0, maxLen) + "…" : node.label;
        ctx.fillText(label, node.x, node.y + size + 2);
      }
    })
    .nodePointerAreaPaint((node, color, ctx) => {
      const size = nodeSize(node) + 3;
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    })
    .warmupTicks(80)
    .cooldownTime(3000)
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.3);

  graph.d3Force("charge").strength(-50);
  graph.d3Force("link").distance((link) => {
    if (link.type === "life-topic") return 160;
    if (link.type === "topic-note") return 60;
    return 80;
  });
}

function zoomForNode(node) {
  if (node.type === "center") return 1.5;
  if (node.type === "topic") return 2.5;
  return 4;
}

function focusOnNode(node) {
  if (!graph || !node) return;
  graph.centerAt(node.x, node.y, 800);
  graph.zoom(zoomForNode(node), 800);
}

function updateGraph() {
  if (!graph) return;
  const filtered = getFilteredGraphData();
  const nodeIds = new Set(filtered.nodes.map((n) => n.id));
  const validRelated = relatedLinks.filter((rl) => {
    const sid = typeof rl.source === "object" ? rl.source.id : rl.source;
    const tid = typeof rl.target === "object" ? rl.target.id : rl.target;
    return nodeIds.has(sid) && nodeIds.has(tid);
  });
  const withRelated = {
    nodes: filtered.nodes,
    links: [...filtered.links, ...validRelated],
  };
  rebuildConnectionMap(withRelated);
  graph.graphData(withRelated);
  updateStats();
}

function updateStats() {
  const noteCount = fullGraphData.nodes.filter((n) => n.type === "note").length;
  const topicCount = fullGraphData.nodes.filter((n) => n.type === "topic").length;
  if (statNotesEl) statNotesEl.textContent = `${noteCount} notes`;
  if (statTopicsEl) statTopicsEl.textContent = `${topicCount} topics`;
}

// ─── Related links (dynamic connections) ───

async function fetchRelatedLinks(queryText, notePath) {
  if (!indexUsable || !queryText) return;
  try {
    const results = await invoke("query", { query: queryText, k: 6 });
    const related = (results || []).filter((r) => r.note_path !== notePath).slice(0, 4);
    relatedLinks = related.map((r) => ({
      source: `note:${notePath}`,
      target: `note:${r.note_path}`,
      type: "related",
    }));
    updateGraph();
  } catch {
    /* related links are best-effort */
  }
}

function clearRelatedLinks() {
  if (relatedLinks.length === 0) return;
  relatedLinks = [];
  updateGraph();
}

// ─── Editor panel ───

async function openNoteEditor(path) {
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
    editorPanelEl?.classList.add("open");
    fetchRelatedLinks(detail.title || detail.path, detail.path);
  } catch (e) {
    console.error("openNoteEditor:", e);
  }
}

function closeEditor() {
  editorPanelEl?.classList.remove("open");
  currentPath = null;
  clearRelatedLinks();
}

function setSaveStatus(text) {
  if (!saveStatusEl) return;
  saveStatusEl.textContent = text || "";
  saveStatusEl.classList.remove("fade-out");
  if (text === "saved") {
    setTimeout(() => saveStatusEl.classList.add("fade-out"), 1500);
  }
}

function scheduleSave() {
  if (!currentPath) return;
  if (saveTimer) clearTimeout(saveTimer);
  setSaveStatus("saving...");
  saveTimer = setTimeout(async () => {
    try {
      await invoke("save_note", {
        path: currentPath,
        title: noteTitleEl?.value || "",
        body: noteBodyEl?.value || "",
      });
      setSaveStatus("saved");
      const idx = notes.findIndex((n) => n.path === currentPath);
      if (idx !== -1 && noteTitleEl) {
        notes[idx].title = noteTitleEl.value || notes[idx].path;
        rebuildFullGraph();
      }
    } catch {
      setSaveStatus("save failed");
    }
  }, 500);
}

// ─── Note CRUD ───

async function loadNotes() {
  try {
    const list = await invoke("list_notes");
    notes = Array.isArray(list) ? list : [];
    rebuildFullGraph();
  } catch (e) {
    console.error("loadNotes:", e);
  }
}

function rebuildFullGraph() {
  fullGraphData = buildGraphData(notes);
  updateGraph();
}

async function createNote() {
  try {
    const detail = await invoke("create_note");
    currentPath = detail.path;
    if (noteTitleEl) noteTitleEl.value = "";
    if (noteBodyEl) noteBodyEl.value = "";
    setSaveStatus("");
    editorPanelEl?.classList.add("open");
    if (noteTitleEl) noteTitleEl.focus();
    await loadNotes();

    const node = graph?.graphData().nodes.find((n) => n.path === detail.path);
    if (node) {
      selectedNode = node;
      focusOnNode(node);
    }
  } catch (e) {
    console.error("createNote:", e);
  }
}

async function deleteNote(path) {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await invoke("delete_note", { path });
    if (currentPath === path) closeEditor();
    selectedNode = null;
    await loadNotes();
  } catch (e) {
    console.error("deleteNote:", e);
  }
}

// ─── Floating panels ───

function togglePanel(name) {
  if (activePanel === name) {
    closePanel();
    return;
  }
  closePanel();
  activePanel = name;

  const panels = { search: searchPanelEl, filter: filterPanelEl, chat: chatPanelEl };
  const btns = { search: searchBtn, filter: filterBtn, chat: chatBtn };

  panels[name]?.classList.remove("hidden");
  btns[name]?.classList.add("active");

  if (name === "search" && searchInputEl) {
    searchInputEl.value = "";
    searchInputEl.focus();
    if (searchResultsEl) searchResultsEl.innerHTML = "";
  }
  if (name === "filter") renderFilterPanel();
  if (name === "chat" && chatInputEl) chatInputEl.focus();
}

function closePanel() {
  activePanel = null;
  searchPanelEl?.classList.add("hidden");
  filterPanelEl?.classList.add("hidden");
  chatPanelEl?.classList.add("hidden");
  searchBtn?.classList.remove("active");
  filterBtn?.classList.remove("active");
  chatBtn?.classList.remove("active");
}

// ─── Search ───

function handleSearchInput() {
  const q = searchInputEl?.value?.trim();
  if (searchTimer) clearTimeout(searchTimer);

  if (!q) {
    if (searchResultsEl) searchResultsEl.innerHTML = "";
    return;
  }

  if (!indexUsable) {
    if (searchResultsEl) {
      searchResultsEl.innerHTML = `<div class="search-empty">${escapeHtml(indexErrorMessage || "Index not ready.")}</div>`;
    }
    return;
  }

  searchTimer = setTimeout(async () => {
    try {
      const results = await invoke("query", { query: q, k: 12 });
      renderSearchResults(results, q);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Rebuild") || msg.includes("Index is empty") || msg.includes("Could not determine")) {
        indexUsable = false;
        indexErrorMessage = "Index not built. Use Index button.";
      }
      if (searchResultsEl) {
        searchResultsEl.innerHTML = `<div class="search-empty">${escapeHtml(indexErrorMessage || msg)}</div>`;
      }
    }
  }, 200);
}

function renderSearchResults(results, query) {
  if (!searchResultsEl) return;
  if (!results?.length) {
    searchResultsEl.innerHTML = `<div class="search-empty">No matches for "${escapeHtml(query)}"</div>`;
    return;
  }
  const lower = query.toLowerCase();
  searchResultsEl.innerHTML = results
    .map((r) => {
      const preview = r.preview || "";
      const idx = preview.toLowerCase().indexOf(lower);
      let highlighted = escapeHtml(preview);
      if (idx !== -1 && query.length > 0) {
        const before = escapeHtml(preview.slice(0, idx));
        const match = escapeHtml(preview.slice(idx, idx + query.length));
        const after = escapeHtml(preview.slice(idx + query.length));
        highlighted = `${before}<span class="search-highlight">${match}</span>${after}`;
      }
      const name = r.note_path.replace(/\.md$/, "").split("/").pop() || "Untitled";
      return `<button type="button" class="search-result-item" data-path="${encodeURIComponent(r.note_path)}">
        <div class="search-result-title">${escapeHtml(name)}</div>
        <div class="search-result-preview">${highlighted}</div>
        <div class="search-result-path">${escapeHtml(r.note_path)}</div>
      </button>`;
    })
    .join("");
}

// ─── Filter ───

function renderFilterPanel() {
  if (!filterListEl) return;
  filterListEl.innerHTML = Object.entries(TOPIC_COLORS)
    .map(([topic, color]) => {
      const active = activeFilters.has(topic);
      const count = fullGraphData.nodes.filter((n) => n.type === "note" && n.group === topic).length;
      return `<button class="filter-pill${active ? " active" : ""}" data-topic="${topic}" style="color:${active ? color : ""}">
        <span class="filter-dot" style="background:${color}"></span>
        ${TOPIC_LABELS[topic]} (${count})
      </button>`;
    })
    .join("");
}

function toggleFilter(topic) {
  if (activeFilters.has(topic)) {
    activeFilters.delete(topic);
  } else {
    activeFilters.add(topic);
  }
  updateGraph();
  renderFilterPanel();
}

// ─── Chat ───

function appendChatMessage(kind, text) {
  if (!chatThreadEl) return null;
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
    label.textContent = "sources:";
    sourcesDiv.appendChild(label);

    sources.forEach((s, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-source-link";
      btn.textContent = `[${idx + 1}]`;
      btn.title = s.title || s.note_path || `source ${idx + 1}`;
      btn.addEventListener("click", () => {
        if (s.note_path) {
          const node = graph?.graphData().nodes.find((n) => n.path === s.note_path);
          if (node) {
            selectedNode = node;
            focusOnNode(node);
          }
          openNoteEditor(s.note_path);
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
    defaultOpt.textContent = "default";
    chatModelSelectEl.appendChild(defaultOpt);
    if (Array.isArray(models)) {
      for (const name of models) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        chatModelSelectEl.appendChild(opt);
      }
    }
  } catch {
    chatModelSelectEl.innerHTML = '<option value="">unavailable</option>';
    chatModelSelectEl.disabled = true;
  }
}

// ─── Delete dialog ───

function showDeleteDialog(path) {
  pendingDeletePath = path;
  if (deleteNoteNameEl) deleteNoteNameEl.textContent = ` (${path})`;
  if (deleteDialogEl?.showModal) {
    deleteDialogEl.showModal();
  } else if (globalThis.confirm(`Delete this note?\n${path}`)) {
    deleteNote(path);
  }
}

// ─── Setup & splash ───

async function initSetup() {
  try {
    const root = await invoke("get_notes_root");
    if (root) return true;
  } catch {
    /* not configured */
  }

  return new Promise((resolve) => {
    if (!setupDialogEl) {
      const entered = globalThis.prompt("Enter notes folder path:");
      if (entered?.trim()) {
        invoke("set_notes_root", { path: entered.trim() })
          .then(() => resolve(true))
          .catch(() => resolve(false));
      } else {
        resolve(false);
      }
      return;
    }

    setupDialogEl.showModal();
    setupDialogEl.addEventListener(
      "close",
      async () => {
        const path = setupPathEl?.value?.trim();
        if (!path) {
          resolve(false);
          return;
        }
        try {
          await invoke("set_notes_root", { path });
          resolve(true);
        } catch {
          resolve(false);
        }
      },
      { once: true }
    );
  });
}

function hideSplash() {
  if (!splashEl) return;
  splashEl.classList.add("fade-out");
  setTimeout(() => splashEl.classList.add("hidden"), 650);
}

// ─── Event binding ───

function bindAll() {
  searchBtn?.addEventListener("click", () => togglePanel("search"));
  newBtn?.addEventListener("click", () => {
    closePanel();
    createNote();
  });
  filterBtn?.addEventListener("click", () => togglePanel("filter"));
  chatBtn?.addEventListener("click", () => togglePanel("chat"));

  rebuildBtn?.addEventListener("click", async () => {
    rebuildBtn.disabled = true;
    rebuildBtn.textContent = "...";
    try {
      await invoke("rebuild_index");
      indexUsable = true;
      indexErrorMessage = null;
      rebuildBtn.textContent = "Done";
      await loadNotes();
      setTimeout(() => { rebuildBtn.textContent = "Index"; }, 2000);
    } catch (e) {
      rebuildBtn.textContent = "Error";
      const msg = String(e);
      if (msg.toLowerCase().includes("index")) {
        indexUsable = false;
        indexErrorMessage = msg;
      }
      setTimeout(() => { rebuildBtn.textContent = "Index"; }, 2000);
    } finally {
      rebuildBtn.disabled = false;
    }
  });

  noteTitleEl?.addEventListener("input", scheduleSave);
  noteBodyEl?.addEventListener("input", scheduleSave);

  editorCloseBtn?.addEventListener("click", () => {
    closeEditor();
    selectedNode = null;
  });

  deleteNoteBtn?.addEventListener("click", () => {
    if (currentPath) showDeleteDialog(currentPath);
  });

  searchInputEl?.addEventListener("input", handleSearchInput);
  searchInputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  searchResultsEl?.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest(".search-result-item");
    if (item?.dataset.path) {
      closePanel();
      const path = decodeURIComponent(item.dataset.path);
      const node = graph?.graphData().nodes.find((n) => n.path === path);
      if (node) {
        selectedNode = node;
        focusOnNode(node);
      }
      await openNoteEditor(path);
    }
  });

  filterListEl?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const pill = target.closest(".filter-pill");
    if (pill?.dataset.topic) toggleFilter(pill.dataset.topic);
  });

  chatInputEl?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = chatInputEl.value.trim();
    if (!text) return;
    appendChatMessage("user", text);
    chatInputEl.value = "";
    if (!indexUsable) {
      appendChatMessage("agent", "Index not built. Use the Index button first.");
      return;
    }
    const pending = appendChatMessage("agent", "thinking...");
    const selectedModel = chatModelSelectEl?.value?.trim() || "";
    try {
      const resp = await invoke("ask", {
        question: text,
        k: 6,
        model: selectedModel || null,
      });
      pending?.remove();
      if (!resp?.answer) {
        appendChatMessage("agent", "No answer. Ensure index is built and Ollama is running.");
        return;
      }
      appendChatAnswer(resp.answer, resp.sources || []);
    } catch (err) {
      pending?.remove();
      const msg = String(err);
      if (msg.includes("Rebuild") || msg.includes("Index is empty") || msg.includes("Could not determine")) {
        indexUsable = false;
        indexErrorMessage = "Index not built. Use the Index button.";
        appendChatMessage("agent", indexErrorMessage);
      } else {
        appendChatMessage("agent", msg);
      }
    }
  });

  deleteConfirmBtn?.addEventListener("click", async () => {
    const toDelete = pendingDeletePath;
    pendingDeletePath = null;
    deleteDialogEl?.close("confirm");
    if (toDelete) await deleteNote(toDelete);
  });

  deleteDialogEl?.addEventListener("close", () => {
    pendingDeletePath = null;
  });

  globalThis.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (activePanel) {
        closePanel();
        return;
      }
      if (editorPanelEl?.classList.contains("open")) {
        closeEditor();
        selectedNode = null;
        return;
      }
    }
    if (!e.metaKey && !e.ctrlKey) return;
    if (e.key === "k") {
      e.preventDefault();
      togglePanel("search");
    } else if (e.key === "n") {
      e.preventDefault();
      closePanel();
      createNote();
    } else if (e.key === "j") {
      e.preventDefault();
      togglePanel("chat");
    }
  });
}

// ─── Bootstrap ───

(async () => {
  const ready = await initSetup();
  hideSplash();
  initGraph();
  bindAll();

  if (ready) {
    await initChatModels();
    await loadNotes();
  }
})();
