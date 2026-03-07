# noema

Local-first AI-powered knowledge base built on your existing markdown notes.

Noema scans a notes folder you choose, chunks and embeds the content with a local
Ollama model, and keeps a persisted, incrementally-updated vector index on disk.
You can use the **CLI** or the **Tauri desktop app**; both share the same Rust
backend and config/index.

## Features (current)

- **Desktop app (Tauri)** – Minimal search UI: `npm run tauri dev`.
- **CLI** – Full workflow: set-root, init, query, ask, config, watch.
- **Single notes root** – One folder; config and index live in app data (see `noema data-dir`).
- **Chunking + embeddings** – Markdown-aware chunks, embeddings via Ollama.
- **Persisted index** – `init` / `query`; incremental updates via `watch --persist`.
- **RAG-style ask** – `noema ask "question"` with optional tag filters.
- **Memory engine** – Local life-signal extraction + salience ranking via `noema memory`.
- **Config** – Model defaults (embed/chat URL and model, default_k) via `noema config`.

## Quick start

### Install the CLI (optional)

From the repo root, install the `noema` binary so you can run it from anywhere:

```bash
cargo install --path crates/noema-cli --bin noema
```

Ensure `~/.cargo/bin` is on your PATH. Alternatively, use `cargo run -p noema-cli --` in place of `noema` in the examples below.

### 1. Point Noema at your notes

```bash
noema set-root /path/to/your/notes
noema scan          # uses configured root
noema chunks       # show how notes are chunked
```

Override the root by passing a path: `noema scan /some/other/folder`.

### 2. Build and query the index

Run Ollama with an embedding model (e.g. `ollama pull nomic-embed-text`, `ollama serve`), then:

```bash
noema init --max-chars 512
noema query "search terms" -k 5
noema query "search terms" --by-note --per-note-chunks 3 --json
```

### 3. Keep the index fresh

```bash
noema watch                    # re-scan only
noema watch --persist --max-chars 512   # incremental index updates
```

### 4. Config (model defaults)

```bash
noema config show
noema config set chat_model llama3:latest
noema config set default_k 8
noema config unset chat_model
```

Keys: `embed_url`, `embed_model`, `chat_url`, `chat_model`, `default_k`.

### 5. Desktop app (Tauri)

```bash
npm install
npm run tauri dev
```

Requires: notes root set (`noema set-root <path>`), index built (`noema init`), Ollama running. The app uses the same config and index as the CLI.

### 6. Ask (RAG)

```bash
noema ask "Your question here" -k 6
```

Uses the persisted index and a chat model (default from config or `--chat-model`).

### 7. Memory overview (life repo)

```bash
noema memory --limit 8
noema memory --json
```

Builds ranked memory cards from your markdown notes using local heuristics:
life-area inference, open loops, goal/decision extraction, emotional tone, and
corpus-aware salience scoring.

## App data and paths

- **Your notes** – Any folder you choose; Noema only reads and indexes it.
- **Noema data** – Config and index live in an app data directory (macOS: `~/Library/Application Support/app.Noema.Noema/`). See `noema data-dir` and `noema index-path`.

## Docs

- `infra_docs/` – BACKEND.md, LOCAL_DEV.md, DATA.md, ARCHITECTURE.md, TOP_LEVEL.md.
- `infra_docs/MEMORY_ENGINE.md` – memory extraction and scoring model.
- `ux_docs/` – UX notes for the Tauri app.
