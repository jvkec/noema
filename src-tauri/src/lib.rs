//! Tauri app entry point. Exposes noema-core commands to the frontend.

use noema_core::{
    default_index_path, get_notes_root as core_get_notes_root, load_config, OllamaClient,
    PersistedIndex, DEFAULT_BASE_URL, DEFAULT_EMBED_MODEL, INDEX_SCHEMA_VERSION,
};
use serde::Serialize;

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
        .invoke_handler(tauri::generate_handler![get_notes_root, query, status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
