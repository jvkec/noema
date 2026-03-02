//! Discovering and parsing markdown notes from a user-chosen directory.
//!
//! The notes root is chosen by the user; we only read and index it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

/// Parsed YAML frontmatter for a note. We keep a few common fields (title, date, tags, type)
/// and preserve any extra keys as a raw map for future use.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub title: Option<String>,
    pub date: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

/// A note file we found: path and parsed content.
#[derive(Debug, Clone)]
pub struct Note {
    pub path: PathBuf,
    /// Raw file content.
    pub raw: String,
    /// Parsed YAML frontmatter, if present at the top of the file.
    pub frontmatter: Option<NoteFrontmatter>,
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
            let raw = std::fs::read_to_string(path)
                .map_err(|e| ScanError::Read(path.to_path_buf(), e))?;
            let (frontmatter, body) = parse_frontmatter(&raw);
            notes.push(Note {
                path: path.to_path_buf(),
                raw,
                frontmatter,
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

/// Parse optional YAML frontmatter at the top of `content`, returning `(frontmatter, body)`.
fn parse_frontmatter(content: &str) -> (Option<NoteFrontmatter>, String) {
    let s = content.trim_start();
    if !s.starts_with("---") {
        return (None, content.to_string());
    }
    // Find the end of the first line (`---`) and look for the closing `---` on a following line.
    let after_first = match s.strip_prefix("---") {
        Some(rest) => rest,
        None => return (None, content.to_string()),
    };

    // We look for "\n---" which marks the end of the YAML block.
    if let Some(rest_idx) = after_first.find("\n---") {
        let (yaml_block, rest) = after_first.split_at(rest_idx);
        let yaml_str = yaml_block.trim_start_matches('\n').trim();
        let body = rest.trim_start_matches("\n---").trim_start().to_string();

        if yaml_str.is_empty() {
            return (None, body);
        }

        let fm = serde_yaml::from_str::<NoteFrontmatter>(yaml_str).unwrap_or_default();
        (Some(fm), body)
    } else {
        // No closing marker found; treat as no frontmatter.
        (None, content.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_frontmatter_plain() {
        let s = "Hello world.";
        let (fm, body) = parse_frontmatter(s);
        assert!(fm.is_none());
        assert_eq!(body, "Hello world.");
    }

    #[test]
    fn strip_frontmatter_with_yaml() {
        let s = "---\ntitle: Foo\ndate: 2024-01-01\n---\n\nActual content here.";
        let (fm, body) = parse_frontmatter(s);
        assert!(fm.is_some());
        assert_eq!(body, "Actual content here.");
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
