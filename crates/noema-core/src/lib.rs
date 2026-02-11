//! All backend logic independent of how the app is run (CLI or Tauri).
//!
//! User notes live in a folder they choose. Noema stores only config and index
//! in its own app data directory (see [app_data]).

pub mod app_data;
pub mod chunks;
pub mod config;
pub mod notes;
pub mod watcher;

pub use app_data::app_data_dir;
pub use chunks::{chunk_note, chunk_notes, Chunk, DEFAULT_MAX_CHARS};
pub use config::{get_notes_root, load_config, set_notes_root, Config, ConfigError};
pub use notes::{scan_notes, Note, ScanError};
pub use watcher::{watch_notes, WatchError};

/// Returns a short status string. Used to verify the backend is wired up.
pub fn status() -> &'static str {
    "noema-core ready"
}
