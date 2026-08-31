import { GitHubError } from "./github";
import { isUtf8Text, threeWayMerge } from "./merge";
import type { Files } from "./ports";
import type { FileEntry, StateStore } from "./state";

export interface GitHubApi {
	getRef(branch: string): Promise<string>;
	getCommit(sha: string): Promise<{ treeSha: string; parents: string[] }>;
	getTree(
		sha: string,
		recursive: boolean,
	): Promise<{ entries: { path: string; mode: string; type: "blob" | "tree"; sha: string | null; size?: number }[]; truncated: boolean }>;
	getBlobRaw(sha: string): Promise<ArrayBuffer>;
	createBlob(data: ArrayBuffer): Promise<string>;
	createTree(baseTree: string, entries: { path: string; mode: string; type: "blob" | "tree"; sha: string | null }[]): Promise<string>;
	createCommit(message: string, treeSha: string, parents: string[]): Promise<string>;
	updateRef(branch: string, sha: string): Promise<void>;
}

export interface SyncConfig {
	branch: string;
	textExtensions: string[];
	maxAutoFetchBytes: number;
	maxPushBytes: number;
	conflictPolicy: "merge" | "remote-wins";
	/** The vault's config folder (usually ".obsidian"; users can override it). */
	configDir: string;
	/** Path prefixes never synced in either direction, matched case-insensitively. */
	excludedPrefixes: string[];
}

export const DEFAULT_TEXT_EXTENSIONS = [
	"md", "txt", "json", "css", "js", "html", "csv", "canvas", "svg", "sh", "yml", "yaml",
];

export interface PullSummary {
	upToDate: boolean;
	fetched: number;
	placeholders: number;
	adopted: number;
	deleted: number;
	merged: number;
	conflicts: number;
}

export interface PushSummary {
	pushed: number;
	deletedRemote: number;
	skipped: number;
	skippedPaths: string[];
	commit: string | null;
}

export type IncomingAction =
	| "fetch"
	| "placeholder"
	| "delete"
	| "both-changed"
	| "deleted-conflict"
	| "keep-local"
	| "adopt"
	| "overwrite";
export type OutgoingAction =
	| "new"
	| "modified"
	| "deleted"
	| "restore-placeholder"
	| "skip-oversize"
	| "skip-placeholder";

export interface SyncPlan {
	headMoved: boolean;
	incoming: { path: string; action: IncomingAction }[];
	outgoing: { path: string; action: OutgoingAction }[];
}

export type LogFn = (level: "info" | "warn" | "error", message: string) => void;

/** git blob sha of empty content. */
const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

interface RemoteBlob {
	sha: string;
	size: number;
	mode: string;
}

