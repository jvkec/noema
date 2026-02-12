//! Index pipeline: scan → chunk → embed → store. Builds an in-memory vector store.

use std::path::Path;

use crate::chunks::{chunk_notes, DEFAULT_MAX_CHARS};
use crate::notes::{scan_notes, ScanError};
use crate::ollama::{OllamaClient, OllamaError};
use crate::store::VectorStore;

/// Runs the full pipeline: scan notes, chunk, embed, store in memory.
/// Returns the populated vector store.
pub async fn build_index(
    root: &Path,
    client: &OllamaClient,
    max_chars: Option<usize>,
) -> Result<VectorStore, IndexError> {
    let notes = scan_notes(root)?;
    let max_chars = max_chars.unwrap_or(DEFAULT_MAX_CHARS);
    let chunks = chunk_notes(&notes, max_chars);

    if chunks.is_empty() {
        return Ok(VectorStore::new());
    }

    let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let embeddings = client.embed_batch(&texts).await?;

    let mut store = VectorStore::new();
    store.add_batch(chunks, embeddings);
    Ok(store)
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("scan error: {0}")]
    Scan(#[from] ScanError),
    #[error("embedding error: {0}")]
    Ollama(#[from] OllamaError),
}
