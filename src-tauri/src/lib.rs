//! Tauri app entry point. Exposes noema-core commands to the frontend.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use noema_core::{
    build_memory_overview, default_index_path, get_notes_root as core_get_notes_root, load_config,
    scan_notes, MemoryOverview, OllamaClient, PersistedIndex, DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL,
    DEFAULT_EMBED_MODEL, INDEX_SCHEMA_VERSION,
};
use serde::Serialize;

fn notes_root() -> Result<PathBuf, String> {
    match core_get_notes_root() {
        Some(p) => {
            if p.is_dir() {
                Ok(p)
            } else {
                Err(format!("Notes root is not a directory: {}", p.display()))
            }
        }
        None => Err("No notes root configured. Run `noema set-root <PATH>`.".to_string()),
    }
}

fn make_relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

fn chunk_note_exists(note_path: &Path, index_root: &Path, current_root: Option<&Path>) -> bool {
    if note_path.is_absolute() && note_path.is_file() {
        return true;
    }
    if index_root.join(note_path).is_file() {
        return true;
    }
    if let Some(root) = current_root {
        if root.join(note_path).is_file() {
            return true;
        }
    }
    false
}

fn resolve_existing_note_path(
    note_path: &Path,
    index_root: &Path,
    current_root: Option<&Path>,
) -> Option<PathBuf> {
    if note_path.is_absolute() && note_path.is_file() {
        return Some(note_path.to_path_buf());
    }
    let from_index = index_root.join(note_path);
    if from_index.is_file() {
        return Some(from_index);
    }
    if let Some(root) = current_root {
        let from_current = root.join(note_path);
        if from_current.is_file() {
            return Some(from_current);
        }
    }
    None
}

fn split_note_content(raw: &str) -> (String, String) {
    // Very simple heuristic: first non-empty line is the title, rest is body.
    let mut lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return ("".to_string(), "".to_string());
    }
    let mut title = String::new();
    let mut first_body_idx = 0usize;
    for (idx, line) in lines.iter().enumerate() {
        if !line.trim().is_empty() {
            title = line.trim().to_string();
            first_body_idx = idx + 1;
            break;
        }
    }
    if title.is_empty() {
        return ("".to_string(), raw.to_string());
    }
    let body = if first_body_idx >= lines.len() {
        String::new()
    } else {
        lines.split_off(first_body_idx).join("\n")
    };
    (title, body)
}

fn join_note_content(title: &str, body: &str) -> String {
    if title.trim().is_empty() {
        body.to_string()
    } else if body.trim().is_empty() {
        format!("{}\n", title.trim())
    } else {
        format!("{}\n\n{}", title.trim(), body)
    }
}

#[derive(Serialize, Clone)]
pub struct NoteListItem {
    pub path: String,
    pub title: String,
}

#[derive(Serialize, Clone)]
pub struct NoteDetail {
    pub path: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub note_path: String,
    pub score: f32,
    pub preview: String,
    pub text: String,
}

#[derive(Serialize)]
pub struct AskSource {
    pub note_path: String,
    pub title: Option<String>,
    pub chunk_index: usize,
    pub score: f32,
}

#[derive(Serialize)]
pub struct AskResponse {
    pub question: String,
    pub answer: String,
    pub sources: Vec<AskSource>,
}

