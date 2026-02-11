//! Splits note bodies into chunks for embedding and search.
//! Prefers paragraph boundaries; falls back to line breaks, then character splits.

use std::path::PathBuf;

use crate::notes::Note;

/// Default maximum characters per chunk. Keeps chunks small enough for embedding models.
pub const DEFAULT_MAX_CHARS: usize = 512;

/// A chunk of text from a note, with source reference.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub text: String,
    pub note_path: PathBuf,
    /// Index of this chunk within the note (0, 1, 2, …).
    pub index: usize,
}

/// Chunk a single note's body into smaller pieces.
pub fn chunk_note(note: &Note, max_chars: usize) -> Vec<Chunk> {
    let body = note.body.trim();
    if body.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    for (i, text) in split_into_chunks(body, max_chars).into_iter().enumerate() {
        let t = text.trim().to_string();
        if !t.is_empty() {
            chunks.push(Chunk {
                text: t,
                note_path: note.path.clone(),
                index: i,
            });
        }
    }
    chunks
}

/// Chunk all notes. Returns chunks from all notes in order.
pub fn chunk_notes(notes: &[Note], max_chars: usize) -> Vec<Chunk> {
    notes.iter().flat_map(|n| chunk_note(n, max_chars)).collect()
}

/// Splits text into chunks of at most max_chars, preferring paragraph and line boundaries.
fn split_into_chunks(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![text.to_string()];
    }
    let mut result = Vec::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if para.len() <= max_chars {
            result.push(para.to_string());
        } else {
            for line_chunk in split_long_text(para, max_chars) {
                result.push(line_chunk);
            }
        }
    }
    if result.is_empty() && !text.trim().is_empty() {
        for line_chunk in split_long_text(text.trim(), max_chars) {
            result.push(line_chunk);
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::notes::Note;

    fn note(body: &str) -> Note {
        Note {
            path: PathBuf::from("test.md"),
            raw: body.to_string(),
            body: body.to_string(),
        }
    }

    #[test]
    fn chunk_short_note() {
        let n = note("One paragraph.");
        let c = chunk_note(&n, 512);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text, "One paragraph.");
    }

    #[test]
    fn chunk_by_paragraphs() {
        let n = note("P1\n\nP2\n\nP3");
        let c = chunk_note(&n, 512);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].text, "P1");
        assert_eq!(c[1].text, "P2");
        assert_eq!(c[2].text, "P3");
    }

    #[test]
    fn chunk_long_paragraph() {
        let long = "a".repeat(600);
        let n = note(&long);
        let c = chunk_note(&n, 200);
        assert!(c.len() >= 3);
        assert!(c.iter().all(|ch| ch.text.len() <= 200));
    }
}
