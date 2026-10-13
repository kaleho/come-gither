import { GitHubError } from "./github";
import { gitattributesLine, lfsPointer, parseLfsPointer, sha256Hex } from "./lfs";
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
	/** One operation deleting more than this many files needs confirmation (Infinity = off). */
	maxDeletions: number;
	/** Asked before an over-threshold deletion. Absent = always defer. */
	confirmDeletions?: (direction: "local" | "remote", paths: string[]) => Promise<DeletionDecision>;
	/** Git LFS transfers (beta). Absent = LFS off: behavior is unchanged. */
	lfs?: LfsOps;
	/** New files over this go through LFS (default 100 MiB). */
	lfsThresholdBytes?: number;
	/** Files over this are never uploaded through LFS (default 2 GiB). */
	maxLfsBytes?: number;
}

export interface LfsOps {
	/**
	 * Stores the object on GitHub; throws on failure. `info` is for progress UI:
	 * index is 1-based; total counts this push's LFS candidates (see
	 * lfsCandidates), so it can exceed the uploads actually attempted.
	 */
	upload(data: ArrayBuffer, oid: string, info: { path: string; index: number; total: number }): Promise<void>;
	/** The object's verified content; throws on failure. onProgress gets (bytes done, size). */
	download(oid: string, size: number, onProgress?: (done: number, total: number) => void): Promise<ArrayBuffer>;
}

export type DeletionDecision = "delete" | "keep" | "defer";

/**
 * Thrown when the deletion guard defers: the guarded pull or push changed no
 * file (a pull may already have dropped stale keep marks), and a later manual
 * sync asks again. In a sync, a pull that ran before a deferred push stays
 * applied, and its summary rides along in `pull`.
 */
export class DeletionsDeferred extends Error {
	pull?: PullSummary;
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
	kept: number; // guarded files the user kept; the push adds them back
}

