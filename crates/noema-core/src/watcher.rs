//! File watcher for the notes directory. Re-scans when files change.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use notify_debouncer_mini::notify;

use crate::notes::{scan_notes, Note};

/// Watches `root` and calls `on_change` whenever files change (debounced).
/// Blocks until the watcher is stopped (e.g. Ctrl+C). Returns Ok when stopped, Err on setup failure.
pub fn watch_notes(
    root: &Path,
    on_change: impl Fn(Result<Vec<Note>, crate::notes::ScanError>) + Send + 'static,
) -> Result<(), WatchError> {
    if !root.is_dir() {
        return Err(WatchError::NotADirectory(root.to_path_buf()));
    }
    let root = root.canonicalize().map_err(WatchError::Canonicalize)?;
    let root_for_callback = root.clone();

    let debounce = Duration::from_millis(400);
    let mut debouncer = new_debouncer(debounce, move |res: DebounceEventResult| {
        match res {
            Ok(_) => {
                let notes = scan_notes(&root_for_callback);
                on_change(notes);
            }
            Err(e) => eprintln!("Watcher error: {}", e),
        }
    })
    .map_err(|e| WatchError::Notify(e.to_string()))?;

    debouncer
        .watcher()
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| WatchError::Watch(e.to_string()))?;

    let (_tx, rx) = mpsc::channel::<()>();
    rx.recv().ok();
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("not a directory: {0}")]
    NotADirectory(std::path::PathBuf),
    #[error("failed to resolve path: {0}")]
    Canonicalize(std::io::Error),
    #[error("watcher init: {0}")]
    Notify(String),
    #[error("watch failed: {0}")]
    Watch(String),
}
