# Noema

Noema is a small, local-first app for your notes: search across them, or **ask** questions and get answers grounded in what you’ve actually written. Everything goes through **[Ollama](https://ollama.com)** on your computer—no API keys, no cloud unless you want one.

![Noema screenshot](noema/public/screenshot.png)

## What you need

I’ve only really run this on **macOS**, so treat everything else as “your mileage may vary.” You’ll want **[Node](https://nodejs.org/)** for the frontend, a normal **[Rust](https://www.rust-lang.org/)** setup for Tauri, and **[Ollama](https://ollama.com)** installed and left running while you use the app.

How heavy it feels depends on the models you pick: embedding models are usually cheap; the chat model is the one that eats RAM (or GPU) as it gets bigger.

## Getting Ollama ready

Noema needs **two kinds** of models: something for **embeddings** (how it indexes your notes) and something for **chat** (how it answers `?` questions). Out of the box it assumes `nomic-embed-text` and `llama3.1`, but you can point it at others in config if you prefer.

Grab them with Ollama, for example:

```bash
ollama pull nomic-embed-text   # indexes / search / “what’s similar”
ollama pull llama3.1           # or any chat model you like for answers
```

Leave the Ollama app (or daemon) running. When you add or change a lot of notes, hit **rebuild index** so everything gets re-embedded. In the bar at the bottom you can search normally, or type `**?`** and a question to use RAG—e.g. `?what did I write about …`.

The model dropdown is filled from `ollama list`; it skips names that look like embedding-only models so you don’t accidentally pick the wrong thing for chat.

## Running it

```bash
npm install
npm run tauri dev
```

To build a proper macOS app bundle:

```bash
npm run tauri build
```

## How I put it together

It’s **Tauri 2** with a plain **JavaScript** UI (Vite + Tailwind). The interesting bit lives in `**noema-core`** (Rust): walk your markdown, break it into chunks, ask Ollama for embeddings, keep the vectors in memory for similarity search. For “ask” mode, it embeds your question, pulls the closest chunks, and sends those plus your question to a chat model. Settings and where your notes live are stored locally; the UI asks Ollama which chat models you have installed.