//! All backend logic for the Noema desktop app.
//!
//! User notes live in a folder they choose. Noema stores only config and index
//! in its own app data directory (see [app_data]).

pub mod app_data;
pub mod chunks;
pub mod config;
pub mod index;
pub mod memory;
pub mod notes;
pub mod ollama;
pub mod persisted_index;
pub mod store;
pub mod watcher;

pub use app_data::app_data_dir;
pub use chunks::{chunk_note, chunk_notes, Chunk, ChunkKind, DEFAULT_MAX_CHARS};
pub use config::{
    get_notes_root, load_config, set_model_config, set_notes_root, unset_model_config, Config,
    ConfigError, ModelConfig,
};
pub use index::{build_index, IndexError};
pub use memory::{
    build_memory_overview, extract_note_signals, LifeArea, MemoryCard, MemoryOverview,
    MemoryWeights, NoteMemorySignals,
};
pub use notes::{scan_notes, Note, ScanError};
pub use ollama::{
    OllamaClient, OllamaError, DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL,
};
pub use persisted_index::{
    build_persisted_index, default_index_path, update_persisted_index, BuildPersistedIndexError,
    IndexSettings, NoteState, PersistedIndex, PersistedIndexError, UpdatePersistedIndexError,
    UpdatePersistedIndexStats, INDEX_SCHEMA_VERSION,
};
pub use store::{IndexedChunk, StoreError, VectorStore};
pub use watcher::{watch_notes, WatchError};

/// Returns a short status string. Used to verify the backend is wired up.
pub fn status() -> &'static str {
    "noema-core ready"
}
