//! CLI entry point for the Noema backend (for dev and testing).

use std::path::PathBuf;

use clap::Parser;
use noema_core::{app_data_dir, get_notes_root, scan_notes, set_notes_root, status, watch_notes};

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
    /// Watch notes directory and re-scan when files change. Ctrl+C to stop.
    Watch {
        /// Root directory to watch (optional; uses configured root if omitted).
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
}

fn main() {
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
    }
}
