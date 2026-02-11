//! Discovering and parsing markdown notes from a user-chosen directory.
//!
//! The notes root is chosen by the user; we only read and index it.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// A note file we found: path and parsed content (body with optional frontmatter stripped).
#[derive(Debug, Clone)]
pub struct Note {
    pub path: PathBuf,
    /// Raw file content.
    pub raw: String,
    /// Content without YAML frontmatter (the main markdown body).
    pub body: String,
}

/// Scans `root` for all `.md` files and returns their path and content.
/// Does not follow symlinks into directories (walkdir default).
pub fn scan_notes(root: &Path) -> Result<Vec<Note>, ScanError> {
    if !root.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }
    let mut notes = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
    {
        let entry = entry.map_err(|e| ScanError::Walk(e.to_string()))?;
        let path = entry.path();
        if path.extension().map_or(false, |e| e == "md") && path.is_file() {
            let raw = std::fs::read_to_string(path).map_err(|e| ScanError::Read(path.to_path_buf(), e))?;
            let body = strip_frontmatter(&raw);
            notes.push(Note {
                path: path.to_path_buf(),
                raw,
                body,
            });
        }
    }
    Ok(notes)
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

/// Removes optional YAML frontmatter (lines between first --- and second ---).
fn strip_frontmatter(content: &str) -> String {
    let s = content.trim_start();
    if !s.starts_with("---") {
        return content.to_string();
    }
    let after_first = s.strip_prefix("---").unwrap_or(s).trim_start();
    if let Some(rest) = after_first.find("\n---") {
        after_first[rest + 4..].trim_start().to_string()
    } else {
        content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_frontmatter_plain() {
        let s = "Hello world.";
        assert_eq!(strip_frontmatter(s), "Hello world.");
    }

    #[test]
    fn strip_frontmatter_with_yaml() {
        let s = "---\ntitle: Foo\ndate: 2024-01-01\n---\n\nActual content here.";
        assert_eq!(strip_frontmatter(s), "Actual content here.");
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("walk error: {0}")]
    Walk(String),
    #[error("read error for {0}: {1}")]
    Read(PathBuf, std::io::Error),
}
