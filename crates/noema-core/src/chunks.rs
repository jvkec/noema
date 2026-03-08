//! Splits note bodies into chunks for embedding and search.
//! Prefers paragraph boundaries; falls back to line breaks, then character splits.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::notes::Note;

/// Default maximum characters per chunk. Keeps chunks small enough for embedding models.
pub const DEFAULT_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChunkKind {
    Title,
    Body,
}

impl Default for ChunkKind {
    fn default() -> Self {
        Self::Body
    }
}

/// A chunk of text from a note, with source reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub text: String,
    #[serde(default)]
    pub kind: ChunkKind,
    pub note_path: PathBuf,
    /// Index of this chunk within the note (0, 1, 2, …).
    pub index: usize,
}

/// Chunk a single note's body into smaller pieces.
pub fn chunk_note(note: &Note, max_chars: usize) -> Vec<Chunk> {
    let (title, body) = split_title_and_body(note);
    if title.is_none() && body.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut next_index = 0usize;

    if let Some(title_text) = title {
        let t = title_text.trim().to_string();
        if !t.is_empty() {
            chunks.push(Chunk {
                text: t,
                kind: ChunkKind::Title,
                note_path: note.path.clone(),
                index: next_index,
            });
            next_index += 1;
        }
    }

    if body.is_empty() {
        return chunks;
    }

    let raw_chunks = split_into_chunks(&body, max_chars);
    let overlapped = apply_overlap(raw_chunks, max_chars);
    for (i, text) in overlapped.into_iter().enumerate() {
        let t = text.trim().to_string();
        if !t.is_empty() {
            chunks.push(Chunk {
                text: t,
                kind: ChunkKind::Body,
                note_path: note.path.clone(),
                index: next_index + i,
            });
        }
    }
    chunks
}

/// Chunk all notes. Returns chunks from all notes in order.
pub fn chunk_notes(notes: &[Note], max_chars: usize) -> Vec<Chunk> {
    notes
        .iter()
        .flat_map(|n| chunk_note(n, max_chars))
        .collect()
}

/// Splits text into chunks of at most max_chars, preferring markdown-aware section,
/// paragraph, and line boundaries.
fn split_into_chunks(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![text.to_string()];
    }
    let mut result = Vec::new();

    // First, break into markdown-style sections based on headings and fenced code blocks.
    let mut sections: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_code_block = false;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            current.push_str(line);
            current.push('\n');
            continue;
        }

        // Start a new section at headings when not inside a code block.
        if !in_code_block && trimmed.starts_with('#') {
            if !current.trim().is_empty() {
                sections.push(current.trim().to_string());
                current.clear();
            }
            current.push_str(line);
            current.push('\n');
        } else {
            current.push_str(line);
            current.push('\n');
        }
    }

    if !current.trim().is_empty() {
        sections.push(current.trim().to_string());
    }

    if sections.is_empty() && !text.trim().is_empty() {
        sections.push(text.trim().to_string());
    }

    for section in sections {
        if section.len() <= max_chars {
            result.push(section);
        } else {
            for line_chunk in split_long_text(&section, max_chars) {
                result.push(line_chunk);
            }
        }
    }

    result
}

fn split_long_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_chars {
            result.push(remaining.trim().to_string());
            break;
        }
        let (chunk, rest) = try_split_at_boundary(remaining, max_chars);
        result.push(chunk);
        remaining = rest;
    }
    result
}

fn split_title_and_body(note: &Note) -> (Option<String>, String) {
    if let Some(fm) = note.frontmatter.as_ref() {
        if let Some(title) = fm.title.as_ref() {
            let t = title.trim();
            if !t.is_empty() {
                return (Some(t.to_string()), note.body.trim().to_string());
            }
        }
    }

    let body = note.body.trim();
    if body.is_empty() {
        return (None, String::new());
    }

    let lines: Vec<&str> = note.body.lines().collect();
    let Some(first_idx) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return (None, String::new());
    };

    let first_line = lines[first_idx].trim();
    let heading_title = first_line
        .strip_prefix('#')
        .map(|rest| rest.trim_start_matches('#').trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(title) = heading_title {
        let rest = if first_idx + 1 < lines.len() {
            lines[first_idx + 1..].join("\n").trim().to_string()
        } else {
            String::new()
        };
        return (Some(title), rest);
    }

    // Editor-authored note format is "title + blank line + body".
    let mut idx = first_idx + 1;
    let mut saw_blank = false;
    while idx < lines.len() && lines[idx].trim().is_empty() {
        saw_blank = true;
        idx += 1;
    }
    if saw_blank {
        let rest = if idx < lines.len() {
            lines[idx..].join("\n").trim().to_string()
        } else {
            String::new()
        };
        return (Some(first_line.to_string()), rest);
    }

    (None, body.to_string())
}

