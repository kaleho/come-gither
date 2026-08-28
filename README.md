# Come Gither

Sync your Obsidian vault with a GitHub repository through the GitHub API. Come Gither works on desktop and mobile, including iPad. It does not need git on your device.

## Why

Real git implementations crash on mobile with large repositories. Come Gither talks to the GitHub API instead. It downloads and uploads only the files that changed. The cost of a sync grows with your edits, not with the size of your vault.

## Features

- Two-way sync with a GitHub repository. The plugin creates real commits.
- Selective content: text files sync fully. Large binary files (PDFs, audio) become small placeholders. Open one, and the plugin fetches it — immediately, or after a prompt. You choose.
- Conflict resolution: automatic three-way merge for text files. When a merge fails, the plugin keeps your local file and saves the remote version under `_conflicts/` for review. An optional "remote wins" mode takes the server version instead.
- Sync triggers: a manual command, a pull when the app starts, and an optional timer (3–60 minutes).
- Log export: one command writes the sync log to a note, so you can share it from any device.

## Network use disclosure

This plugin sends the contents of your vault to the GitHub API (`api.github.com`) and downloads repository content from it. It talks to no other service. It collects no telemetry.

## Token storage disclosure

The plugin needs a GitHub personal access token (fine-grained, Contents read/write, scoped to one repository). The token is stored **in plain text** in the plugin's local settings file (`.obsidian/plugins/come-gither/data.json`) on each device. The plugin never syncs its own settings folder, so the token never leaves your device.

## Setup

1. Create a fine-grained personal access token with Contents read and write access to your vault repository.
2. Install the plugin and open its settings.
3. Enter the repository owner, name, branch, and your token.
4. Run the command **Come Gither: Sync now**.

## License

MIT
