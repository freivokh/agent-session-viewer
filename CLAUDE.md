# Claude Code Instructions

## Git Workflow

- **Never amend commits** - always create new commits for fixes
- Use conventional commit messages
- Run tests before committing when applicable

## Project Structure

- `agent_session_viewer/` - Python FastAPI backend
- `tauri-app/` - Native Rust/Tauri desktop app
  - `src/` - Frontend (static HTML/JS)
  - `src-tauri/` - Rust backend

## Development

### Python version
```bash
uv sync
uv run agent-session-viewer
```

### Tauri version
```bash
cd tauri-app
npm install
npm run tauri dev
```

## Testing

```bash
uv run pytest -v
```

For Tauri Rust tests:
```bash
cd tauri-app/src-tauri
cargo test
```