#[tauri::command]
fn list_chat_models() -> Result<Vec<String>, String> {
    let output = Command::new("ollama")
        .arg("list")
        .output()
        .map_err(|e| format!("Failed to run `ollama list`: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "`ollama list` exited with status: {}",
            output.status
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut models = Vec::new();

    for (idx, line) in stdout.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip header row if present (e.g. "NAME  SIZE  ...").
        if idx == 0 && trimmed.to_ascii_lowercase().contains("name") {
            continue;
        }
        let name = trimmed.split_whitespace().next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        // Heuristic: filter out obvious embedding models.
        if lower.contains("embed") || lower.contains("embedding") {
            continue;
        }
        models.push(name.to_string());
    }

    Ok(models)
}

#[tauri::command]
fn get_notes_root() -> Option<String> {
    core_get_notes_root().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn status() -> String {
    noema_core::status().to_string()
}

#[tauri::command]
fn rebuild_index() -> Result<String, String> {
    let output = Command::new("noema")
        .arg("init")
        .output()
        .map_err(|e| format!("Failed to run `noema init`: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("`noema init` failed with status {}", output.status));
        }
        return Err(format!("`noema init` failed: {}", stderr));
    }

    Ok("index rebuilt".to_string())
}

#[tauri::command]
fn list_notes() -> Result<Vec<NoteListItem>, String> {
    let root = notes_root()?;
    let notes = scan_notes(&root).map_err(|e| e.to_string())?;
    let mut items: Vec<NoteListItem> = notes
        .into_iter()
        .map(|n| {
            let rel = make_relative(&root, &n.path);
            let title = n
                .frontmatter
                .as_ref()
                .and_then(|fm| fm.title.clone())
                .or_else(|| {
                    n.body
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .map(|s| s.trim().to_string())
                })
                .unwrap_or_else(|| rel.clone());
            NoteListItem { path: rel, title }
        })
        .collect();
    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(items)
}

#[tauri::command]
fn read_note(path: String) -> Result<NoteDetail, String> {
    let root = notes_root()?;
    let p = Path::new(&path);
    let abs = if p.is_absolute() {
        PathBuf::from(p)
    } else {
        root.join(p)
    };
    if !abs.starts_with(&root) {
        return Err("Path is outside notes root".to_string());
    }
    let raw =
        fs::read_to_string(&abs).map_err(|e| format!("Failed to read {}: {}", abs.display(), e))?;
    let (title, body) = split_note_content(&raw);
    Ok(NoteDetail {
        path: make_relative(&root, &abs),
        title,
        body,
    })
}

#[tauri::command]
fn save_note(path: String, title: String, body: String) -> Result<(), String> {
    let root = notes_root()?;
    let p = Path::new(&path);
    let abs = if p.is_absolute() {
        PathBuf::from(p)
    } else {
        root.join(p)
    };
    if !abs.starts_with(&root) {
        return Err("Path is outside notes root".to_string());
    }
    let content = join_note_content(&title, &body);
    fs::create_dir_all(
        abs.parent()
            .ok_or_else(|| "Invalid note path (no parent)".to_string())?,
    )
    .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    fs::write(&abs, content).map_err(|e| format!("Failed to write {}: {}", abs.display(), e))?;
    Ok(())
}

#[tauri::command]
fn create_note() -> Result<NoteDetail, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let root = notes_root()?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let filename = format!("note-{}.md", ts);
    let abs = root.join(&filename);
    if abs.exists() {
        // Extremely unlikely; fall back to a random suffix.
        let alt = format!("note-{}-{}.md", ts, rand_suffix());
        let abs_alt = root.join(&alt);
        fs::write(&abs_alt, "").map_err(|e| format!("Failed to create note: {}", e))?;
        return Ok(NoteDetail {
            path: make_relative(&root, &abs_alt),
            title: "".to_string(),
            body: "".to_string(),
        });
    }
    fs::write(&abs, "").map_err(|e| format!("Failed to create note: {}", e))?;
    Ok(NoteDetail {
        path: make_relative(&root, &abs),
        title: "".to_string(),
        body: "".to_string(),
    })
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:x}", nanos)
}

#[tauri::command]
fn delete_note(path: String) -> Result<(), String> {
    let root = notes_root()?;
    let p = Path::new(&path);
    let abs = if p.is_absolute() {
        PathBuf::from(p)
    } else {
        root.join(p)
    };
    if !abs.starts_with(&root) {
        return Err("Path is outside notes root".to_string());
    }
    if abs.is_file() {
        fs::remove_file(&abs).map_err(|e| format!("Failed to delete {}: {}", abs.display(), e))?;
    }

    // Keep persisted semantic memory in sync with file deletes.
    if let Some(index_path) = default_index_path() {
        if let Ok(mut idx) = PersistedIndex::load_from_file(&index_path) {
            let rel = make_relative(&root, &abs);
            idx.store.remove_note(&abs);
            idx.store.remove_note(Path::new(&rel));
            idx.note_states.remove(&abs.to_string_lossy().into_owned());
            idx.note_states.remove(&rel);
            idx.updated_at_unix =
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
            let _ = idx.save_to_file(&index_path);
        }
    }

    Ok(())
}

