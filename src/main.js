import { invoke } from "@tauri-apps/api/core";

const statusEl = document.getElementById("status");
const queryEl = document.getElementById("query");
const searchBtn = document.getElementById("search-btn");
const resultsEl = document.getElementById("results");

async function init() {
  try {
    const s = await invoke("status");
    const root = await invoke("get_notes_root");
    statusEl.textContent = root
      ? `Ready · Notes: ${root}`
      : "No notes root. Run: noema set-root <path>";
    statusEl.className = root ? "" : "muted";
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
    statusEl.className = "error";
  }
}

async function search() {
  const q = queryEl.value.trim();
  if (!q) return;

  resultsEl.innerHTML = "<p class='muted'>Searching…</p>";
  try {
    const results = await invoke("query", { query: q, k: 8 });
    if (results.length === 0) {
      resultsEl.innerHTML = "<p class='muted'>No results.</p>";
      return;
    }
    resultsEl.innerHTML = results
      .map(
        (r) => `
      <article class="result">
        <div class="score">${(r.score * 100).toFixed(0)}%</div>
        <div class="content">
          <div class="path">${escapeHtml(r.note_path)}</div>
          <p class="preview">${escapeHtml(r.preview)}</p>
        </div>
      </article>
    `
      )
      .join("");
  } catch (e) {
    resultsEl.innerHTML = `<p class="error">${escapeHtml(String(e))}</p>`;
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

searchBtn.addEventListener("click", search);
queryEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") search();
});

init();
