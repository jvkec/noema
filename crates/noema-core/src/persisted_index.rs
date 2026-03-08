//! Persisted on-disk index format (metadata + vector store).
//!
//! This is the format written to `index.json` in the app data directory. Keeping this in
//! `noema-core` ensures the desktop app uses a stable, versioned representation.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::app_data::app_data_dir;
use crate::chunks::chunk_note;
use crate::notes::{Note, ScanError};
use crate::ollama::{OllamaClient, OllamaError};
use crate::store::VectorStore;

/// Bump this when the persisted on-disk schema changes incompatibly.
pub const INDEX_SCHEMA_VERSION: u32 = 2;

/// Settings used to build an index. Used to warn when querying with mismatched settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexSettings {
    pub notes_root: String,
    pub max_chars: usize,
    pub ollama_url: String,
    pub embed_model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteState {
    /// Unix time milliseconds from filesystem metadata.
    pub modified_unix_ms: i64,
    pub size_bytes: u64,
}

/// A persisted index file: settings + store.
#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedIndex {
    pub schema_version: u32,
    /// Unix time seconds (creation time of this index file).
    pub created_at_unix: i64,
    /// Unix time seconds (last update time).
    pub updated_at_unix: i64,
    pub settings: IndexSettings,
    pub store: VectorStore,
    /// Note file states tracked for incremental updates.
    pub note_states: BTreeMap<String, NoteState>,
}

impl PersistedIndex {
    /// Save to a JSON file.
    pub fn save_to_file<P: AsRef<Path>>(&self, path: P) -> Result<(), PersistedIndexError> {
        let file = File::create(path)?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, self).map_err(PersistedIndexError::Serialize)
    }

    /// Load from a JSON file.
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, PersistedIndexError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let idx = serde_json::from_reader(reader).map_err(PersistedIndexError::Deserialize)?;
        Ok(idx)
    }
}

/// Default on-disk index path: `<app_data_dir>/index.json`.
pub fn default_index_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("index.json"))
}

pub async fn build_persisted_index(
    notes: Vec<Note>,
    client: &OllamaClient,
    settings: IndexSettings,
) -> Result<PersistedIndex, BuildPersistedIndexError> {
    let now = unix_now_secs();
    let mut store = VectorStore::new();
    let mut note_states: BTreeMap<String, NoteState> = BTreeMap::new();

    if notes.is_empty() {
        return Ok(PersistedIndex {
            schema_version: INDEX_SCHEMA_VERSION,
            created_at_unix: now,
            updated_at_unix: now,
            settings,
            store,
            note_states,
        });
    }

    // Chunk and embed all notes in one batch.
    let mut chunks = Vec::new();
    for n in &notes {
        chunks.extend(chunk_note(n, settings.max_chars));
        if let Some(st) = note_state(&n.path) {
            note_states.insert(n.path.to_string_lossy().into_owned(), st);
        }
    }

    if chunks.is_empty() {
        return Ok(PersistedIndex {
            schema_version: INDEX_SCHEMA_VERSION,
            created_at_unix: now,
            updated_at_unix: now,
            settings,
            store,
            note_states,
        });
    }

    let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let embeddings = client
        .embed_batch(&texts)
        .await
        .map_err(BuildPersistedIndexError::from)?;
    store.add_batch(chunks, embeddings);

    Ok(PersistedIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        created_at_unix: now,
        updated_at_unix: now,
        settings,
        store,
        note_states,
    })
}

/// Apply an incremental update: remove deleted notes, and re-embed notes whose metadata changed.
pub async fn update_persisted_index(
    index: &mut PersistedIndex,
    notes: Vec<Note>,
    client: &OllamaClient,
) -> Result<UpdatePersistedIndexStats, UpdatePersistedIndexError> {
    let mut current_paths: BTreeSet<String> = BTreeSet::new();
    let mut changed_notes: Vec<Note> = Vec::new();

    for n in notes {
        let key = n.path.to_string_lossy().into_owned();
        current_paths.insert(key.clone());
        let st = note_state(&n.path);
        let was = index.note_states.get(&key).cloned();
        if st.is_none() || was.is_none() || st.as_ref() != was.as_ref() {
            changed_notes.push(n);
        }
    }

    // Deleted notes.
    let mut deleted = 0usize;
    let old_paths: Vec<String> = index.note_states.keys().cloned().collect();
    for old in old_paths {
        if !current_paths.contains(&old) {
            deleted += 1;
            index.note_states.remove(&old);
            index.store.remove_note(Path::new(&old));
        }
    }

    // Changed notes: remove old chunks and add new ones.
    let mut changed = 0usize;
    let mut added_chunks = 0usize;
    let mut removed_chunks = 0usize;

    if !changed_notes.is_empty() {
        // Remove existing chunks first.
        for n in &changed_notes {
            changed += 1;
            removed_chunks += index.store.remove_note(&n.path);
        }

        let mut chunks = Vec::new();
        for n in &changed_notes {
            chunks.extend(chunk_note(n, index.settings.max_chars));
            if let Some(st) = note_state(&n.path) {
                index
                    .note_states
                    .insert(n.path.to_string_lossy().into_owned(), st);
            }
        }

        if !chunks.is_empty() {
            let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
            let embeddings = client
                .embed_batch(&texts)
                .await
                .map_err(UpdatePersistedIndexError::from)?;
            added_chunks = chunks.len();
            index.store.add_batch(chunks, embeddings);
        }
    }

    index.updated_at_unix = unix_now_secs();

    Ok(UpdatePersistedIndexStats {
        changed_notes: changed,
        deleted_notes: deleted,
        added_chunks,
        removed_chunks,
        total_chunks: index.store.len(),
    })
}

#[derive(Debug, Clone)]
pub struct UpdatePersistedIndexStats {
    pub changed_notes: usize,
    pub deleted_notes: usize,
    pub added_chunks: usize,
    pub removed_chunks: usize,
    pub total_chunks: usize,
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn note_state(path: &Path) -> Option<NoteState> {
    let md = std::fs::metadata(path).ok()?;
    let modified = md.modified().ok()?;
    let modified_unix_ms = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Some(NoteState {
        modified_unix_ms,
        size_bytes: md.len(),
    })
}

#[derive(Debug, Error)]
pub enum PersistedIndexError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to serialize index: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to deserialize index: {0}")]
    Deserialize(serde_json::Error),
}

#[derive(Debug, Error)]
pub enum BuildPersistedIndexError {
    #[error("scan error: {0}")]
    Scan(#[from] ScanError),
    #[error("embedding error: {0}")]
    Ollama(#[from] OllamaError),
}

#[derive(Debug, Error)]
pub enum UpdatePersistedIndexError {
    #[error("embedding error: {0}")]
    Ollama(#[from] OllamaError),
}