#[tauri::command]
fn memory_overview(limit: Option<usize>) -> Result<MemoryOverview, String> {
    let root = notes_root()?;
    let notes = scan_notes(&root).map_err(|e| e.to_string())?;
    let mut overview = build_memory_overview(&notes, limit.unwrap_or(8));
    for card in &mut overview.cards {
        let p = Path::new(&card.note_path);
        card.note_path = make_relative(&root, p);
    }
    Ok(overview)
}

#[tauri::command]
async fn query(query: String, k: Option<usize>) -> Result<Vec<QueryResult>, String> {
    let index_path = default_index_path().ok_or("Could not determine index path")?;
    let idx = PersistedIndex::load_from_file(&index_path)
        .map_err(|e| format!("Failed to load index: {}. Run `noema init` first.", e))?;

    if idx.schema_version != INDEX_SCHEMA_VERSION {
        return Err(format!("Index schema mismatch. Rebuild with `noema init`."));
    }

    if idx.store.is_empty() {
        return Err("Index is empty. Run `noema init` to build it.".to_string());
    }

    let cfg = load_config();
    let url = cfg.models.embed_url.as_deref().unwrap_or(DEFAULT_BASE_URL);
    let model = cfg
        .models
        .embed_model
        .as_deref()
        .unwrap_or(DEFAULT_EMBED_MODEL);
    let k = k.or(cfg.models.default_k).unwrap_or(5);

    let client = OllamaClient::from_url(url)
        .map_err(|e| e.to_string())?
        .with_embed_model(model);

    let q_emb = client.embed(&query).await.map_err(|e| e.to_string())?;
    let raw = idx.store.search(&q_emb, k);
    let index_notes_root = Path::new(&idx.settings.notes_root);
    let current_root = notes_root().ok();
    let preferred_root = current_root.as_deref().unwrap_or(index_notes_root);

    let filtered: Vec<_> = raw
        .iter()
        .cloned()
        .filter(|(chunk, _)| {
            chunk_note_exists(&chunk.note_path, index_notes_root, current_root.as_deref())
        })
        .collect();
    let chosen = if filtered.is_empty() { raw } else { filtered };

    let results: Vec<QueryResult> = chosen
        .into_iter()
        .map(|(chunk, score)| {
            let display_path =
                resolve_existing_note_path(&chunk.note_path, index_notes_root, current_root.as_deref())
                    .map(|p| make_relative(preferred_root, &p))
                    .unwrap_or_else(|| chunk.note_path.display().to_string());
            let preview: String = chunk.text.chars().take(120).collect();
            let preview = if chunk.text.len() > 120 {
                format!("{}…", preview)
            } else {
                preview
            };
            QueryResult {
                note_path: display_path,
                score,
                preview: preview.trim().to_string(),
                text: chunk.text,
            }
        })
        .collect();

    Ok(results)
}