export async function gitBlobSha1(data: ArrayBuffer): Promise<string> {
	const bytes = new Uint8Array(data);
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const full = new Uint8Array(header.length + bytes.length);
	full.set(header);
	full.set(bytes, header.length);
	const digest = await crypto.subtle.digest("SHA-1", full);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
	constructor(
		private gh: GitHubApi,
		private files: Files,
		private state: StateStore,
		private log: LogFn,
		private config: SyncConfig,
	) {}

	// One operation at a time: sync, evict, revert, and lazy fetches all read and
	// write the same files and state, so concurrent entry points queue here instead
	// of interleaving (an evict racing a push once truncated a file on GitHub).
	private chain: Promise<unknown> = Promise.resolve();

	// Content sha -> uploaded blob sha, within one sync or push call. Blobs are
	// content-addressed and persist server-side, so a not-fast-forward retry
	// reuses them instead of re-uploading at one throttled request per second.
	private uploadedBlobs = new Map<string, string>();

	private locked<T>(fn: () => Promise<T>): Promise<T> {
		if (this.retired) {
			return Promise.reject(new Error("the sync engine was retired (settings changed); try again"));
		}
		const prev = this.chain;
		const run = (async () => {
			await prev.catch(() => {});
			return fn();
		})();
		this.chain = run.catch(() => {});
		return run;
	}

	/** Resolves when every operation queued so far has settled. */
	idle(): Promise<void> {
		return this.chain.then(() => undefined);
	}

	/** Refuse new operations; queued ones finish. Used when settings replace the engine. */
	retire(): void {
		this.retired = true;
	}

	private retired = false;

	fetchLazy(path: string): Promise<"fetched" | "not-lazy" | "modified"> {
		return this.locked(() => this.doFetchLazy(path));
	}

	evict(path: string): Promise<"evicted" | "not-evictable" | "modified"> {
		return this.locked(() => this.doEvict(path));
	}

	preview(): Promise<SyncPlan> {
		return this.locked(() => this.doPreview());
	}

	revert(path: string): Promise<"reverted" | "reverted-new" | "clean"> {
		return this.locked(() => this.doRevert(path));
	}

	push(): Promise<PushSummary> {
		// Cleared inside the lock: clearing at call time would wipe the cache
		// of an operation still running ahead of this one in the queue.
		return this.locked(() => {
			this.uploadedBlobs.clear();
			return this.doPush();
		});
	}

	sync(): Promise<{ pull: PullSummary; push: PushSummary }> {
		return this.locked(() => {
			this.uploadedBlobs.clear();
			return this.doSync();
		});
	}

	pull(): Promise<PullSummary> {
		return this.locked(() => this.doPull());
	}

	private async doFetchLazy(path: string): Promise<"fetched" | "not-lazy" | "modified"> {
		const entry = this.state.state.files[path];
		if (!entry?.lazy) return "not-lazy";
		if ((await this.localShaIfChanged(path, entry)) !== "clean") {
			this.log("warn", `${path} was modified locally; not overwriting it with the remote content`);
			return "modified";
		}
		const data = await this.gh.getBlobRaw(entry.baseBlobSha);
		await this.files.writeBinary(path, data);
		await this.record(path, entry.baseBlobSha, false, undefined, entry.mode);
		await this.state.flush(); // a single-entry change never reaches the cadence threshold
		this.log("info", `fetched ${path} (${data.byteLength} bytes)`);
		return "fetched";
	}

	/** Free device space: replace a clean downloaded file with a placeholder again. */
	private async doEvict(path: string): Promise<"evicted" | "not-evictable" | "modified"> {
		const entry = this.state.state.files[path];
		if (!entry || entry.lazy) return "not-evictable";
		if ((await this.localShaIfChanged(path, entry)) !== "clean") {
			this.log("warn", `${path} has local changes; push them before removing the local copy`);
			return "modified";
		}
		const remoteSize = entry.size;
		// Persist the lazy intent BEFORE truncating: a crash between the two steps
		// leaves a lazy entry (push skips those), never an empty file that a later
		// push could mistake for an edit and upload over the real remote content.
		await this.state.setFile(path, { baseBlobSha: entry.baseBlobSha, size: 0, mtime: 0, lazy: true, remoteSize, mode: entry.mode });
		await this.state.flush();
		await this.files.writeBinary(path, new ArrayBuffer(0));
		await this.record(path, entry.baseBlobSha, true, remoteSize, entry.mode);
		await this.state.flush();
		this.log("info", `evicted ${path}; the placeholder stays until you download it again`);
		return "evicted";
	}

	/** Read-only classification of what the next sync would do. Fetches no blobs, writes nothing. */
	private async doPreview(): Promise<SyncPlan> {
		const plan: SyncPlan = { headMoved: false, incoming: [], outgoing: [] };
		const agreedDeleted = new Set<string>();
		const localPaths = new Set(
			(await this.files.listRecursive("")).filter((p) => !this.excluded(p)),
		);
		const localLower = new Set([...localPaths].map((p) => p.toLowerCase()));
		const head = await this.gh.getRef(this.config.branch);
		if (head !== this.state.state.lastSyncedCommit) {
			plan.headMoved = true;
			const { treeSha } = await this.gh.getCommit(head);
			const remote = await this.listRemote(treeSha);
			for (const [path, blob] of remote) {
				if (this.excluded(path)) continue;
				const entry = this.state.state.files[path];
				if (entry && entry.baseBlobSha === blob.sha) continue;
				const { action } = await this.classifyIncoming(path, blob, entry, false);
				plan.incoming.push({ path, action });
			}
			const remoteLower = new Set([...remote.keys()].map((p) => p.toLowerCase()));
			for (const path of Object.keys(this.state.state.files)) {
				if (remote.has(path) || this.excluded(path)) continue;
				if (remoteLower.has(path.toLowerCase())) {
					const folded = [...localPaths].filter((p) => p.toLowerCase() === path.toLowerCase());
					if (folded.length <= 1) {
						// Case-only rename on one physical file: sync only drops
						// the stale entry.
						agreedDeleted.add(path);
						continue;
					}
				}
				const localSha = await this.localShaIfChanged(path, this.state.state.files[path], false);
				if (localSha === "missing") {
					// Deleted on both sides: the sync only drops the entry.
					agreedDeleted.add(path);
					continue;
				}
				plan.incoming.push({ path, action: localSha === "clean" ? "delete" : "keep-local" });
			}
		}
		for (const path of localPaths) {
			const entry = this.state.state.files[path];
			const stat = await this.files.stat(path);
			if (!stat) continue;
			if (entry && stat.mtime === entry.mtime && stat.size === entry.size) continue;
			if (stat.size > this.config.maxPushBytes) {
				if (entry && stat.size === entry.size && (await this.localShaIfChanged(path, entry, false)) === "clean") {
					continue; // only the mtime drifted; sync will heal it silently
				}
				plan.outgoing.push({ path, action: "skip-oversize" });
				continue;
			}
			const localSha = await this.localShaIfChanged(path, entry, false);
			if (localSha === "clean") continue;
			if (entry?.lazy) {
				plan.outgoing.push({ path, action: "skip-placeholder" });
				continue;
			}
			if (!entry && localSha === EMPTY_BLOB_SHA) continue; // stale stub: push leaves it for pull
			if (!entry) {
				const twinKey = this.caseTwinEntryKey(path);
				if (twinKey !== undefined && localSha === this.state.state.files[twinKey].baseBlobSha) {
					continue; // case-only rename: push keeps the GitHub casing
				}
			}
			plan.outgoing.push({ path, action: entry ? "modified" : "new" });
		}
		const uploads = new Set(
			plan.outgoing.filter((r) => r.action === "new" || r.action === "modified").map((r) => r.path.toLowerCase()),
		);
		for (const path of Object.keys(this.state.state.files)) {
			const entry = this.state.state.files[path];
			if (localPaths.has(path) || agreedDeleted.has(path) || this.excluded(path)) continue;
			if (!entry.lazy && localLower.has(path.toLowerCase()) && !uploads.has(path.toLowerCase())) {
				continue; // a case twin exists on disk and push will not delete it
			}
			plan.outgoing.push({ path, action: entry.lazy ? "restore-placeholder" : "deleted" });
		}
		return plan;
	}

	/** Discard a local change: restore the last-synced content (or stub), or delete a new file. */
	private async doRevert(path: string): Promise<"reverted" | "reverted-new" | "clean"> {
		const entry = this.state.state.files[path];
		if (!entry) {
			if ((await this.files.stat(path)) === null) return "clean";
			// The only copy of an untracked file: park it before removing. A
			// conflict-kept file shows as "New file" in the preview, and its
			// Revert button must never destroy the last copy.
			const parked = await this.park(path, await this.files.readBinary(path));
			await this.files.remove(path);
			this.log("info", `reverted ${path}: removed the new file (a copy is in ${parked})`);
			return "reverted-new";
		}
		// A lazy entry with real bytes on disk is never clean for revert: the
		// stub must come back even when a closing editor rewrote the base bytes.
		const dirtyStub = entry.lazy === true && (((await this.files.stat(path))?.size ?? 0) > 0);
		if (!dirtyStub && (await this.localShaIfChanged(path, entry, false)) === "clean") return "clean";
		if (entry.lazy) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, entry.baseBlobSha, true, entry.remoteSize, entry.mode);
		} else {
			const data = await this.gh.getBlobRaw(entry.baseBlobSha);
			await this.files.writeBinary(path, data);
			await this.record(path, entry.baseBlobSha, false, undefined, entry.mode);
		}
		await this.state.flush();
		this.log("info", `reverted ${path} to its last-synced content`);
		return "reverted";
	}

	private async doPush(): Promise<PushSummary> {
		const summary: PushSummary = { pushed: 0, deletedRemote: 0, skipped: 0, skippedPaths: [], commit: null };
		const treeEntries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
		const fingerprints = new Map<string, { mtime: number; size: number; mode?: string }>();
		const localPaths = new Set(
			(await this.files.listRecursive("")).filter((p) => !this.excluded(p)),
		);

		for (const path of localPaths) {
			const entry = this.state.state.files[path];
			const stat = await this.files.stat(path);
			if (!stat) continue; // removed while scanning
			if (entry && stat.mtime === entry.mtime && stat.size === entry.size) continue;
			if (stat.size > this.config.maxPushBytes) {
				// Checked before hashing: never read a file the API cannot accept.
				// A same-size tracked file gets one confirming hash so a bare
				// mtime drift heals instead of warning on every sync forever.
				if (entry && stat.size === entry.size && (await this.localShaIfChanged(path, entry)) === "clean") {
					continue;
				}
				summary.skipped += 1;
				summary.skippedPaths.push(path);
				this.log("warn", `${path} is ${stat.size} bytes, over the push limit; push it from desktop git`);
				continue;
			}
			const localSha = await this.localShaIfChanged(path, entry);
			if (localSha === "clean") continue;
			if (entry?.lazy) {
				summary.skipped += 1;
				summary.skippedPaths.push(path);
				this.log("warn", `${path} is an unfetched placeholder that was modified locally; not pushing it`);
				continue;
			}
			if (!entry && localSha === EMPTY_BLOB_SHA) {
				// An untracked zero-byte file carries no content: pushing it could
				// blank a real remote file whose state entry was lost. It stays
				// local until it has content (or until a pull re-tracks its path).
				this.log("info", `${path} is an untracked empty file; not pushing it until it has content`);
				continue;
			}
			if (!entry) {
				const twinKey = this.caseTwinEntryKey(path);
				if (twinKey !== undefined) {
					if (localSha === this.state.state.files[twinKey].baseBlobSha) {
						// A case-only rename: the twin entry already tracks this
						// content, and pushing it as a new path would commit a
						// case collision into the repository.
						continue;
					}
					this.log("warn", `${path} differs from tracked ${twinKey} only by case; pushing it can create a case collision in the repository`);
				}
			}
			// One read serves both the cache key and the upload, so the cache can
			// never map one file's content sha to another file's uploaded bytes.
			const data = await this.files.readBinary(path);
			const contentSha = await gitBlobSha1(data);
			let sha = this.uploadedBlobs.get(contentSha);
			if (sha === undefined) {
				sha = await this.gh.createBlob(data);
				this.uploadedBlobs.set(contentSha, sha);
			}
			treeEntries.push({ path, mode: entry?.mode ?? "100644", type: "blob", sha });
			// The fingerprint from before the read: an edit made during the slow
			// push window then surfaces as a change on the next sync instead of
			// being stamped as already pushed.
			fingerprints.set(path, { mtime: stat.mtime, size: stat.size, mode: entry?.mode });
			summary.pushed += 1;
		}

		const droppedPaths: string[] = [];
		let restoredPlaceholders = 0;
		const localLower = new Set([...localPaths].map((p) => p.toLowerCase()));
		for (const path of Object.keys(this.state.state.files)) {
			if (localPaths.has(path)) continue;
			if (this.excluded(path)) {
				// A path excluded after it was tracked (an upgrade widened the
				// list) is not a local deletion; drop the entry, never the
				// remote file.
				await this.state.removeFile(path);
				continue;
			}
			const entry = this.state.state.files[path];
			if (entry.lazy) {
				// A deleted placeholder must never delete the real remote file;
				// its content was never on this device to judge. Restore the stub.
				await this.files.writeBinary(path, new ArrayBuffer(0));
				await this.record(path, entry.baseBlobSha, true, entry.remoteSize, entry.mode);
				restoredPlaceholders += 1;
				this.log("info", `restored the placeholder for ${path}`);
				continue;
			}
			if (localLower.has(path.toLowerCase())) {
				// A case twin of this entry exists on disk. Emit the delete only
				// when the twin's content actually landed in this commit; a
				// skipped upload plus a delete would remove the file from GitHub.
				const uploaded = treeEntries.some(
					(e) => e.sha !== null && e.path.toLowerCase() === path.toLowerCase(),
				);
				if (!uploaded) continue;
			}
			treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
			droppedPaths.push(path);
			summary.deletedRemote += 1;
		}

		if (treeEntries.length === 0) {
			if (restoredPlaceholders > 0) await this.state.flush();
			return summary;
		}

		const base = this.state.state.lastSyncedCommit as string;
		const { treeSha: baseTree } = await this.gh.getCommit(base);
		const newTree = await this.gh.createTree(baseTree, treeEntries);
		const commit = await this.gh.createCommit(
			`come-gither: sync (${summary.pushed} changed, ${summary.deletedRemote} deleted)`,
			newTree,
			[base],
		);
		await this.gh.updateRef(this.config.branch, commit);

		for (const e of treeEntries) {
			if (e.sha === null) continue;
			const fp = fingerprints.get(e.path) as { mtime: number; size: number; mode?: string };
			const newEntry: FileEntry = { baseBlobSha: e.sha, size: fp.size, mtime: fp.mtime };
			if (fp.mode !== undefined && fp.mode !== "100644") newEntry.mode = fp.mode;
			await this.state.setFile(e.path, newEntry);
		}
		for (const path of droppedPaths) await this.state.removeFile(path);
		await this.state.setCommit(commit);
		summary.commit = commit;
		this.log("info", `push done: ${summary.pushed} pushed, ${summary.deletedRemote} deleted, ${summary.skipped} skipped`);
		return summary;
	}

	private async doSync(attempt = 1): Promise<{ pull: PullSummary; push: PushSummary }> {
		const pull = await this.doPull();
		try {
			return { pull, push: await this.doPush() };
		} catch (e) {
			if (e instanceof GitHubError && e.kind === "not-fast-forward" && attempt < 3) {
				this.log("warn", "the branch moved during the push; pulling again and retrying");
				return this.doSync(attempt + 1);
			}
			throw e;
		}
	}

	private async doPull(): Promise<PullSummary> {
		const summary: PullSummary = {
			upToDate: false,
			fetched: 0,
			placeholders: 0,
			adopted: 0,
			deleted: 0,
			merged: 0,
			conflicts: 0,
		};
		const head = await this.gh.getRef(this.config.branch);
		if (head === this.state.state.lastSyncedCommit) {
			summary.upToDate = true;
			return summary;
		}
		const { treeSha } = await this.gh.getCommit(head);
		const remote = await this.listRemote(treeSha);

		for (const [path, blob] of remote) {
			if (this.excluded(path)) continue;
			const entry = this.state.state.files[path];
			if (entry && entry.baseBlobSha === blob.sha) continue;
			await this.applyRemoteChange(path, blob, entry, summary);
		}

		const remoteLower = new Set([...remote.keys()].map((p) => p.toLowerCase()));
		let localList: string[] | null = null;
		for (const path of Object.keys(this.state.state.files)) {
			if (remote.has(path) || this.excluded(path)) continue;
			if (remoteLower.has(path.toLowerCase())) {
				// A case-only rename on GitHub. On a case-insensitive filesystem
				// the differently-cased twin owns the same physical file, and
				// removing this path would destroy it; on a case-sensitive one
				// both casings are distinct files and the delete is real.
				localList ??= await this.files.listRecursive("");
				const folded = localList.filter((p) => p.toLowerCase() === path.toLowerCase());
				if (folded.length <= 1) {
					await this.state.removeFile(path);
					continue;
				}
			}
			await this.applyRemoteDelete(path, summary);
		}

		await this.state.setCommit(head);
		this.log(
			"info",
			`pull done: ${summary.fetched} fetched, ${summary.placeholders} placeholders, ${summary.adopted} adopted, ${summary.deleted} deleted, ${summary.conflicts} conflicts`,
		);
		return summary;
	}

	/**
	 * The one classification of an incoming remote change, shared by pull and
	 * preview so the panel can never disagree with what sync then does.
	 */
	private async classifyIncoming(
		path: string,
		blob: RemoteBlob,
		entry: FileEntry | undefined,
		refresh: boolean,
	): Promise<{ action: IncomingAction; localSha: string }> {
		const localSha = await this.localShaIfChanged(path, entry, refresh, blob.size);
		if (localSha !== "clean") {
			// Local content already equals the remote blob: adopt it.
			if (localSha === blob.sha) return { action: "adopt", localSha };
			// A stale zero-byte stub with no tracking has no user data to protect.
			const staleStub = !entry && localSha === EMPTY_BLOB_SHA;
			if (!staleStub) {
				if (!this.inConfigDir(path) && this.config.conflictPolicy === "merge") {
					return { action: localSha === "missing" ? "deleted-conflict" : "both-changed", localSha };
				}
				// remote-wins policy, and the config folder always: overwrite.
				return { action: "overwrite", localSha };
			}
		}
		return { action: this.isLazyTarget(path, blob.size) ? "placeholder" : "fetch", localSha };
	}

	private async applyRemoteChange(
		path: string,
		blob: RemoteBlob,
		entry: FileEntry | undefined,
		summary: PullSummary,
	): Promise<void> {
		const { action, localSha } = await this.classifyIncoming(path, blob, entry, true);
		if (action === "adopt") {
			await this.record(path, blob.sha, false, undefined, blob.mode);
			summary.adopted += 1;
			return;
		}
		if (action === "both-changed" || action === "deleted-conflict") {
			await this.resolveConflict(path, blob, entry, localSha, summary);
			return;
		}
		if (action === "overwrite" && localSha === "size-differs") {
			// The local file is too large to buffer for a _conflicts park: keep
			// it untouched rather than destroy bytes we cannot copy.
			summary.conflicts += 1;
			this.log("warn", `conflict on ${path}: the local file is too large to save to _conflicts/; kept it; resolve from desktop git`);
			return;
		}
		if (action === "overwrite" && localSha !== "missing") {
			const why = this.inConfigDir(path) ? "the config folder always takes the GitHub version" : "policy: remote wins";
			this.log("warn", `overwriting local changes to ${path} (${why})`);
			if (this.isLazyTarget(path, blob.size)) {
				// The new state is a stub, so the changed local bytes would
				// otherwise exist nowhere: keep a copy first.
				const parked = await this.park(path, await this.files.readBinary(path));
				this.log("warn", `saved the local version of ${path} to ${parked}`);
			}
		}
		if (this.isLazyTarget(path, blob.size)) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, blob.sha, true, blob.size, blob.mode);
			summary.placeholders += 1;
			return;
		}
		const data = await this.gh.getBlobRaw(blob.sha);
		await this.files.writeBinary(path, data);
		await this.record(path, blob.sha, false, undefined, blob.mode);
		summary.fetched += 1;
	}

	/** Both sides changed under the merge policy: try diff3, else save the remote copy. */
	private async resolveConflict(
		path: string,
		blob: RemoteBlob,
		entry: FileEntry | undefined,
		localSha: string,
		summary: PullSummary,
	): Promise<void> {
		if (blob.size > this.config.maxAutoFetchBytes) {
			// Never buffer an oversize blob just to record a conflict.
			summary.conflicts += 1;
			this.log("warn", `conflict on ${path}: the GitHub version is too large to save locally; resolve it from desktop git`);
			return;
		}
		const remoteData = await this.gh.getBlobRaw(blob.sha);
		if (entry && localSha !== "missing") {
			const baseData = await this.gh.getBlobRaw(entry.baseBlobSha);
			const localData = await this.files.readBinary(path);
			if (isUtf8Text(baseData) && isUtf8Text(localData) && isUtf8Text(remoteData)) {
				const decode = (d: ArrayBuffer) => new TextDecoder().decode(d);
				const merged = threeWayMerge(decode(localData), decode(baseData), decode(remoteData));
				if (merged !== null) {
					// The merged text stays a local change; the next push commits it.
					await this.files.writeBinary(path, new TextEncoder().encode(merged).buffer as ArrayBuffer);
					summary.merged += 1;
					this.log("info", `auto-merged ${path}`);
					return;
				}
			}
		}
		const parked = await this.park(path, remoteData);
		summary.conflicts += 1;
		this.log("warn", `conflict on ${path}: kept the local version, saved the remote one to ${parked}`);
	}

	private async applyRemoteDelete(path: string, summary: PullSummary): Promise<void> {
		const entry = this.state.state.files[path];
		const localSha = await this.localShaIfChanged(path, entry);
		if (localSha === "missing") {
			// Deleted on both sides: agreement, not a conflict. Dropping the
			// entry also keeps push from deleting a path GitHub no longer has.
			await this.state.removeFile(path);
			summary.deleted += 1;
			return;
		}
		if (localSha !== "clean") {
			summary.conflicts += 1;
			if (entry.lazy === true) {
				// The real content was never downloaded; the local bytes are stub
				// scribbles that must never become the file's uploaded content.
				const parked = await this.park(path, await this.files.readBinary(path));
				await this.files.remove(path);
				await this.state.removeFile(path);
				this.log("warn", `conflict on ${path}: deleted on GitHub before its content was downloaded; your local notes moved to ${parked}`);
				return;
			}
			// Keep the file, drop the entry: the path no longer exists on GitHub,
			// so a tracked entry could only make a later push emit a delete for a
			// path absent from the base tree (GitHub rejects that with a 422).
			// The kept file, now untracked, uploads as a new file on push.
			await this.state.removeFile(path);
			this.log("warn", `conflict on ${path}: deleted on GitHub but changed locally; keeping it (it uploads as a new file on the next push)`);
			return;
		}
		await this.files.remove(path);
		await this.state.removeFile(path);
		summary.deleted += 1;
	}

	/**
	 * "clean" when the local file matches its last-synced state entry.
	 * Otherwise the local git blob sha ("missing" when the file does not exist).
	 */
	private async localShaIfChanged(
		path: string,
		entry: FileEntry | undefined,
		refresh = true,
		expectedSize?: number,
	): Promise<string> {
		const stat = await this.files.stat(path);
		if (!entry) {
			if (!stat) return "clean"; // nothing local, nothing tracked
			if (expectedSize !== undefined && stat.size !== expectedSize && stat.size > this.config.maxPushBytes) {
				// The sizes differ, so the contents cannot match: never buffer a
				// huge untracked file just to prove it (iPad memory).
				return "size-differs";
			}
			return gitBlobSha1(await this.files.readBinary(path));
		}
		if (!stat) return "missing";
		if (stat.mtime === entry.mtime && stat.size === entry.size) return "clean";
		const sha = await gitBlobSha1(await this.files.readBinary(path));
		if (sha === entry.baseBlobSha) {
			// The full content is present. Recording lazy=false also heals a
			// stale lazy flag left by an interrupted evict or download, which
			// would otherwise strand every later edit as a "modified placeholder".
			if (refresh) await this.record(path, entry.baseBlobSha, false, undefined, entry.mode);
			return "clean";
		}
		// A lazy entry whose content is still empty is an untouched stub whose
		// mtime drifted (backup restore, file-provider touch): clean, re-stamp.
		if (entry.lazy === true && sha === EMPTY_BLOB_SHA) {
			if (refresh) await this.record(path, entry.baseBlobSha, true, entry.remoteSize, entry.mode);
			return "clean";
		}
		return sha;
	}

	private async record(path: string, sha: string, lazy: boolean, remoteSize?: number, mode?: string): Promise<void> {
		// Only ever called right after a write or on an existing file.
		const stat = (await this.files.stat(path)) as { mtime: number; size: number };
		const entry: FileEntry = {
			baseBlobSha: sha,
			size: stat.size,
			mtime: stat.mtime,
		};
		if (lazy) {
			entry.lazy = true;
			entry.remoteSize = remoteSize;
		}
		if (mode !== undefined && mode !== "100644") entry.mode = mode;
		await this.state.setFile(path, entry);
	}

	private async listRemote(treeSha: string): Promise<Map<string, RemoteBlob>> {
		const out = new Map<string, RemoteBlob>();
		const top = await this.gh.getTree(treeSha, true);
		if (!top.truncated) {
			for (const e of top.entries) {
				if (e.type === "blob") out.set(e.path, { sha: e.sha as string, size: e.size as number, mode: e.mode });
			}
			return out;
		}
		this.log("warn", "recursive tree listing truncated; walking subtrees");
		await this.walk(treeSha, "", out);
		return out;
	}

	private async walk(sha: string, prefix: string, out: Map<string, RemoteBlob>): Promise<void> {
		const level = await this.gh.getTree(sha, false);
		for (const e of level.entries) {
			if (e.type === "blob") out.set(`${prefix}${e.path}`, { sha: e.sha as string, size: e.size as number, mode: e.mode });
			else await this.walk(e.sha as string, `${prefix}${e.path}/`, out);
		}
	}

	private isLazyTarget(path: string, size: number): boolean {
		return size > this.config.maxAutoFetchBytes || (!this.isText(path) && !this.inConfigDir(path));
	}

	/** The key of a tracked entry that differs from this path only by case. */
	private caseTwinEntryKey(path: string): string | undefined {
		const lower = path.toLowerCase();
		for (const key of Object.keys(this.state.state.files)) {
			if (key !== path && key.toLowerCase() === lower) return key;
		}
		return undefined;
	}

	/**
	 * Save a copy under _conflicts/ without ever clobbering an earlier parked
	 * copy (which can be the only copy of some content). Returns the name used.
	 */
	private async park(path: string, data: ArrayBuffer): Promise<string> {
		let target = `_conflicts/${path}`;
		for (let n = 1; (await this.files.stat(target)) !== null; n++) {
			target = `_conflicts/${path}.${n}`;
		}
		await this.files.writeBinary(target, data);
		return target;
	}

	private inConfigDir(path: string): boolean {
		// Case-folded like excluded(): on case-insensitive filesystems a
		// differently-cased remote path writes into the same local folder.
		return path.toLowerCase().startsWith(`${this.config.configDir.toLowerCase()}/`);
	}

	private excluded(path: string): boolean {
		// Case-insensitive: on the case-insensitive filesystems Obsidian runs on,
		// a differently-cased remote path resolves to the same local file.
		const lower = path.toLowerCase();
		return this.config.excludedPrefixes.some((p) => lower.startsWith(p.toLowerCase()));
	}

	private isText(path: string): boolean {
		const dot = path.lastIndexOf(".");
		if (dot === -1) return false;
		return this.config.textExtensions.includes(path.slice(dot + 1).toLowerCase());
	}
}
