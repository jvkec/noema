# Noema

<<<<<<< HEAD
A local-first life repository visualized as a force-directed graph. Your notes become nodes, topics become clusters, and connections emerge from the shape of your thinking. Everything stays on your device.
=======
A local-first life repo for searching and chatting with your notes. **v0**.
>>>>>>> cc699c1751b5c7f90ef1a7c442e06f66219cde96

## Getting started

1. `npm install` then `npm run tauri dev`
2. Choose your notes folder when prompted
3. Click **Index** in the floating bar to build the search index
4. Create notes, explore the graph, search with `Cmd+K`, ask questions with `Cmd+J`

## The graph

- **Center node**: "My Life" — everything branches from here
- **Topic nodes**: auto-inferred clusters (Learning, Self, Work, Health, etc.)
- **Note nodes**: your individual notes, orbiting their topic
- **Related links**: green connections drawn when you open a note, revealing semantic similarity

## Shortcuts

| Action     | Shortcut |
|------------|----------|
| New note   | `Cmd+N`  |
| Search     | `Cmd+K`  |
| Chat       | `Cmd+J`  |
| Close      | `Esc`    |

## Troubleshooting

- No search results → click **Index** to rebuild
- AI errors → ensure Ollama is running (`ollama serve`)
- Wrong folder → restart and set the notes folder again
