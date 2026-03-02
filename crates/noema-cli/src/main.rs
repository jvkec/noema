//! CLI entry point for the Noema backend (for dev and testing).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use clap::Parser;
use serde::Serialize;
use std::fmt::Write;
use noema_core::{
    app_data_dir, build_index, build_persisted_index, chunk_notes, default_index_path,
    get_notes_root, load_config, scan_notes, set_model_config, set_notes_root, unset_model_config,
    status, update_persisted_index, watch_notes, IndexSettings, OllamaClient, PersistedIndex,
    DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL, INDEX_SCHEMA_VERSION,
};

#[derive(Parser)]
#[command(name = "noema")]
#[command(about = "Noema: local-first knowledge assistant")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Show backend status (for dev).
    Status,
    /// Show where Noema stores its config and index (app data directory).
    DataDir,
    /// Show the configured notes root (if any).
    ShowRoot,
    /// Show the default persisted index path.
    IndexPath,
    /// Set the notes root directory (persisted for future use).
    SetRoot {
        /// Path to your notes folder.
        #[arg(value_name = "PATH")]
        path: PathBuf,
    },
    /// View or edit config (model defaults, etc.).
    Config {
        #[command(subcommand)]
        sub: ConfigSub,
    },
    /// Scan a directory for markdown notes. Uses configured root if PATH omitted.
    Scan {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Chunk notes for embedding. Uses configured root if PATH omitted.
    Chunks {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Max characters per chunk (default: 512).
        #[arg(long, default_value = "512")]
        max_chars: usize,
    },
    /// Watch notes directory and re-scan when files change. Ctrl+C to stop.
    Watch {
        /// Root directory to watch (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Also rebuild and persist the index on every change.
        #[arg(long, default_value_t = false)]
        persist: bool,
        /// Max characters per chunk (default: 512). Used when `--persist`.
        #[arg(long, default_value = "512")]
        max_chars: usize,
        /// Ollama base URL (default: http://localhost:11434). Used when `--persist`.
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text). Used when `--persist`.
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
    /// Embed text with Ollama (requires Ollama running and an embedding model).
    Embed {
        /// Text to embed.
        #[arg(value_name = "TEXT")]
        text: String,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
    /// Index notes: scan, chunk, embed, store in memory. Prints stats. No persistence.
    Index {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Max characters per chunk (default: 512).
        #[arg(long, default_value = "512")]
        max_chars: usize,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
    /// Initialize and persist the notes index: set root (optional), build index, save to disk.
    Init {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Max characters per chunk (default: 512).
        #[arg(long, default_value = "512")]
        max_chars: usize,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
    /// Query the persisted index without rebuilding it.
    Query {
        /// Search query.
        #[arg(value_name = "QUERY")]
        query: String,
        /// Max results to return (default: 5).
        #[arg(long, short, default_value = "5")]
        k: usize,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
        /// Filter to notes whose frontmatter tags contain all of these (repeatable).
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// Output results as JSON instead of text.
        #[arg(long, default_value_t = false)]
        json: bool,
        /// Group results by note and aggregate scores per note.
        #[arg(long, default_value_t = false)]
        by_note: bool,
        /// Max chunks to show per note when grouping.
        #[arg(long, default_value = "3")]
        per_note_chunks: usize,
        /// Open the top result in the default application.
        #[arg(long, default_value_t = false)]
        open: bool,
    },
    /// Ask a question and synthesize an answer from the persisted index.
    Ask {
        /// Question to answer.
        #[arg(value_name = "QUESTION")]
        question: String,
        /// Max chunks to retrieve (default: 6).
        #[arg(long, short = 'k', default_value = "6")]
        k: usize,
        /// Ollama base URL for the chat/completion model.
        #[arg(long, default_value = "http://localhost:11434")]
        chat_url: String,
        /// Chat/completion model (default: llama3.1).
        #[arg(long, default_value = "llama3.1")]
        chat_model: String,
        /// Filter to notes whose frontmatter tags contain all of these (repeatable).
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// Output answer and sources as JSON instead of text.
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Search notes: runs index pipeline then finds chunks similar to query. No persistence.
    /// (Use `query` for persisted index.)
    Search {
        /// Search query.
        #[arg(value_name = "QUERY")]
        query: String,
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Max results to return (default: 5).
        #[arg(long, short, default_value = "5")]
        k: usize,
        /// Max characters per chunk (default: 512).
        #[arg(long, default_value = "512")]
        max_chars: usize,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
}

#[derive(clap::Subcommand)]
enum ConfigSub {
    /// Show current config.
    Show,
    /// Set a config key (embed_url, embed_model, chat_url, chat_model, default_k).
    Set {
        #[arg(value_name = "KEY")]
        key: String,
        #[arg(value_name = "VALUE")]
        value: String,
    },
    /// Unset a config key (revert to compiled default).
    Unset {
        #[arg(value_name = "KEY")]
        key: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Status) {
        Commands::Status => {
            println!("Noema backend");
            println!("  core: {}", status());
        }
        Commands::DataDir => {
            match app_data_dir() {
                Some(p) => println!("{}", p.display()),
                None => eprintln!("Could not determine app data directory."),
            }
        }
        Commands::ShowRoot => match get_notes_root() {
            Some(p) => println!("{}", p.display()),
            None => eprintln!("No notes root configured."),
        },
        Commands::IndexPath => match default_index_path() {
            Some(p) => println!("{}", p.display()),
            None => eprintln!("Could not determine app data directory."),
        },
        Commands::SetRoot { path } => {
            match set_notes_root(&path) {
                Ok(()) => println!("Notes root set to {}", path.display()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Config { sub } => match sub {
            ConfigSub::Show => {
                let cfg = load_config();
                println!("notes_root: {:?}", cfg.notes_root);
                println!("embed_url: {:?}", cfg.models.embed_url);
                println!("embed_model: {:?}", cfg.models.embed_model);
                println!("chat_url: {:?}", cfg.models.chat_url);
                println!("chat_model: {:?}", cfg.models.chat_model);
                println!("default_k: {:?}", cfg.models.default_k);
            }
            ConfigSub::Set { key, value } => {
                match set_model_config(&key, &value) {
                    Ok(()) => println!("Set {} = {}", key, value),
                    Err(e) => eprintln!("Error: {}", e),
                }
            }
            ConfigSub::Unset { key } => {
                match unset_model_config(&key) {
                    Ok(()) => println!("Unset {}", key),
                    Err(e) => eprintln!("Error: {}", e),
                }
            }
        },
        Commands::Scan { path } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            match scan_notes(&root) {
                Ok(notes) => {
                    println!("Scanned {} note(s) under {}", notes.len(), root.display());
                    for n in notes {
                        let title = n
                            .frontmatter
                            .as_ref()
                            .and_then(|fm| fm.title.as_deref())
                            .unwrap_or_else(|| n.body.lines().next().unwrap_or("").trim());
                        let preview =
                            if title.len() > 60 { format!("{}...", &title[..60]) } else { title.to_string() };
                        println!("  {}  {}", n.path.display(), preview);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Chunks { path, max_chars } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            match scan_notes(&root) {
                Ok(notes) => {
                    let chunks = chunk_notes(&notes, max_chars);
                    println!("Chunked {} note(s) into {} chunk(s) (max {} chars)", notes.len(), chunks.len(), max_chars);
                    for c in chunks.iter().take(10) {
                        let preview: String = c.text.chars().take(50).collect();
                        let suffix = if c.text.len() > 50 { "…" } else { "" };
                        println!("  [{}] {}  {}{}", c.index, c.note_path.display(), preview, suffix);
                    }
                    if chunks.len() > 10 {
                        println!("  ... and {} more", chunks.len() - 10);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Watch {
            path,
            persist,
            max_chars,
            url,
            model,
        } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            println!(
                "Watching {}. Edit notes to trigger re-scan. Ctrl+C to stop.",
                root.display()
            );

            if let Ok(notes) = scan_notes(&root) {
                println!("Initial scan: {} note(s)", notes.len());
            }

            if !persist {
                if let Err(e) = watch_notes(&root, |res| match res {
                    Ok(notes) => println!("Rescanned: {} note(s)", notes.len()),
                    Err(e) => eprintln!("Scan error: {}", e),
                }) {
                    eprintln!("Error: {}", e);
                }
                return;
            }

            let index_path = match default_index_path() {
                Some(p) => p,
                None => {
                    eprintln!("Could not determine app data directory.");
                    return;
                }
            };

            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };

            let root_str = root.to_string_lossy().into_owned();
            let settings = IndexSettings {
                notes_root: root_str.clone(),
                max_chars,
                ollama_url: url.clone(),
                embed_model: model.clone(),
            };

            // Build once before starting the watch loop.
            let notes = match scan_notes(&root) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Scan error: {}", e);
                    return;
                }
            };

            let idx = match build_persisted_index(notes, &client, settings.clone()).await {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("Error building initial index: {}", e);
                    return;
                }
            };

            if let Err(e) = idx.save_to_file(&index_path) {
                eprintln!("Error saving index: {}", e);
                return;
            }
            println!(
                "Persist enabled. Saved initial index to {} ({} chunks)",
                index_path.display(),
                idx.store.len()
            );

            let handle = tokio::runtime::Handle::current();
            let rebuilding = Arc::new(AtomicBool::new(false));
            let rebuilding_for_cb = rebuilding.clone();
            let client_for_cb = client.clone();
            let index_path_for_cb = index_path.clone();
            let idx_for_cb = Arc::new(Mutex::new(idx));
            let idx_for_cb2 = idx_for_cb.clone();

            println!("Watching with persistence (incremental updates on change).");
            if let Err(e) = watch_notes(&root, move |res| {
                let notes = match res {
                    Ok(n) => n,
                    Err(e) => {
                        eprintln!("Scan error: {}", e);
                        return;
                    }
                };

                // Prevent overlapping rebuilds if events burst.
                if rebuilding_for_cb.swap(true, Ordering::SeqCst) {
                    return;
                }

                let build = async {
                    let mut guard = match idx_for_cb2.lock() {
                        Ok(g) => g,
                        Err(_) => {
                            eprintln!("Index lock poisoned.");
                            return;
                        }
                    };

                    if guard.schema_version != INDEX_SCHEMA_VERSION {
                        eprintln!(
                            "Index schema mismatch (found {}, expected {}). Rebuild with `noema init`.",
                            guard.schema_version, INDEX_SCHEMA_VERSION
                        );
                        return;
                    }

                    match update_persisted_index(&mut guard, notes, &client_for_cb).await {
                        Ok(stats) => match guard.save_to_file(&index_path_for_cb) {
                            Ok(()) => println!(
                                "Index updated: {} changed, {} deleted, chunks {} (+{}, -{})",
                                stats.changed_notes,
                                stats.deleted_notes,
                                stats.total_chunks,
                                stats.added_chunks,
                                stats.removed_chunks
                            ),
                            Err(e) => eprintln!("Error saving index: {}", e),
                        },
                        Err(e) => eprintln!("Error updating index: {}", e),
                    }
                };

                // Run async rebuild using the existing Tokio runtime.
                handle.block_on(build);
                rebuilding_for_cb.store(false, Ordering::SeqCst);
            }) {
                eprintln!("Error: {}", e);
            }
        }
        Commands::Embed { text, url, model } => {
            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };
            match client.embed(&text).await {
                Ok(emb) => println!("Embedding: {} dimensions", emb.len()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Index {
            path,
            max_chars,
            url,
            model,
        } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };
            match build_index(&root, &client, Some(max_chars)).await {
                Ok(store) => println!("Indexed {} chunk(s) (in memory, no persistence)", store.len()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Search {
            query,
            path,
            k,
            max_chars,
            url,
            model,
        } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };
            match build_index(&root, &client, Some(max_chars)).await {
                Ok(store) => {
                    match client.embed(&query).await {
                        Ok(q_emb) => {
                            let results = store.search(&q_emb, k);
                            for (i, (chunk, score)) in results.iter().enumerate() {
                                let preview: String = chunk.text.chars().take(80).collect();
                                let suffix = if chunk.text.len() > 80 { "…" } else { "" };
                                println!(
                                    "{}  [{}] {}  {:.3}\n    {}{}",
                                    i + 1,
                                    chunk.index,
                                    chunk.note_path.display(),
                                    score,
                                    preview,
                                    suffix
                                );
                            }
                        }
                        Err(e) => eprintln!("Error embedding query: {}", e),
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Init {
            path,
            max_chars,
            url,
            model,
        } => {
            // Optionally set notes root if a path is provided; otherwise use configured root.
            let root = if let Some(p) = path {
                if let Err(e) = set_notes_root(&p) {
                    eprintln!("Error setting notes root: {}", e);
                    return;
                }
                p
            } else if let Some(existing) = get_notes_root() {
                existing
            } else {
                eprintln!("No notes root configured. Run: noema init <PATH> or noema set-root <PATH>");
                return;
            };

            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };

            let notes = match scan_notes(&root) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Error scanning notes: {}", e);
                    return;
                }
            };

            let index_path = match default_index_path() {
                Some(p) => p,
                None => {
                    eprintln!("Could not determine app data directory.");
                    return;
                }
            };

            let settings = IndexSettings {
                notes_root: root.to_string_lossy().into_owned(),
                max_chars,
                ollama_url: url.clone(),
                embed_model: model.clone(),
            };

            match build_persisted_index(notes, &client, settings).await {
                Ok(idx) => {
                    let count = idx.store.len();
                    match idx.save_to_file(&index_path) {
                        Ok(()) => println!(
                            "Indexed {} chunk(s) and saved index to {}",
                            count,
                            index_path.display()
                        ),
                        Err(e) => eprintln!("Error saving index: {}", e),
                    }
                }
                Err(e) => eprintln!("Error building index: {}", e),
            }
        }
        Commands::Query {
            query,
            k,
            url,
            model,
            tags,
            json,
            by_note,
            per_note_chunks,
            open,
        } => {
            let index_path = match default_index_path() {
                Some(p) => p,
                None => {
                    eprintln!("Could not determine app data directory.");
                    return;
                }
            };

            let idx = match PersistedIndex::load_from_file(&index_path) {
                Ok(i) => i,
                Err(e) => {
                    eprintln!(
                        "Error loading index from {}: {}. Run `noema init` first.",
                        index_path.display(),
                        e
                    );
                    return;
                }
            };

            if idx.schema_version != INDEX_SCHEMA_VERSION {
                eprintln!(
                    "Index schema mismatch (found {}, expected {}). Rebuild with `noema init`.",
                    idx.schema_version, INDEX_SCHEMA_VERSION
                );
                return;
            }

            if idx.store.is_empty() {
                eprintln!(
                    "Index at {} is empty. Run `noema init` to build it.",
                    index_path.display()
                );
                return;
            }

            // Load optional model defaults from config.
            let cfg = load_config();
            let mut effective_url = url.clone();
            let mut effective_model = model.clone();

            if effective_url == DEFAULT_BASE_URL {
                if let Some(u) = cfg.models.embed_url {
                    effective_url = u;
                }
            }
            if effective_model == DEFAULT_EMBED_MODEL {
                if let Some(m) = cfg.models.embed_model {
                    effective_model = m;
                }
            }

            let mut effective_k = k;
            if k == 5 {
                if let Some(default_k) = cfg.models.default_k {
                    effective_k = default_k;
                }
            }

            if idx.settings.ollama_url != effective_url || idx.settings.embed_model != effective_model {
                eprintln!(
                    "Warning: querying with Ollama settings that differ from the index.\n  index: url={}, model={}\n  query: url={}, model={}",
                    idx.settings.ollama_url, idx.settings.embed_model, url, model
                );
            }

            let client = match OllamaClient::from_url(&effective_url) {
                Ok(c) => c.with_embed_model(&effective_model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };

            #[derive(Clone, Serialize)]
            struct NoteMeta {
                title: Option<String>,
                date: Option<String>,
                tags: Vec<String>,
            }

            // Build a small metadata map from current notes on disk.
            let mut note_meta: HashMap<String, NoteMeta> = HashMap::new();
            if let Ok(notes) = scan_notes(std::path::Path::new(&idx.settings.notes_root)) {
                for n in notes {
                    let fm = match n.frontmatter.as_ref() {
                        Some(fm) => fm,
                        None => continue,
                    };
                    let key = n.path.display().to_string();
                    note_meta.insert(
                        key,
                        NoteMeta {
                            title: fm.title.clone(),
                            date: fm.date.clone(),
                            tags: fm.tags.clone(),
                        },
                    );
                }
            }

            let tag_filter_active = !tags.is_empty();

            match client.embed(&query).await {
                Ok(q_emb) => {
                    // Pull more than k candidates when tag filters are active so we can
                    // filter down and still return up to k matches.
                    let search_k = if tag_filter_active {
                        effective_k.saturating_mul(4)
                    } else {
                        effective_k
                    };
                    let raw_results = idx.store.search(&q_emb, search_k);
                    let mut results: Vec<(noema_core::Chunk, f32)> = Vec::new();

                    for (chunk, score) in raw_results {
                        if tag_filter_active {
                            let note_key = chunk.note_path.display().to_string();
                            let meta = note_meta.get(&note_key);
                            let ok = match meta {
                                Some(m) => tags.iter().all(|t| m.tags.iter().any(|mt| mt == t)),
                                None => false,
                            };
                            if !ok {
                                continue;
                            }
                        }
                        results.push((chunk, score));
                        if results.len() >= k {
                            break;
                        }
                    }

                    if results.is_empty() {
                        println!("No results.");
                        return;
                    }

                    if json {
                        if by_note {
                            #[derive(Serialize)]
                            struct JsonChunk {
                                note_path: String,
                                chunk_index: usize,
                                score: f32,
                                preview: String,
                            }

                            #[derive(Serialize)]
                            struct JsonNote {
                                note_path: String,
                                score: f32,
                                title: Option<String>,
                                date: Option<String>,
                                tags: Vec<String>,
                                chunks: Vec<JsonChunk>,
                            }

                            #[derive(Serialize)]
                            struct JsonResponse {
                                query: String,
                                k: usize,
                                by_note: bool,
                                results: Vec<JsonNote>,
                            }

                            let mut grouped: BTreeMap<String, (f32, Vec<(usize, &noema_core::Chunk, f32)>)> =
                                BTreeMap::new();
                            for (chunk, score) in &results {
                                let key = chunk.note_path.display().to_string();
                                let entry = grouped.entry(key).or_insert((0.0, Vec::new()));
                                if *score > entry.0 {
                                    entry.0 = *score;
                                }
                                entry.1.push((chunk.index, chunk, *score));
                            }

                            let mut notes_vec: Vec<JsonNote> = grouped
                                .into_iter()
                                .map(|(note_path, (score, mut chs))| {
                                    chs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
                                    chs.truncate(per_note_chunks);
                                    let chunks = chs
                                        .into_iter()
                                        .map(|(idx_i, ch, s)| JsonChunk {
                                            note_path: note_path.clone(),
                                            chunk_index: idx_i,
                                            score: s,
                                            preview: {
                                                let mut p: String = ch.text.chars().take(80).collect();
                                                if ch.text.chars().count() > 80 {
                                                    p.push('…');
                                                }
                                                p
                                            },
                                        })
                                        .collect();
                                    let meta = note_meta.get(&note_path);
                                    let (title, date, tags) = match meta {
                                        Some(m) => (m.title.clone(), m.date.clone(), m.tags.clone()),
                                        None => (None, None, Vec::new()),
                                    };
                                    JsonNote {
                                        note_path,
                                        score,
                                        title,
                                        date,
                                        tags,
                                        chunks,
                                    }
                                })
                                .collect();
                            notes_vec.sort_by(|a, b| {
                                b.score
                                    .partial_cmp(&a.score)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            });

                            let resp = JsonResponse {
                                query,
                                k,
                                by_note: true,
                                results: notes_vec,
                            };
                            match serde_json::to_string_pretty(&resp) {
                                Ok(s) => println!("{}", s),
                                Err(e) => eprintln!("Error serializing JSON: {}", e),
                            }
                        } else {
                            #[derive(Serialize)]
                            struct JsonChunk {
                                note_path: String,
                                chunk_index: usize,
                                score: f32,
                                preview: String,
                                title: Option<String>,
                                date: Option<String>,
                                tags: Vec<String>,
                            }

                            #[derive(Serialize)]
                            struct JsonResponse {
                                query: String,
                                k: usize,
                                by_note: bool,
                                results: Vec<JsonChunk>,
                            }

                            let chunks: Vec<JsonChunk> = results
                                .iter()
                                .map(|(chunk, score)| JsonChunk {
                                    note_path: chunk.note_path.display().to_string(),
                                    chunk_index: chunk.index,
                                    score: *score,
                                    preview: {
                                        let mut p: String = chunk.text.chars().take(80).collect();
                                        if chunk.text.chars().count() > 80 {
                                            p.push('…');
                                        }
                                        p
                                    },
                                    title: note_meta
                                        .get(&chunk.note_path.display().to_string())
                                        .and_then(|m| m.title.clone()),
                                    date: note_meta
                                        .get(&chunk.note_path.display().to_string())
                                        .and_then(|m| m.date.clone()),
                                    tags: note_meta
                                        .get(&chunk.note_path.display().to_string())
                                        .map(|m| m.tags.clone())
                                        .unwrap_or_default(),
                                })
                                .collect();

                            let resp = JsonResponse {
                                query,
                                k,
                                by_note: false,
                                results: chunks,
                            };
                            match serde_json::to_string_pretty(&resp) {
                                Ok(s) => println!("{}", s),
                                Err(e) => eprintln!("Error serializing JSON: {}", e),
                            }
                        }
                    } else if by_note {
                        let mut grouped: BTreeMap<String, (f32, Vec<(usize, &noema_core::Chunk, f32)>)> =
                            BTreeMap::new();
                        for (chunk, score) in &results {
                            let key = chunk.note_path.display().to_string();
                            let entry = grouped.entry(key).or_insert((0.0, Vec::new()));
                            if *score > entry.0 {
                                entry.0 = *score;
                            }
                            entry.1.push((chunk.index, chunk, *score));
                        }

                        let mut notes_vec: Vec<(String, f32, Vec<(usize, &noema_core::Chunk, f32)>)> =
                            grouped
                                .into_iter()
                                .map(|(note_path, (score, mut chs))| {
                                    chs.sort_by(|a, b| {
                                        b.2.partial_cmp(&a.2)
                                            .unwrap_or(std::cmp::Ordering::Equal)
                                    });
                                    chs.truncate(per_note_chunks);
                                    (note_path, score, chs)
                                })
                                .collect();
                        notes_vec.sort_by(|a, b| {
                            b.1.partial_cmp(&a.1)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });

                        for (i, (note_path, score, chs)) in notes_vec.iter().enumerate() {
                            if let Some(meta) = note_meta.get(note_path) {
                                let title = meta.title.as_deref().unwrap_or("");
                                let date = meta.date.as_deref().unwrap_or("");
                                if !title.is_empty() || !date.is_empty() {
                                    println!("{}  {}  {:.3}", i + 1, note_path, score);
                                    println!("    {}{}", title, if !date.is_empty() { format!(" [{}]", date) } else { "".to_string() });
                                } else {
                                    println!("{}  {}  {:.3}", i + 1, note_path, score);
                                }
                            } else {
                                println!("{}  {}  {:.3}", i + 1, note_path, score);
                            }
                            for (idx_i, ch, s) in chs {
                                let preview: String = ch.text.chars().take(80).collect();
                                let suffix = if ch.text.chars().count() > 80 {
                                    "…"
                                } else {
                                    ""
                                };
                                println!(
                                    "    [{}] {:.3}  {}{}",
                                    idx_i, s, preview, suffix
                                );
                            }
                        }
                    } else {
                        for (i, (chunk, score)) in results.iter().enumerate() {
                            let preview: String = chunk.text.chars().take(80).collect();
                            let suffix = if chunk.text.chars().count() > 80 { "…" } else { "" };
                            println!(
                                "{}  [{}] {}  {:.3}\n    {}{}",
                                i + 1,
                                chunk.index,
                                chunk.note_path.display(),
                                score,
                                preview,
                                suffix
                            );
                        }
                    }

                    if open {
                        let path_to_open = if by_note {
                            // When grouped, open the top note.
                            let top = results
                                .iter()
                                .max_by(|a, b| {
                                    a.1.partial_cmp(&b.1)
                                        .unwrap_or(std::cmp::Ordering::Equal)
                                })
                                .map(|(chunk, _)| chunk.note_path.clone());
                            top
                        } else {
                            results
                                .get(0)
                                .map(|(chunk, _)| chunk.note_path.clone())
                        };

                        if let Some(path) = path_to_open {
                            if let Err(e) =
                                std::process::Command::new("open").arg(&path).spawn()
                            {
                                eprintln!("Error opening note {}: {}", path.display(), e);
                            }
                        } else {
                            eprintln!("No result to open.");
                        }
                    }
                }
                Err(e) => eprintln!("Error embedding query: {}", e),
            }
        }
        Commands::Ask {
            question,
            k,
            chat_url,
            chat_model,
            tags,
            json,
        } => {
            let index_path = match default_index_path() {
                Some(p) => p,
                None => {
                    eprintln!("Could not determine app data directory.");
                    return;
                }
            };

            let idx = match PersistedIndex::load_from_file(&index_path) {
                Ok(i) => i,
                Err(e) => {
                    eprintln!(
                        "Error loading index from {}: {}. Run `noema init` first.",
                        index_path.display(),
                        e
                    );
                    return;
                }
            };

            if idx.schema_version != INDEX_SCHEMA_VERSION {
                eprintln!(
                    "Index schema mismatch (found {}, expected {}). Rebuild with `noema init`.",
                    idx.schema_version, INDEX_SCHEMA_VERSION
                );
                return;
            }

            if idx.store.is_empty() {
                eprintln!(
                    "Index at {} is empty. Run `noema init` to build it.",
                    index_path.display()
                );
                return;
            }

            #[derive(Clone, Serialize)]
            struct NoteMeta {
                title: Option<String>,
                date: Option<String>,
                tags: Vec<String>,
            }

            // Build a small metadata map from current notes on disk.
            let mut note_meta: HashMap<String, NoteMeta> = HashMap::new();
            if let Ok(notes) = scan_notes(std::path::Path::new(&idx.settings.notes_root)) {
                for n in notes {
                    let fm = match n.frontmatter.as_ref() {
                        Some(fm) => fm,
                        None => continue,
                    };
                    let key = n.path.display().to_string();
                    note_meta.insert(
                        key,
                        NoteMeta {
                            title: fm.title.clone(),
                            date: fm.date.clone(),
                            tags: fm.tags.clone(),
                        },
                    );
                }
            }

            let tag_filter_active = !tags.is_empty();

            // Load optional model defaults from config.
            let cfg = load_config();
            let mut effective_chat_url = chat_url.clone();
            let mut effective_chat_model = chat_model.clone();
            let mut effective_k = k;

            if effective_chat_url == DEFAULT_BASE_URL {
                if let Some(u) = cfg.models.chat_url {
                    effective_chat_url = u;
                }
            }
            if effective_chat_model == DEFAULT_CHAT_MODEL {
                if let Some(m) = cfg.models.chat_model {
                    effective_chat_model = m;
                }
            }
            if k == 6 {
                if let Some(default_k) = cfg.models.default_k {
                    effective_k = default_k;
                }
            }

            // Use the index's embedding settings for query embedding.
            let embed_client = match OllamaClient::from_url(&idx.settings.ollama_url) {
                Ok(c) => c.with_embed_model(idx.settings.embed_model.clone()),
                Err(e) => {
                    eprintln!("Error creating embed client: {}", e);
                    return;
                }
            };

            let q_emb = match embed_client.embed(&question).await {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error embedding question: {}", e);
                    return;
                }
            };

            // Pull more than k candidates when tag filters are active so we can
            // filter down and still return up to k matches.
            let search_k = if tag_filter_active {
                effective_k.saturating_mul(4)
            } else {
                effective_k
            };
            let raw_results = idx.store.search(&q_emb, search_k);
            let mut results: Vec<(noema_core::Chunk, f32)> = Vec::new();

            for (chunk, score) in raw_results {
                if tag_filter_active {
                    let note_key = chunk.note_path.display().to_string();
                    let meta = note_meta.get(&note_key);
                    let ok = match meta {
                        Some(m) => tags.iter().all(|t| m.tags.iter().any(|mt| mt == t)),
                        None => false,
                    };
                    if !ok {
                        continue;
                    }
                }
                results.push((chunk, score));
                if results.len() >= effective_k {
                    break;
                }
            }

            if results.is_empty() {
                println!("No results.");
                return;
            }

            // Build context from top chunks.
            let mut context = String::new();
            for (i, (chunk, score)) in results.iter().enumerate() {
                let note_key = chunk.note_path.display().to_string();
                let meta = note_meta.get(&note_key);
                let title = meta
                    .and_then(|m| m.title.as_deref())
                    .unwrap_or_else(|| note_key.as_str());
                let _ = writeln!(
                    &mut context,
                    "[{}] {} (score {:.3})\n{}\n",
                    i + 1,
                    title,
                    score,
                    chunk.text
                );
            }

            let prompt = format!(
                "You are Noema, a local-first knowledge assistant. Use ONLY the following note excerpts as context. If the context is insufficient, say you don't know.\n\nContext:\n{}\nQuestion:\n{}\n\nAnswer in a concise paragraph or two:\n",
                context, question
            );

            let chat_client = match OllamaClient::from_url(&effective_chat_url) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Error creating chat client: {}", e);
                    return;
                }
            };

            let answer = match chat_client.generate(&effective_chat_model, &prompt).await {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("Error generating answer: {}", e);
                    return;
                }
            };

            if json {
                #[derive(Serialize)]
                struct JsonSource {
                    note_path: String,
                    title: Option<String>,
                    chunk_index: usize,
                    score: f32,
                }

                #[derive(Serialize)]
                struct JsonAskResponse {
                    question: String,
                    answer: String,
                    sources: Vec<JsonSource>,
                }

                let mut sources: Vec<JsonSource> = Vec::new();
                for (chunk, score) in &results {
                    let note_key = chunk.note_path.display().to_string();
                    let meta = note_meta.get(&note_key);
                    let title = meta.and_then(|m| m.title.clone());
                    sources.push(JsonSource {
                        note_path: note_key,
                        title,
                        chunk_index: chunk.index,
                        score: *score,
                    });
                }

                let resp = JsonAskResponse {
                    question,
                    answer,
                    sources,
                };

                match serde_json::to_string_pretty(&resp) {
                    Ok(s) => println!("{}", s),
                    Err(e) => eprintln!("Error serializing JSON: {}", e),
                }
            } else {
                println!("{}", answer.trim());
                println!();
                println!("Sources:");
                for (i, (chunk, score)) in results.iter().enumerate() {
                    let note_key = chunk.note_path.display().to_string();
                    let meta = note_meta.get(&note_key);
                    let title = meta
                        .and_then(|m| m.title.as_deref())
                        .unwrap_or_else(|| note_key.as_str());
                    println!("{}  {}  [{:.3}]  chunk {}", i + 1, title, score, chunk.index);
                }
            }
        }
    }
}
