//! Persisted config (notes root, etc.) in the app data directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_data;

const CONFIG_FILENAME: &str = "config.toml";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// Path to the user's notes directory (chosen by them).
    pub notes_root: Option<String>,
    /// Optional model and query defaults.
    #[serde(default)]
    pub models: ModelConfig,
}

/// Optional defaults for embed and chat models, URLs, and top-k.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ModelConfig {
    /// Default Ollama URL for embeddings (overrides compiled default if set).
    pub embed_url: Option<String>,
    /// Default embedding model name for indexing/query.
    pub embed_model: Option<String>,
    /// Default Ollama URL for chat/completion (ask).
    pub chat_url: Option<String>,
    /// Default chat/completion model name for ask.
    pub chat_model: Option<String>,
    /// Default top-k for query/ask when not overridden.
    pub default_k: Option<usize>,
}

/// Load config from the app data directory. Returns default config if missing or invalid.
pub fn load_config() -> Config {
    let Some(data_dir) = app_data::app_data_dir() else {
        return Config::default();
    };
    let path = data_dir.join(CONFIG_FILENAME);
    let Ok(s) = std::fs::read_to_string(&path) else {
        return Config::default();
    };
    toml::from_str(&s).unwrap_or_default()
}

/// Save config to the app data directory.
pub fn save_config(config: &Config) -> Result<(), ConfigError> {
    let data_dir = app_data::app_data_dir().ok_or(ConfigError::NoDataDir)?;
    let path = data_dir.join(CONFIG_FILENAME);
    let s = toml::to_string_pretty(config).map_err(ConfigError::Serialize)?;
    std::fs::write(&path, s).map_err(ConfigError::Write)
}

/// Get the configured notes root path, if any.
pub fn get_notes_root() -> Option<PathBuf> {
    load_config()
        .notes_root
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Set and persist the notes root.
pub fn set_notes_root(path: &Path) -> Result<(), ConfigError> {
    let path = path.canonicalize().map_err(ConfigError::Canonicalize)?;
    if !path.is_dir() {
        return Err(ConfigError::NotADirectory(path));
    }
    let mut config = load_config();
    config.notes_root = Some(path.to_string_lossy().into_owned());
    save_config(&config)
}

/// Set a model config key and persist. Keys: embed_url, embed_model, chat_url, chat_model, default_k.
pub fn set_model_config(key: &str, value: &str) -> Result<(), ConfigError> {
    let mut config = load_config();
    match key {
        "embed_url" => config.models.embed_url = Some(value.to_string()),
        "embed_model" => config.models.embed_model = Some(value.to_string()),
        "chat_url" => config.models.chat_url = Some(value.to_string()),
        "chat_model" => config.models.chat_model = Some(value.to_string()),
        "default_k" => {
            let k: usize = value.parse().map_err(|_| ConfigError::InvalidDefaultK)?;
            config.models.default_k = Some(k);
        }
        _ => return Err(ConfigError::UnknownConfigKey(key.to_string())),
    }
    save_config(&config)
}

/// Clear a model config key (set back to compiled default).
pub fn unset_model_config(key: &str) -> Result<(), ConfigError> {
    let mut config = load_config();
    match key {
        "embed_url" => config.models.embed_url = None,
        "embed_model" => config.models.embed_model = None,
        "chat_url" => config.models.chat_url = None,
        "chat_model" => config.models.chat_model = None,
        "default_k" => config.models.default_k = None,
        _ => return Err(ConfigError::UnknownConfigKey(key.to_string())),
    }
    save_config(&config)
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not determine app data directory")]
    NoDataDir,
    #[error("failed to serialize config: {0}")]
    Serialize(toml::ser::Error),
    #[error("failed to write config: {0}")]
    Write(std::io::Error),
    #[error("failed to resolve path: {0}")]
    Canonicalize(std::io::Error),
    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("unknown config key: {0}. Use: embed_url, embed_model, chat_url, chat_model, default_k")]
    UnknownConfigKey(String),
    #[error("invalid default_k: must be a positive integer")]
    InvalidDefaultK,
}
