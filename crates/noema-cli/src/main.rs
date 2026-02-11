//! CLI entry point for the Noema backend (for dev and testing).

use std::path::PathBuf;

use clap::Parser;
use noema_core::{app_data_dir, scan_notes, status};

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
    /// Scan a directory for markdown notes and list them.
    Scan {
        /// Root directory to scan (your notes folder).
        #[arg(value_name = "PATH")]
        path: PathBuf,
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
        Commands::Scan { path } => {
            match scan_notes(&path) {
                Ok(notes) => {
                    println!("Scanned {} note(s) under {}", notes.len(), path.display());
                    for n in notes {
                        let p = n.body.lines().next().unwrap_or("").trim();
                        let preview = if p.len() > 60 { format!("{}...", &p[..60]) } else { p.to_string() };
                        println!("  {}  {}", n.path.display(), preview);
                    }
                }
                Err(e) => eprintln!("Error: {}", e),
            }
        }
    }
}
