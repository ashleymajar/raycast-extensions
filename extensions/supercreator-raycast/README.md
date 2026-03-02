# Supercreator Admin

A Raycast extension for quickly searching and managing Supercreator workspaces and creators.

## Features

- **Quick Search**: Search workspaces and creators by ID, name, email, or workspace UID
- **Impersonation**: Generate support auth links to impersonate accounts directly
- **Account Comments**: Add aliases and notes to accounts for easier searching
- **Clipboard Actions**: Copy workspace UID, account UID, and email with keyboard shortcuts
- **Recent Access**: View and access recently used accounts
- **Local Caching**: Fast search with 60-second cache refresh

## Installation

This extension is published privately for the Supercreator team.

1. Open Raycast
2. Search for "Supercreator Admin"
3. Install and configure database URLs in preferences

## Configuration

The extension requires PlanetScale database connection URLs:

- **Read Database URL**: Connection string for read operations
- **Write Database URL**: Connection string for write operations (used for comments and impersonation)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Impersonate account |
| `Cmd+E` | Edit comments |
| `Cmd+C` | Copy workspace UID |
| `Cmd+Shift+C` | Copy account UID |
