//! Ollama client for embeddings and completion. Wraps ollama-rs with a simple API.

use ollama_rs::generation::embeddings::request::{EmbeddingsInput, GenerateEmbeddingsRequest};
use ollama_rs::Ollama;
use thiserror::Error;

pub const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text";
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// Thin wrapper around Ollama for embedding and (future) completion.
#[derive(Debug, Clone)]
pub struct OllamaClient {
    inner: Ollama,
    embed_model: String,
}

impl OllamaClient {
    /// Create from URL string. Default: http://localhost:11434.
    pub fn from_url(url: &str) -> Result<Self, OllamaError> {
        let inner = Ollama::try_new(url).map_err(OllamaError::ParseUrl)?;
        Ok(Self {
            inner,
            embed_model: DEFAULT_EMBED_MODEL.to_string(),
        })
    }

    /// Create with default localhost:11434.
    pub fn default() -> Self {
        Self::from_url(DEFAULT_BASE_URL).expect("default URL is valid")
    }

    /// Set the embedding model (e.g. `nomic-embed-text`, `all-minilm`).
    pub fn with_embed_model(mut self, model: impl Into<String>) -> Self {
        self.embed_model = model.into();
        self
    }

    /// Embed a single string. Returns the embedding vector.
    pub async fn embed(&self, text: &str) -> Result<Vec<f32>, OllamaError> {
        let req = GenerateEmbeddingsRequest::new(
            self.embed_model.clone(),
            EmbeddingsInput::Single(text.to_string()),
        );
        let res = self
            .inner
            .generate_embeddings(req)
            .await
            .map_err(OllamaError::Request)?;
        Ok(res.embeddings.into_iter().next().unwrap_or_default())
    }

    /// Embed multiple strings in one call. Returns one embedding per input.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, OllamaError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let req = GenerateEmbeddingsRequest::new(
            self.embed_model.clone(),
            EmbeddingsInput::Multiple(texts.to_vec()),
        );
        let res = self
            .inner
            .generate_embeddings(req)
            .await
            .map_err(OllamaError::Request)?;
        Ok(res.embeddings)
    }
}

#[derive(Debug, Error)]
pub enum OllamaError {
    #[error("invalid Ollama URL: {0}")]
    ParseUrl(#[from] url::ParseError),
    #[error("Ollama request failed: {0}")]
    Request(#[from] ollama_rs::error::OllamaError),
}
