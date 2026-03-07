//! In-memory vector store for chunk embeddings. Supports add and similarity search.
//! Can be serialized to disk for persistence.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;

use crate::chunks::Chunk;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A chunk with its embedding, stored for similarity search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedChunk {
    pub chunk: Chunk,
    /// Normalized embedding vector (unit length for cosine similarity via dot product).
    embedding: Vec<f32>,
}

/// In-memory vector store. Holds chunks and their embeddings; supports similarity search.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct VectorStore {
    items: Vec<IndexedChunk>,
}

impl VectorStore {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    /// Create a store from pre-existing indexed chunks.
    pub fn from_items(items: Vec<IndexedChunk>) -> Self {
        Self { items }
    }

    /// Add a chunk with its embedding. Embedding is normalized before storage.
    pub fn add(&mut self, chunk: Chunk, embedding: Vec<f32>) {
        let norm = normalize(&embedding);
        self.items.push(IndexedChunk {
            chunk,
            embedding: norm,
        });
    }

    /// Add multiple chunks with embeddings in one batch.
    pub fn add_batch(&mut self, chunks: Vec<Chunk>, embeddings: Vec<Vec<f32>>) {
        assert_eq!(chunks.len(), embeddings.len());
        for (chunk, embedding) in chunks.into_iter().zip(embeddings) {
            self.add(chunk, embedding);
        }
    }

    /// Persist the vector store to a file path as JSON.
    pub fn save_to_file<P: AsRef<Path>>(&self, path: P) -> Result<(), StoreError> {
        let file = File::create(path)?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, self).map_err(StoreError::Serialize)
    }

    /// Load a vector store from a JSON file.
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let store = serde_json::from_reader(reader).map_err(StoreError::Deserialize)?;
        Ok(store)
    }

    /// Search for chunks most similar to the query embedding. Returns up to k results
    /// with similarity scores (cosine similarity, 0–1).
    pub fn search(&self, query_embedding: &[f32], k: usize) -> Vec<(Chunk, f32)> {
        if self.items.is_empty() || query_embedding.is_empty() {
            return Vec::new();
        }
        let q_norm = normalize(query_embedding);
        let mut scored: Vec<(Chunk, f32)> = self
            .items
            .iter()
            .map(|ic| {
                let sim = dot(&q_norm, &ic.embedding);
                (ic.chunk.clone(), sim)
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(k).collect()
    }

    /// Number of indexed chunks.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Remove all chunks belonging to a note path. Returns number removed.
    pub fn remove_note(&mut self, note_path: &Path) -> usize {
        let before = self.items.len();
        self.items.retain(|ic| ic.chunk.note_path != note_path);
        before - self.items.len()
    }
}

fn normalize(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= 0.0 {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    (0..n).map(|i| a[i] * b[i]).sum()
}

/// Errors when persisting or loading a vector store.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to serialize store: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to deserialize store: {0}")]
    Deserialize(serde_json::Error),
}
