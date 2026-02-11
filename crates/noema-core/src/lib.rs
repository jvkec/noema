//! All backend logic independent of how the app is run (CLI or Tauri).
//!
//! User notes live in a folder they choose. Noema stores only config and index
//! in its own app data directory (see [app_data]).

pub mod app_data;
pub mod notes;

pub use app_data::app_data_dir;
pub use notes::{scan_notes, Note, ScanError};

/// Returns a short status string. Used to verify the backend is wired up.
pub fn status() -> &'static str {
    "noema-core ready"
}
