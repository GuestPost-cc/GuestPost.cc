# Cross-Platform Development

## Supported platforms

- **macOS** — primary development target
- **Linux** — CI and production
- **Windows** — via WSL2 (recommended) or Git Bash

## Known issues

### Line endings

`.gitattributes` enforces LF line endings for all text files. Windows
users should configure Git:

```bash
git config --global core.autocrlf false
```

### Script compatibility

All developer scripts (`scripts/*.ts`) are Node.js scripts that work
on all platforms. Avoid shell scripts for anything beyond trivial
commands.

### Docker

Docker Compose files use Linux containers. On macOS and Windows this
works transparently. On Linux, ensure Docker Engine is installed.

### Path separators

All code uses forward slashes (`/`) for paths. Node.js `path` module
handles platform-specific separators. Avoid string concatenation of
paths — use `path.join()`.