export interface PushSummary {
	pushed: number;
	deletedRemote: number;
	skipped: number;
	skippedPaths: string[];
	commit: string | null;
	readded: number; // kept files added back to GitHub by blob
	restored: number; // guarded files a push-side Keep brought back here
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
	| "skip-placeholder"
	| "restore-remote";

export interface SyncPlan {
	headMoved: boolean;
	incoming: { path: string; action: IncomingAction }[];
	outgoing: { path: string; action: OutgoingAction; size?: number }[];
}

export type LogFn = (level: "info" | "warn" | "error", message: string) => void;

/** git blob sha of empty content. */
const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const GITATTRIBUTES = ".gitattributes";
/** LFS pointers are under 1024 bytes (spec v1). */
const POINTER_MAX_BYTES = 1024;

interface RemoteBlob {
	sha: string;
	size: number;
	mode: string;
	lfs?: { oid: string; size: number }; // the blob is an LFS pointer (detected with LFS on, or over an LFS entry)
}

/** A log-sized list: the first five paths, then an ellipsis. */
function firstFive(paths: string[]): string {
	return paths.slice(0, 5).join(", ") + (paths.length > 5 ? ", …" : "");
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

	/** onProgress reports an LFS download only; a plain git blob arrives in one request. */
	fetchLazy(path: string, onProgress?: (done: number, total: number) => void): Promise<"fetched" | "not-lazy" | "modified"> {
		return this.locked(() => this.doFetchLazy(path, onProgress));
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

	private async doFetchLazy(path: string, onProgress?: (done: number, total: number) => void): Promise<"fetched" | "not-lazy" | "modified"> {
		const entry = this.state.state.files[path];
		if (!entry?.lazy) return "not-lazy";
		if ((await this.localShaIfChanged(path, entry)) !== "clean") {
			this.log("warn", `${path} was modified locally; not overwriting it with the remote content`);
			return "modified";
		}
		const { data, lfs } = await this.fetchContent(entry, onProgress);
		await this.files.writeBinary(path, data);
		await this.record(path, entry.baseBlobSha, false, undefined, entry.mode, lfs);
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
		await this.state.setFile(path, { baseBlobSha: entry.baseBlobSha, size: 0, mtime: 0, lazy: true, remoteSize, mode: entry.mode, keep: entry.keep, lfs: entry.lfs });
		await this.state.flush();
		await this.files.writeBinary(path, new ArrayBuffer(0));
		await this.record(path, entry.baseBlobSha, true, remoteSize, entry.mode);
		await this.state.flush();
		this.log("info", `evicted ${path}; the placeholder stays until you download it again`);
		return "evicted";
	}

	/** Read-only classification of what the next sync would do. Writes nothing; fetches only tiny blobs to spot LFS pointers (LFS on). */
	private async doPreview(): Promise<SyncPlan> {
		const plan: SyncPlan = { headMoved: false, incoming: [], outgoing: [] };
		const agreedDeleted = new Set<string>();
		const localPaths = new Set(
			(await this.files.listRecursive("")).filter((p) => !this.excluded(p)),
		);
		const head = await this.gh.getRef(this.config.branch);
		if (head !== this.state.state.lastSyncedCommit) {
			plan.headMoved = true;
			const { treeSha } = await this.gh.getCommit(head);
			const remote = await this.listRemote(treeSha);
			for (const [path, blob] of remote) {
				if (this.excluded(path)) continue;
				const entry = this.state.state.files[path];
				if (entry && entry.baseBlobSha === blob.sha) continue;
				const { action } = await this.classifyIncoming(path, (await this.detectLfs(blob, entry)).blob, entry, false);
				plan.incoming.push({ path, action });
			}
			const remoteLower = new Set([...remote.keys()].map((p) => p.toLowerCase()));
			for (const [path, entry] of Object.entries(this.state.state.files)) {
				if (remote.has(path) || this.excluded(path) || entry.keep) continue;
				if (remoteLower.has(path.toLowerCase()) && (await this.isOneFileCaseRename(path, remote, [...localPaths]))) {
					// Case-only rename on one physical file: sync only drops
					// the stale entry.
					agreedDeleted.add(path);
					continue;
				}
				const localSha = await this.localShaIfChanged(path, entry, false);
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
			if (stat.size > this.pushCap()) {
				if (entry && stat.size === entry.size && (await this.localShaIfChanged(path, entry, false)) === "clean") {
					continue; // only the mtime drifted; sync will heal it silently
				}
				plan.outgoing.push({ path, action: "skip-oversize", size: stat.size });
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
			if (localPaths.has(path) || agreedDeleted.has(path) || this.excluded(path) || entry.keep) continue;
			if (!entry.lazy && !uploads.has(path.toLowerCase())) {
				const twinOnDisk = [...localPaths].find((p) => p.toLowerCase() === path.toLowerCase());
				// An untracked twin is a case rename of this very file; a twin
				// with its own entry is a distinct file and the delete is real.
				if (twinOnDisk !== undefined && this.state.state.files[twinOnDisk] === undefined) continue;
			}
			plan.outgoing.push({ path, action: entry.lazy ? "restore-placeholder" : "deleted" });
		}
		for (const [path, entry] of Object.entries(this.state.state.files)) {
			if (!entry.keep || uploads.has(path.toLowerCase()) || this.excluded(path)) continue;
			// A kept file deleted again before the push just drops out.
			if (localPaths.has(path) || entry.lazy) plan.outgoing.push({ path, action: "restore-remote" });
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
			const { data, lfs } = await this.fetchContent(entry);
			await this.files.writeBinary(path, data);
			await this.record(path, entry.baseBlobSha, false, undefined, entry.mode, lfs);
		}
		await this.state.flush();
		this.log("info", `reverted ${path} to its last-synced content`);
		return "reverted";
	}

	private async doPush(): Promise<PushSummary> {
		const summary: PushSummary = { pushed: 0, deletedRemote: 0, skipped: 0, skippedPaths: [], commit: null, readded: 0, restored: 0 };
		const treeEntries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
		const fingerprints = new Map<string, { mtime: number; size: number; mode?: string; lfs?: FileEntry["lfs"] }>();
		const listLocal = async () => (await this.files.listRecursive("")).filter((p) => !this.excluded(p));
		let listed = await listLocal();
		// Decided before any upload. Placeholders are restored below, kept
		// files go back to GitHub, and an UNTRACKED twin on disk is a case
		// rename of this file (the drop loop below applies the same rule).
		const listedSet = new Set(listed);
		const listedByLower = new Map(listed.map((p) => [p.toLowerCase(), p]));
		const guarded = Object.keys(this.state.state.files).filter((p) => {
			const entry = this.state.state.files[p];
			if (listedSet.has(p) || this.excluded(p) || entry.lazy || entry.keep) return false;
			const twin = listedByLower.get(p.toLowerCase());
			return twin === undefined || this.state.state.files[twin] !== undefined;
		});
		if ((await this.guardDeletions("remote", guarded)) === "keep") {
			// Placeholders first, in one write: a kill mid-restore leaves lazy
			// entries, which a push restores and never deletes.
			const marked: Record<string, FileEntry> = {};
			for (const p of guarded) {
				const e = this.state.state.files[p];
				marked[p] = { baseBlobSha: e.baseBlobSha, size: 0, mtime: 0, lazy: true, remoteSize: e.size, mode: e.mode, lfs: e.lfs };
			}
			await this.state.setFiles(marked);
			let placeholders = 0;
			for (const path of guarded) if (await this.restoreLocal(path)) placeholders += 1;
			await this.state.flush();
			summary.restored = guarded.length;
			this.log("info", `restored ${guarded.length} files here (${placeholders} as placeholders)`);
			listed = await listLocal();
		}
		const lfsCandidates = this.config.lfs ? await this.lfsCandidates(listed) : [];
		if (await this.appendGitattributes(lfsCandidates)) listed = await listLocal();
		const localPaths = new Set(listed);
		let lfsIndex = 0;

		for (const path of localPaths) {
			const entry = this.state.state.files[path];
			const stat = await this.files.stat(path);
			if (!stat) continue; // removed while scanning
			if (entry && stat.mtime === entry.mtime && stat.size === entry.size) continue;
			if (stat.size > this.pushCap()) {
				// Checked before hashing: never read a file the API cannot accept.
				// A same-size tracked file gets one confirming hash so a bare
				// mtime drift heals instead of warning on every sync forever.
				if (entry && stat.size === entry.size && (await this.localShaIfChanged(path, entry)) === "clean") {
					continue;
				}
				summary.skipped += 1;
				summary.skippedPaths.push(path);
				this.log(
					"warn",
					this.config.lfs && stat.size > this.maxLfsBytes()
						? `${path} is ${stat.size} bytes, over the 2 GB Git LFS limit; not pushing it`
						: `${path} is ${stat.size} bytes, over the push limit; push it from desktop git`,
				);
				continue;
			}
			const { sha: localSha, data: localData, oid } = await this.localState(path, entry);
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
			// One read serves the change check, the cache key and the upload,
			// so the cache can never map one file's content sha to another
			// file's uploaded bytes, and a push holds one buffer per file.
			const data = localData as ArrayBuffer;
			if (oid !== undefined) {
				// An LFS file: the pointer is committed only after its object is stored.
				if (!this.config.lfs) {
					summary.skipped += 1;
					summary.skippedPaths.push(path);
					this.log("warn", `${path} is a Git LFS file; turn on beta features to push it`);
					continue;
				}
				try {
					lfsIndex += 1;
					// max: a file edited between the candidate scan and here can add an upload.
					await this.config.lfs.upload(data, oid, { path, index: lfsIndex, total: Math.max(lfsCandidates.length, lfsIndex) });
				} catch (e) {
					summary.skipped += 1;
					summary.skippedPaths.push(path);
					this.log("warn", `${path}: LFS upload failed (${String(e)}); not pushing it this sync`);
					continue;
				}
				const lfs = { oid, size: data.byteLength };
				const pointerSha = await this.gh.createBlob(new TextEncoder().encode(lfsPointer(oid, lfs.size)).buffer as ArrayBuffer);
				treeEntries.push({ path, mode: entry?.mode ?? "100644", type: "blob", sha: pointerSha });
				fingerprints.set(path, { mtime: stat.mtime, size: stat.size, mode: entry?.mode, lfs });
				summary.pushed += 1;
				continue;
			}
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
			if (entry.keep && !entry.lazy) {
				// Kept, then deleted again here: GitHub already lacks it, so the
				// entry just drops (a delete would 422 against the base tree).
				await this.state.removeFile(path);
				continue;
			}
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
				const twinOnDisk = [...localPaths].find((p) => p.toLowerCase() === path.toLowerCase());
				const twinTracked = twinOnDisk !== undefined && this.state.state.files[twinOnDisk] !== undefined;
				// An UNTRACKED twin on disk is a case rename of this very file:
				// emit the delete only when the twin's content actually landed in
				// this commit; a skipped upload plus a delete would remove the
				// file from GitHub. A tracked twin is a distinct file, and the
				// delete of this entry is genuine.
				if (!twinTracked) {
					const uploaded = treeEntries.some(
						(e) => e.sha !== null && e.path.toLowerCase() === path.toLowerCase(),
					);
					if (!uploaded) continue;
				}
			}
			treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
			droppedPaths.push(path);
			summary.deletedRemote += 1;
		}

		// Kept files go back by their existing blob: no download, no upload.
		// ponytail: assumes GitHub still holds the blob (true unless history was purged and gc'd).
		const readded: string[] = [];
		for (const [path, entry] of Object.entries(this.state.state.files)) {
			if (!entry.keep || treeEntries.some((e) => e.path === path)) continue;
			treeEntries.push({ path, mode: entry.mode ?? "100644", type: "blob", sha: entry.baseBlobSha });
			readded.push(path);
		}
		summary.readded = readded.length;

		if (treeEntries.length === 0) {
			if (restoredPlaceholders > 0) await this.state.flush();
			return summary;
		}

		const base = this.state.state.lastSyncedCommit as string;
		const { treeSha: baseTree } = await this.gh.getCommit(base);
		const newTree = await this.gh.createTree(baseTree, treeEntries);
		const commit = await this.gh.createCommit(
			`come-gither: sync (${summary.pushed} changed, ${summary.deletedRemote} deleted, ${summary.readded} kept)`,
			newTree,
			[base],
		);
		await this.gh.updateRef(this.config.branch, commit);

		if (readded.length > 0) {
			await this.state.setFiles(
				Object.fromEntries(readded.map((p) => [p, (({ keep: _, ...rest }) => rest)(this.state.state.files[p])])),
			);
			this.log("info", `re-added ${readded.length} kept files to GitHub by blob: ${firstFive(readded)}`);
		}
		for (const e of treeEntries) {
			if (e.sha === null || readded.includes(e.path)) continue;
			const fp = fingerprints.get(e.path) as { mtime: number; size: number; mode?: string; lfs?: FileEntry["lfs"] };
			const newEntry: FileEntry = { baseBlobSha: e.sha, size: fp.size, mtime: fp.mtime };
			if (fp.mode !== undefined && fp.mode !== "100644") newEntry.mode = fp.mode;
			if (fp.lfs) newEntry.lfs = fp.lfs;
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
			if (e instanceof DeletionsDeferred) e.pull = pull;
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
			kept: 0,
		};
		const head = await this.gh.getRef(this.config.branch);
		if (head === this.state.state.lastSyncedCommit) {
			summary.upToDate = true;
			return summary;
		}
		const { treeSha } = await this.gh.getCommit(head);
		const remote = await this.listRemote(treeSha);
		const remoteByLower = new Map([...remote.keys()].map((p) => [p.toLowerCase(), p]));

		// `keep` means "absent on GitHub": a path GitHub has again drops the
		// mark, or a later push would re-add the old blob over the new one.
		// A case twin counts: re-adding next to it would commit a collision.
		const back = Object.entries(this.state.state.files).filter(([p, e]) => e.keep && remoteByLower.has(p.toLowerCase()));
		if (back.length > 0) {
			await this.state.setFiles(Object.fromEntries(back.map(([p, { keep: _, ...rest }]) => [p, rest])));
			this.log("info", `${back.length} kept files are on GitHub again; no longer marked kept`);
		}

		// Decided before any write, so a deferred pull leaves the vault as it
		// was. Only clean files vanish (dirty ones are kept or parked, missing
		// ones are agreement). A GitHub twin this device does not track is the
		// new name of a case-only rename, not a deletion (push applies the
		// same rule to an untracked twin on disk).
		const guarded: string[] = [];
		for (const [path, entry] of Object.entries(this.state.state.files)) {
			if (remote.has(path) || this.excluded(path) || entry.keep) continue;
			const twin = remoteByLower.get(path.toLowerCase());
			if (twin !== undefined && this.state.state.files[twin] === undefined) continue;
			if ((await this.localShaIfChanged(path, entry, false)) === "clean") guarded.push(path);
		}
		if ((await this.guardDeletions("local", guarded)) === "keep") {
			// One write: a kill mid-way must never persist part of the decision.
			await this.state.setFiles(
				Object.fromEntries(guarded.map((p) => [p, { ...this.state.state.files[p], keep: true as const }])),
			);
			summary.kept = guarded.length;
		}

		for (const [path, blob] of remote) {
			if (this.excluded(path)) continue;
			const entry = this.state.state.files[path];
			if (entry && entry.baseBlobSha === blob.sha) continue;
			await this.applyRemoteChange(path, blob, entry, summary);
		}

		let localList: string[] | null = null;
		for (const [path, entry] of Object.entries(this.state.state.files)) {
			if (remote.has(path) || this.excluded(path) || entry.keep) continue;
			if (remoteByLower.has(path.toLowerCase())) {
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
		const localSha = await this.localShaIfChanged(path, entry, refresh, blob.lfs?.size ?? blob.size, blob.lfs !== undefined);
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
		return { action: this.lazyBlob(path, blob) ? "placeholder" : "fetch", localSha };
	}

	private async applyRemoteChange(
		path: string,
		listed: RemoteBlob,
		entry: FileEntry | undefined,
		summary: PullSummary,
	): Promise<void> {
		const { blob, data: prefetched } = await this.detectLfs(listed, entry);
		const { action, localSha } = await this.classifyIncoming(path, blob, entry, true);
		if (action === "adopt") {
			await this.record(path, blob.sha, false, undefined, blob.mode, blob.lfs);
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
			if (this.lazyBlob(path, blob)) {
				// The new state is a stub, so the changed local bytes would
				// otherwise exist nowhere: keep a copy first.
				const parked = await this.park(path, await this.files.readBinary(path));
				this.log("warn", `saved the local version of ${path} to ${parked}`);
			}
		}
		if (this.lazyBlob(path, blob)) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, blob.sha, true, blob.lfs?.size ?? blob.size, blob.mode, blob.lfs);
			summary.placeholders += 1;
			return;
		}
		const data = prefetched ?? (await this.gh.getBlobRaw(blob.sha));
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
		if (entry && localSha === "missing") {
			// Deleted here, changed on GitHub: the entry must describe GitHub's
			// version, or a later Keep would restore the stale one as "synced".
			this.log("info", `${path}: deleted here, changed on GitHub; now tracking GitHub's version`);
			const next: FileEntry = entry.lazy
				? { ...entry, baseBlobSha: blob.sha, remoteSize: blob.lfs?.size ?? blob.size }
				: { ...entry, baseBlobSha: blob.sha, size: blob.lfs?.size ?? blob.size };
			if (blob.lfs) next.lfs = blob.lfs;
			else delete next.lfs;
			await this.state.setFile(path, next);
		}
		if (blob.lfs || blob.size > this.config.maxAutoFetchBytes) {
			// Never buffer an oversize blob just to record a conflict, and never
			// park an LFS pointer's text as if it were the file.
			summary.conflicts += 1;
			this.log("warn", `conflict on ${path}: the GitHub version is too large to save locally; resolve it from desktop git`);
			return;
		}
		const remoteData = await this.gh.getBlobRaw(blob.sha);
		if (entry && localSha !== "missing" && !entry.lfs) {
			// (An LFS base is pointer text: never merged.)
			const baseData = await this.gh.getBlobRaw(entry.baseBlobSha);
			const localData = await this.files.readBinary(path);
			if (isUtf8Text(baseData) && isUtf8Text(localData) && isUtf8Text(remoteData)) {
				const decode = (d: ArrayBuffer) => new TextDecoder().decode(d);
				const merged = threeWayMerge(decode(localData), decode(baseData), decode(remoteData));
				if (merged !== null) {
					// The merged text stays a local change; the next push commits it.
					await this.files.writeBinary(path, new TextEncoder().encode(merged).buffer);
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
	 * The mass-deletion guard: a wiped device or a wrong remote must never
	 * silently propagate. Over the threshold the confirmer decides; with no
	 * confirmer (or an unattended run) the operation defers before it changes
	 * any file.
	 */
	private async guardDeletions(direction: "local" | "remote", paths: string[]): Promise<"delete" | "keep"> {
		if (paths.length <= this.config.maxDeletions) return "delete";
		const n = paths.length;
		const where = direction === "local" ? "on this device" : "on GitHub";
		this.log("warn", `deletion guard: ${n} deletions ${where} over threshold ${this.config.maxDeletions}: ${firstFive(paths)}`);
		const decision = (await this.config.confirmDeletions?.(direction, paths)) ?? "defer";
		if (decision === "delete") {
			this.log("info", `deleting ${n} files ${where} was confirmed`);
			return "delete";
		}
		if (decision === "keep") {
			this.log(
				"info",
				direction === "local"
					? `kept ${n} files on this device; the push adds them back to GitHub`
					: `kept ${n} files on GitHub; restoring them on this device`,
			);
			return "keep";
		}
		this.log("warn", `deferred ${n} deletions ${where} until a manual sync confirms them`);
		throw new DeletionsDeferred(`sync paused: ${n} files would be deleted ${where}; run Sync now to review them`);
	}

	/**
	 * A case-only rename on ONE physical file (a case-insensitive filesystem):
	 * probed with the twin's exact name, which resolves to this same file there,
	 * and does not exist on a case-sensitive one until a pull fetches it.
	 */
	private async isOneFileCaseRename(path: string, remote: Map<string, RemoteBlob>, localPaths: string[]): Promise<boolean> {
		const folded = localPaths.filter((p) => p.toLowerCase() === path.toLowerCase());
		const twinName = [...remote.keys()].find((p) => p !== path && p.toLowerCase() === path.toLowerCase());
		return (
			folded.length <= 1 &&
			twinName !== undefined &&
			!folded.includes(twinName) &&
			(await this.files.stat(twinName)) !== null
		);
	}

	/**
	 * Push-side keep: bring a marked entry's content back, as a placeholder
	 * where a pull would make one. True when it came back as a placeholder.
	 */
	private async restoreLocal(path: string): Promise<boolean> {
		const entry = this.state.state.files[path];
		const size = entry.remoteSize as number;
		if (entry.lfs !== undefined || this.isLazyTarget(path, size)) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, entry.baseBlobSha, true, size, entry.mode);
			return true;
		}
		await this.files.writeBinary(path, await this.gh.getBlobRaw(entry.baseBlobSha));
		await this.record(path, entry.baseBlobSha, false, undefined, entry.mode);
		return false;
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
		remoteLfs = false,
	): Promise<string> {
		return (await this.localState(path, entry, refresh, expectedSize, remoteLfs)).sha;
	}

	/**
	 * localShaIfChanged plus the bytes it read and, for an LFS file, the oid.
	 * An LFS file's sha is its virtual one: the sha its pointer blob would
	 * have, so every comparison against baseBlobSha and remote shas holds.
	 */
	private async localState(
		path: string,
		entry: FileEntry | undefined,
		refresh = true,
		expectedSize?: number,
		remoteLfs = false,
	): Promise<{ sha: string; data?: ArrayBuffer; oid?: string }> {
		const stat = await this.files.stat(path);
		if (!entry) {
			if (!stat) return { sha: "clean" }; // nothing local, nothing tracked
			if (expectedSize !== undefined && stat.size !== expectedSize && stat.size > this.config.maxPushBytes) {
				// The sizes differ, so the contents cannot match: never buffer a
				// huge untracked file just to prove it (iPad memory).
				return { sha: "size-differs" };
			}
			const data = await this.files.readBinary(path);
			return { ...(await this.contentSha(data, remoteLfs || this.lfsBySize(path, stat.size))), data };
		}
		if (!stat) return { sha: "missing" };
		if (stat.mtime === entry.mtime && stat.size === entry.size) return { sha: "clean" };
		const data = await this.files.readBinary(path);
		let hashed = await this.contentSha(data, entry.lfs !== undefined);
		const sha = hashed.sha;
		if (sha === entry.baseBlobSha) {
			// The full content is present. Recording lazy=false also heals a
			// stale lazy flag left by an interrupted evict or download, which
			// would otherwise strand every later edit as a "modified placeholder".
			if (refresh) await this.record(path, entry.baseBlobSha, false, undefined, entry.mode);
			return { sha: "clean" };
		}
		// A lazy entry whose content is still empty is an untouched stub whose
		// mtime drifted (backup restore, file-provider touch): clean, re-stamp.
		if (entry.lazy === true && sha === EMPTY_BLOB_SHA) {
			if (refresh) await this.record(path, entry.baseBlobSha, true, entry.remoteSize, entry.mode);
			return { sha: "clean" };
		}
		// An LFS file against a plain remote blob (pull, preview): only its
		// plain sha can match, and equal content then adopts.
		if (entry.lfs !== undefined && expectedSize !== undefined && !remoteLfs) return { sha: await gitBlobSha1(data), data };
		// A normal file that now goes to LFS (GitHub holds a pointer, or it
		// grew past the threshold) compares by its virtual sha.
		if (hashed.oid === undefined && (remoteLfs || this.lfsBySize(path, stat.size))) hashed = await this.contentSha(data, true);
		return { ...hashed, data };
	}

	/** git blob sha of local bytes; for an LFS file, the sha of the pointer blob it would have. */
	private async contentSha(data: ArrayBuffer, lfs: boolean): Promise<{ sha: string; oid?: string }> {
		// git-lfs never makes a pointer for empty content.
		if (!lfs || data.byteLength === 0) return { sha: await gitBlobSha1(data) };
		const oid = await sha256Hex(data);
		const pointer = new TextEncoder().encode(lfsPointer(oid, data.byteLength)).buffer as ArrayBuffer;
		return { sha: await gitBlobSha1(pointer), oid };
	}

	/**
	 * With LFS on, or for an entry that is an LFS file (parse only, so LFS
	 * off still never writes pointer text over it), a changed remote blob
	 * small enough to be a pointer is fetched and checked. Callers skip blobs whose sha matches the entry, so
	 * an unchanged pointer is never refetched; the bytes come back for reuse.
	 */
	private async detectLfs(blob: RemoteBlob, entry: FileEntry | undefined): Promise<{ blob: RemoteBlob; data?: ArrayBuffer }> {
		if (!(this.config.lfs || entry?.lfs) || blob.size >= POINTER_MAX_BYTES) return { blob };
		const data = await this.gh.getBlobRaw(blob.sha);
		const lfs = parseLfsPointer(data);
		return { blob: lfs ? { ...blob, lfs } : blob, data };
	}

	/**
	 * The files this push may send through LFS, from stat alone (fingerprint
	 * changed, within the caps, and a downloaded LFS entry or over the
	 * threshold), so no file is read here. A superset of the uploads: a file
	 * whose mtime only drifted is a candidate but hashes clean.
	 */
	private async lfsCandidates(paths: string[]): Promise<string[]> {
		const out: string[] = [];
		for (const path of paths) {
			const entry = this.state.state.files[path];
			const stat = await this.files.stat(path);
			if (!stat || (entry && stat.mtime === entry.mtime && stat.size === entry.size)) continue;
			// A placeholder is never uploaded (a drifted stub would add a line for nothing).
			if (stat.size <= this.pushCap() && ((entry?.lfs !== undefined && !entry.lazy) || this.lfsBySize(path, stat.size))) {
				out.push(path);
			}
		}
		return out;
	}

	/**
	 * Appends the exact-path LFS line for each candidate BEFORE the scan, so
	 * .gitattributes rides in the same commit as an ordinary changed file. A
	 * line for a file whose upload then fails, or whose mtime only drifted, is
	 * harmless (DEC-0002). Append-only, byte for byte. True when written.
	 */
	private async appendGitattributes(candidates: string[]): Promise<boolean> {
		const lines = candidates.map((p) => gitattributesLine(p));
		if (lines.length === 0) return false;
		await this.doFetchLazy(GITATTRIBUTES); // a placeholder's real lines come first
		const raw = (await this.files.stat(GITATTRIBUTES))
			? new Uint8Array(await this.files.readBinary(GITATTRIBUTES))
			: new Uint8Array(0);
		// Decoded only to dedupe and to match line endings: the original
		// bytes (a BOM, invalid UTF-8) are written back untouched.
		const existing = new TextDecoder().decode(raw);
		const have = new Set(existing.split(/\r?\n/));
		const add = lines.filter((l) => !have.has(l));
		if (add.length === 0) return false;
		const eol = existing.includes("\r\n") ? "\r\n" : "\n";
		const sep = raw.length === 0 || existing.endsWith("\n") ? "" : eol;
		const tail = new TextEncoder().encode(`${sep}${add.join(eol)}${eol}`);
		const out = new Uint8Array(raw.length + tail.length);
		out.set(raw);
		out.set(tail, raw.length);
		await this.files.writeBinary(GITATTRIBUTES, out.buffer);
		return true;
	}

	/**
	 * An entry's real content: from LFS for an LFS file, else its git blob.
	 * With LFS on, a blob that is a pointer (pulled while LFS was off) is
	 * downloaded instead, and its lfs comes back for the entry.
	 */
	private async fetchContent(
		entry: FileEntry,
		onProgress?: (done: number, total: number) => void,
	): Promise<{ data: ArrayBuffer; lfs?: FileEntry["lfs"] }> {
		let lfs = entry.lfs;
		if (!lfs) {
			const data = await this.gh.getBlobRaw(entry.baseBlobSha);
			lfs = (this.config.lfs && parseLfsPointer(data)) || undefined;
			if (!lfs) return { data };
		}
		if (!this.config.lfs) throw new Error("this is a Git LFS file; turn on beta features to download it");
		return { data: await this.config.lfs.download(lfs.oid, lfs.size, onProgress), lfs };
	}

	private maxLfsBytes(): number {
		return this.config.maxLfsBytes ?? 2 * 1024 ** 3;
	}

	/** The largest file a push reads: the upload limit, and with LFS on, the LFS limit. */
	private pushCap(): number {
		return this.config.lfs ? Math.min(this.config.maxPushBytes, this.maxLfsBytes()) : this.config.maxPushBytes;
	}

	/** A file new to LFS: over the threshold. Never .gitattributes, which git reads unfiltered. */
	private lfsBySize(path: string, size: number): boolean {
		return this.config.lfs !== undefined && path !== GITATTRIBUTES && size > (this.config.lfsThresholdBytes ?? 100 * 1048576);
	}

	/** Pulled as a placeholder: LFS pointers always, else the size and type rule. */
	private lazyBlob(path: string, blob: RemoteBlob): boolean {
		return blob.lfs !== undefined || this.isLazyTarget(path, blob.size);
	}

	private async record(
		path: string,
		sha: string,
		lazy: boolean,
		remoteSize?: number,
		mode?: string,
		lfs?: FileEntry["lfs"],
	): Promise<void> {
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
		// Same blob, same decision: a download, evict or revert of a kept file keeps it marked.
		const prev = this.state.state.files[path];
		if (prev?.keep && prev.baseBlobSha === sha) entry.keep = true;
		// Same pointer blob, same LFS object.
		const sameLfs = lfs ?? (prev?.baseBlobSha === sha ? prev.lfs : undefined);
		if (sameLfs) entry.lfs = sameLfs;
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