/// Prefer split at \n; else at last space before max_chars; else hard cut.
fn try_split_at_boundary(text: &str, max_chars: usize) -> (String, &str) {
    let segment = &text[..text.len().min(max_chars + 1)];
    if let Some(pos) = segment.rfind('\n') {
        return (text[..pos].trim().to_string(), text[pos + 1..].trim_start());
    }
    if let Some(pos) = segment.rfind(' ') {
        return (text[..pos].to_string(), text[pos + 1..].trim_start());
    }
    (
        text[..max_chars].to_string(),
        text[max_chars..].trim_start(),
    )
}

/// Adds a small overlap window between adjacent chunks so that context at boundaries
/// is less likely to be lost. Overlap is purely textual; the total length is still
/// capped at max_chars.
fn apply_overlap(chunks: Vec<String>, max_chars: usize) -> Vec<String> {
    if chunks.len() <= 1 || max_chars == 0 {
        return chunks;
    }
    // Use up to 1/4 of the budget for overlap, but at least 32 chars when possible.
    let mut result = Vec::with_capacity(chunks.len());
    let overlap_target = (max_chars / 4).max(32);

    let mut prev: Option<String> = None;
    for chunk in chunks {
        if let Some(ref prev_text) = prev {
            let mut prefix_len = overlap_target.min(prev_text.len());
            // Ensure we never exceed max_chars.
            if prefix_len + chunk.len() > max_chars {
                let overflow = prefix_len + chunk.len() - max_chars;
                if overflow < prefix_len {
                    prefix_len -= overflow;
                } else {
                    prefix_len = 0;
                }
            }
            let mut combined = String::new();
            if prefix_len > 0 {
                let start = prev_text.len() - prefix_len;
                combined.push_str(&prev_text[start..]);
            }
            combined.push_str(&chunk);
            result.push(combined);
        } else {
            result.push(chunk.clone());
        }
        prev = result.last().cloned();
    }
    result
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::notes::Note;

    fn note(body: &str) -> Note {
        Note {
            path: PathBuf::from("test.md"),
            raw: body.to_string(),
            frontmatter: None,
            body: body.to_string(),
        }
    }

    #[test]
    fn chunk_short_note() {
        let n = note("One paragraph.");
        let c = chunk_note(&n, 512);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text, "One paragraph.");
        assert_eq!(c[0].kind, ChunkKind::Body);
    }

    #[test]
    fn chunk_by_paragraphs() {
        let n = note("P1\n\nP2\n\nP3");
        let c = chunk_note(&n, 2); // force splitting into small chunks
        assert!(!c.is_empty());
    }

    #[test]
    fn chunk_long_paragraph() {
        let long = "a".repeat(600);
        let n = note(&long);
        let c = chunk_note(&n, 200);
        assert!(c.len() >= 3);
        assert!(c.iter().all(|ch| ch.text.len() <= 200));
    }

    #[test]
    fn chunk_editor_title_as_separate_chunk() {
        let n = note("My Title\n\nBody line one.\nBody line two.");
        let c = chunk_note(&n, 512);
        assert!(c.len() >= 2);
        assert_eq!(c[0].text, "My Title");
        assert_eq!(c[0].kind, ChunkKind::Title);
        assert_eq!(c[1].kind, ChunkKind::Body);
    }

    #[test]
    fn chunk_markdown_heading_as_title_chunk() {
        let n = note("# Heading One\nBody.");
        let c = chunk_note(&n, 512);
        assert!(c.len() >= 2);
        assert_eq!(c[0].text, "Heading One");
        assert_eq!(c[0].kind, ChunkKind::Title);
    }
}
