//! Where Noema stores its own data (config, index, cache).
//!
//! User notes stay in the folder they choose. We only store app state here.

use std::path::PathBuf;

/// Returns the directory where Noema stores config, index, and other app data.
/// On macOS: `~/Library/Application Support/Noema/`.
/// Creates the directory if it doesn't exist; returns `None` if we can't determine the path.
pub fn app_data_dir() -> Option<PathBuf> {
    let dir = directories::ProjectDirs::from("app", "Noema", "Noema")?.data_local_dir().to_path_buf();
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_is_some() {
        assert!(app_data_dir().is_some());
    }
}