#[tauri::command]
async fn ask(
    question: String,
    k: Option<usize>,
    model: Option<String>,
) -> Result<AskResponse, String> {
    let index_path = default_index_path().ok_or("Could not determine index path")?;
    let idx = PersistedIndex::load_from_file(&index_path)
        .map_err(|e| format!("Failed to load index: {}. Run `noema init` first.", e))?;

    if idx.schema_version != INDEX_SCHEMA_VERSION {
        return Err("Index schema mismatch. Rebuild with `noema init`.".to_string());
    }

    if idx.store.is_empty() {
        return Err("Index is empty. Run `noema init` to build it.".to_string());
    }

    // Determine effective top-k, honoring optional config default.
    let cfg = load_config();
    let mut effective_k = k.unwrap_or(6);
    if effective_k == 6 {
        if let Some(default_k) = cfg.models.default_k {
            effective_k = default_k;
        }
    }

    // Build a minimal metadata map from current notes on disk for titles.
    use std::collections::HashMap;
    #[derive(Clone)]
    struct NoteMeta {
        title: Option<String>,
    }

    let mut note_meta: HashMap<String, NoteMeta> = HashMap::new();
    if let Ok(notes) = scan_notes(Path::new(&idx.settings.notes_root)) {
        for n in notes {
            if let Some(fm) = n.frontmatter.as_ref() {
                let abs_key = n.path.display().to_string();
                let rel_key = n
                    .path
                    .strip_prefix(Path::new(&idx.settings.notes_root))
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());
                let meta = NoteMeta {
                    title: fm.title.clone(),
                };
                note_meta.insert(abs_key, meta.clone());
                if let Some(rel) = rel_key {
                    note_meta.insert(rel, meta);
                }
            }
        }
    }

    // Use the index's embedding settings for query embedding.
    let embed_client = OllamaClient::from_url(&idx.settings.ollama_url)
        .map_err(|e| e.to_string())?
        .with_embed_model(idx.settings.embed_model.clone());

    let q_emb = embed_client
        .embed(&question)
        .await
        .map_err(|e| e.to_string())?;

    let index_notes_root = Path::new(&idx.settings.notes_root);
    let current_root = notes_root().ok();
    let preferred_root = current_root.as_deref().unwrap_or(index_notes_root);
    let raw_search = idx.store.search(&q_emb, effective_k.saturating_mul(3));
    let filtered: Vec<_> = raw_search
        .iter()
        .cloned()
        .filter(|(chunk, _)| {
            chunk_note_exists(&chunk.note_path, index_notes_root, current_root.as_deref())
        })
        .take(effective_k)
        .collect();
    let raw_results: Vec<_> = if filtered.is_empty() {
        raw_search.into_iter().take(effective_k).collect()
    } else {
        filtered
    };
    if raw_results.is_empty() {
        return Err("No results.".to_string());
    }

    // Build context from top chunks.
    let mut context = String::new();
    use std::fmt::Write as FmtWrite;
    for (i, (chunk, score)) in raw_results.iter().enumerate() {
        let resolved = resolve_existing_note_path(&chunk.note_path, index_notes_root, current_root.as_deref());
        let normalized = resolved
            .as_ref()
            .map(|p| make_relative(preferred_root, p))
            .unwrap_or_else(|| chunk.note_path.display().to_string());
        let title = note_meta
            .get(&normalized)
            .or_else(|| note_meta.get(&chunk.note_path.display().to_string()))
            .and_then(|m| m.title.as_deref())
            .unwrap_or_else(|| normalized.as_str());
        let _ = FmtWrite::write_fmt(
            &mut context,
            format_args!(
                "[{}] {} (score {:.3})\n{}\n\n",
                i + 1,
                title,
                score,
                chunk.text
            ),
        );
    }

    // Resolve chat URL and model with config overrides and optional per-call model.
    let chat_url = cfg
        .models
        .chat_url
        .as_deref()
        .unwrap_or(DEFAULT_BASE_URL)
        .to_string();
    let chat_model = match model {
        Some(m) if !m.trim().is_empty() => m,
        _ => cfg
            .models
            .chat_model
            .clone()
            .unwrap_or_else(|| DEFAULT_CHAT_MODEL.to_string()),
    };

    let chat_client = OllamaClient::from_url(&chat_url).map_err(|e| e.to_string())?;

    let prompt = format!(
        "You are Noema, a local-first knowledge assistant. Use ONLY the following note excerpts as context. If the context is insufficient, say you don't know.\n\nContext:\n{}\nQuestion:\n{}\n\nAnswer in a concise paragraph or two:\n",
        context, question
    );

    let answer = chat_client
        .generate(&chat_model, &prompt)
        .await
        .map_err(|e| e.to_string())?;

    // Prepare sources payload for the frontend (clickable references).
    let sources = raw_results
        .into_iter()
        .map(|(chunk, score)| {
            let resolved =
                resolve_existing_note_path(&chunk.note_path, index_notes_root, current_root.as_deref());
            let note_key = resolved
                .as_ref()
                .map(|p| make_relative(preferred_root, p))
                .unwrap_or_else(|| chunk.note_path.display().to_string());
            let title = note_meta
                .get(&note_key)
                .or_else(|| note_meta.get(&chunk.note_path.display().to_string()))
                .and_then(|m| m.title.clone());
            AskSource {
                note_path: note_key,
                title,
                chunk_index: chunk.index,
                score,
            }
        })
        .collect();

    Ok(AskResponse {
        question,
        answer: answer.trim().to_string(),
        sources,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_notes_root,
            status,
            rebuild_index,
            list_notes,
            read_note,
            save_note,
            create_note,
            delete_note,
            memory_overview,
            query,
            ask,
            list_chat_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
