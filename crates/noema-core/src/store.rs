//! In-memory vector store for chunk embeddings. Supports add and similarity search.
//! No persistence; store is discarded when the process exits.
//! TODO: add persistance with some vector db later. 
use crate::chunks::Chunk;

/// A chunk with its embedding, stored for similarity search.
#[derive(Debug, Clone)]
pub struct IndexedChunk {
    pub chunk: Chunk,
    /// Normalized embedding vector (unit length for cosine similarity via dot product).
    embedding: Vec<f32>,
}

/// In-memory vector store. Holds chunks and their embeddings; supports similarity search.
#[derive(Debug, Default)]
pub struct VectorStore {
    items: Vec<IndexedChunk>,
}

impl VectorStore {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
        }
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
