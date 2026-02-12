//! CLI entry point for the Noema backend (for dev and testing).

use std::path::PathBuf;

use clap::Parser;
use noema_core::{
    app_data_dir, chunk_notes, get_notes_root, scan_notes, set_notes_root, status, watch_notes,
    OllamaClient,
};

#[derive(Parser)]
#[command(name = "noema")]
#[command(about = "Noema: local-first knowledge assistant")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Show backend status (for dev).
    Status,
    /// Show where Noema stores its config and index (app data directory).
    DataDir,
    /// Set the notes root directory (persisted for future use).
    SetRoot {
        /// Path to your notes folder.
        #[arg(value_name = "PATH")]
        path: PathBuf,
    },
    /// Scan a directory for markdown notes. Uses configured root if PATH omitted.
    Scan {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Chunk notes for embedding. Uses configured root if PATH omitted.
    Chunks {
        /// Root directory to scan (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
        /// Max characters per chunk (default: 512).
        #[arg(long, default_value = "512")]
        max_chars: usize,
    },
    /// Watch notes directory and re-scan when files change. Ctrl+C to stop.
    Watch {
        /// Root directory to watch (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Embed text with Ollama (requires Ollama running and an embedding model).
    Embed {
        /// Text to embed.
        #[arg(value_name = "TEXT")]
        text: String,
        /// Ollama base URL (default: http://localhost:11434).
        #[arg(long, default_value = "http://localhost:11434")]
        url: String,
        /// Embedding model (default: nomic-embed-text).
        #[arg(long, default_value = "nomic-embed-text")]
        model: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Status) {
        Commands::Status => {
            println!("Noema backend");
            println!("  core: {}", status());
        }
        Commands::DataDir => {
            match app_data_dir() {
                Some(p) => println!("{}", p.display()),
                None => eprintln!("Could not determine app data directory."),
            }
        }
        Commands::SetRoot { path } => {
            match set_notes_root(&path) {
                Ok(()) => println!("Notes root set to {}", path.display()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Scan { path } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            match scan_notes(&root) {
                Ok(notes) => {
                    println!("Scanned {} note(s) under {}", notes.len(), root.display());
                    for n in notes {
                        let p = n.body.lines().next().unwrap_or("").trim();
                        let preview = if p.len() > 60 { format!("{}...", &p[..60]) } else { p.to_string() };
                        println!("  {}  {}", n.path.display(), preview);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Chunks { path, max_chars } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            match scan_notes(&root) {
                Ok(notes) => {
                    let chunks = chunk_notes(&notes, max_chars);
                    println!("Chunked {} note(s) into {} chunk(s) (max {} chars)", notes.len(), chunks.len(), max_chars);
                    for c in chunks.iter().take(10) {
                        let preview: String = c.text.chars().take(50).collect();
                        let suffix = if c.text.len() > 50 { "…" } else { "" };
                        println!("  [{}] {}  {}{}", c.index, c.note_path.display(), preview, suffix);
                    }
                    if chunks.len() > 10 {
                        println!("  ... and {} more", chunks.len() - 10);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
        Commands::Watch { path } => {
            let root = path.or_else(get_notes_root);
            let Some(root) = root else {
                eprintln!("No notes root configured. Run: noema set-root <PATH>");
                return;
            };
            println!("Watching {}. Edit notes to trigger re-scan. Ctrl+C to stop.", root.display());
            if let Ok(notes) = scan_notes(&root) {
                println!("Initial scan: {} note(s)", notes.len());
            }
            if let Err(e) = watch_notes(&root, |res| {
                match res {
                    Ok(notes) => println!("Rescanned: {} note(s)", notes.len()),
                    Err(e) => eprintln!("Scan error: {}", e),
                }
            }) {
                eprintln!("Error: {}", e);
            }
        }
        Commands::Embed { text, url, model } => {
            let client = match OllamaClient::from_url(&url) {
                Ok(c) => c.with_embed_model(&model),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return;
                }
            };
            match client.embed(&text).await {
                Ok(emb) => println!("Embedding: {} dimensions", emb.len()),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
    }
}
