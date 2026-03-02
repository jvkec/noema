//! Tauri app entry point. Exposes noema-core commands to the frontend.

use std::fs;
use std::path::{Path, PathBuf};

use noema_core::{
    default_index_path, get_notes_root as core_get_notes_root, load_config, scan_notes, OllamaClient,
    PersistedIndex, DEFAULT_BASE_URL, DEFAULT_EMBED_MODEL, INDEX_SCHEMA_VERSION,
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

#[tauri::command]
fn get_notes_root() -> Option<String> {
    core_get_notes_root().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn status() -> String {
    noema_core::status().to_string()
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
    let raw = fs::read_to_string(&abs)
        .map_err(|e| format!("Failed to read {}: {}", abs.display(), e))?;
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
    fs::write(&abs, content)
        .map_err(|e| format!("Failed to write {}: {}", abs.display(), e))?;
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
        fs::remove_file(&abs)
            .map_err(|e| format!("Failed to delete {}: {}", abs.display(), e))?;
    }
    Ok(())
}

#[tauri::command]
async fn query(query: String, k: Option<usize>) -> Result<Vec<QueryResult>, String> {
    let index_path = default_index_path().ok_or("Could not determine index path")?;
    let idx = PersistedIndex::load_from_file(&index_path)
        .map_err(|e| format!("Failed to load index: {}. Run `noema init` first.", e))?;

    if idx.schema_version != INDEX_SCHEMA_VERSION {
        return Err(format!(
            "Index schema mismatch. Rebuild with `noema init`."
        ));
    }

    if idx.store.is_empty() {
        return Err("Index is empty. Run `noema init` to build it.".to_string());
    }

    let cfg = load_config();
    let url = cfg
        .models
        .embed_url
        .as_deref()
        .unwrap_or(DEFAULT_BASE_URL);
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

    let results: Vec<QueryResult> = raw
        .into_iter()
        .map(|(chunk, score)| {
            let preview: String = chunk.text.chars().take(120).collect();
            let preview = if chunk.text.len() > 120 {
                format!("{}…", preview)
            } else {
                preview
            };
            QueryResult {
                note_path: chunk.note_path.display().to_string(),
                score,
                preview: preview.trim().to_string(),
                text: chunk.text,
            }
        })
        .collect();

    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_notes_root,
            status,
            list_notes,
            read_note,
            save_note,
            create_note,
            delete_note,
            query
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
