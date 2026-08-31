# Come Gither

Sync your Obsidian vault with a GitHub repository through the GitHub API. Come Gither works on desktop and mobile, including iPad. It does not need git on your device.

## Why

Real git implementations struggle on mobile with large repositories. Come Gither talks to the GitHub API instead. It downloads and uploads only the files that changed. The cost of a sync grows with your edits, not with the size of your vault.

## Features

- **Two-way sync.** The plugin creates real commits on your repository. Other devices and plain git see normal history.
- **Placeholders for large binaries.** Text files and the config folder sync fully, up to the download limit. Binary files (PDFs, images, audio) arrive as empty placeholders. Open one, and the plugin offers to download it. A setting switches between "ask first" and "download immediately".
- **Free up space.** The command *Remove local copy (keep on GitHub)* turns a downloaded file back into a placeholder.
- **Conflict resolution.** When both sides change a text file, the plugin merges the edits when they do not overlap. When they overlap, it keeps your local file and saves the server version under `_conflicts/` for review. A "remote wins" mode takes the server version instead. The config folder always takes the server version. When an overwrite would replace your changed file with a placeholder, your local copy is saved under `_conflicts/` first.
- **Preview before you sync.** The command *Preview sync* lists incoming and outgoing changes. Each outgoing change has a Revert button.
- **Safe interruption.** A killed or backgrounded pull resumes where it stopped. An interrupted upload restarts, but nothing appears on GitHub until the final commit lands.
- **Log export.** The command *Export sync log* writes the sync log to a note, so you can share it from any device.

## Network use disclosure

This plugin sends the contents of your vault to the GitHub API (`api.github.com`) and downloads repository content from it. It talks to no other service. It collects no telemetry.

## Token storage disclosure

The plugin needs a GitHub personal access token (fine-grained, Contents read and write, scoped to one repository). The token is stored **in plain text** in the plugin's local settings file (`data.json` in the plugin's folder under your vault's config folder, usually `.obsidian/plugins/come-gither/`) on each device. The plugin never syncs its own folder, so the token never leaves your device.

## Setup

1. Create a fine-grained personal access token with Contents read and write access to your vault repository.
2. Install the plugin and open its settings.
3. Enter the repository owner, name, branch, and your token.
4. Run the command **Sync now**.

The first sync of a large vault takes a while and is safe to interrupt. Start it when the app can stay in the foreground.

## Settings

- **Conflict policy** — merge (default) or remote wins.
- **Placeholder downloads** — ask first (default) or download immediately.
- **Largest automatic download (MB)** — text files above this size, and all binary files, stay placeholders until you open them.
- **Automatic sync interval (minutes)** — 0 is off; otherwise 3 to 60.
- **Pull when Obsidian starts** — on by default. The startup pull never pushes; local edits and deletions wait for a manual or interval sync.

## Limits

- Files over 30 MB cannot be uploaded through the GitHub API. The plugin skips them with a warning; push them with desktop git.
- Git LFS is not supported.
- Syncing the config folder includes the code and settings of your other plugins. Anyone with write access to your repository can change what those plugins run. Use a repository only you control.
- A conflict whose GitHub version is larger than the download limit is logged, but no copy lands in `_conflicts/`; resolve it with desktop git.
- A new empty file is not uploaded until it has content.
- A binary embedded in a note renders as broken until you open the file directly once.
- Deletions sync both ways. Deleting a downloaded file locally deletes it on GitHub on the next sync. Deleting a placeholder does not; the placeholder returns.

## Install (before the community listing is live)

Install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat), then add `kaleho/come-gither` as a beta plugin. BRAT updates it from GitHub releases.

## License

MIT
