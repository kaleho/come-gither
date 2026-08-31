import type { Files } from "./ports";

export interface FileEntry {
	baseBlobSha: string;
	size: number; // local fingerprint (a placeholder's is 0)
	mtime: number;
	lazy?: true;
	remoteSize?: number; // set on lazy entries: the real file's size on GitHub
	mode?: string; // git mode when not the default "100644" (e.g. "100755")
}

export interface SyncState {
	version: 1;
	lastSyncedCommit: string | null;
	files: Record<string, FileEntry>;
	/** "owner/repo#branch" the entries describe; absent only in pre-0.4 files. */
	remote?: string;
}

const FLUSH_EVERY = 20;
const FLUSH_MS = 10_000;

function empty(): SyncState {
	return { version: 1, lastSyncedCommit: null, files: {} };
}

export class StateStore {
	state: SyncState = empty();
	/** True when the last load discarded an unusable or re-pointed state file. */
	rebaselined = false;
	private dirty = 0;
	private lastFlushAt = 0;

	constructor(
		private files: Files,
		private path: string,
		private now: () => number = () => Date.now(),
	) {}

	async load(expectedRemote?: string): Promise<void> {
		this.lastFlushAt = this.now();
		this.rebaselined = false;
		const exists = (await this.files.stat(this.path)) !== null;
		try {
			const raw = new TextDecoder().decode(await this.files.readBinary(this.path));
			const parsed = JSON.parse(raw);
			// Corrupt, future-versioned, or misshapen state is never trusted:
			// fall back to a re-baseline (slow, never destructive).
			const usable = parsed !== null && parsed.version === 1 && typeof parsed.files === "object" && parsed.files !== null;
			this.state = usable ? parsed : empty();
			this.rebaselined = !usable;
		} catch {
			this.state = empty();
			this.rebaselined = exists; // a fresh vault has no file and is not a re-baseline
		}
		if (expectedRemote !== undefined) {
			// Entries tracked against another repo or branch — or with no stamp
			// at all, which may be either — must never be trusted: every path
			// absent from the new remote would read as a clean remote deletion
			// and be removed from the vault.
			if (exists && this.state.remote !== expectedRemote) {
				this.state = empty();
				this.rebaselined = true;
			}
			this.state.remote = expectedRemote;
		}
	}

	async setFile(path: string, entry: FileEntry): Promise<void> {
		this.state.files[path] = entry;
		await this.bump();
	}

	async removeFile(path: string): Promise<void> {
		delete this.state.files[path];
		await this.bump();
	}

	async setCommit(sha: string | null): Promise<void> {
		this.state.lastSyncedCommit = sha;
		await this.flush();
	}

	async flush(): Promise<void> {
		const raw = new TextEncoder().encode(JSON.stringify(this.state));
		await this.files.writeBinary(this.path, raw.buffer as ArrayBuffer);
		this.dirty = 0;
		this.lastFlushAt = this.now();
	}

	private async bump(): Promise<void> {
		this.dirty += 1;
		if (this.dirty >= FLUSH_EVERY || this.now() - this.lastFlushAt >= FLUSH_MS) {
			await this.flush();
		}
	}
}
