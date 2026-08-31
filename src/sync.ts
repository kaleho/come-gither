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
}

export const DEFAULT_TEXT_EXTENSIONS = [
	"md", "txt", "json", "css", "js", "html", "csv", "canvas", "svg", "sh", "yml", "yaml",
];

export const EXCLUDED_PREFIXES = ["_conflicts/", ".obsidian/plugins/come-gither/"];

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
	commit: string | null;
}

export type IncomingAction =
	| "fetch"
	| "placeholder"
	| "delete"
	| "both-changed"
	| "keep-local"
	| "adopt"
	| "overwrite";
export type OutgoingAction = "new" | "modified" | "deleted" | "skip-oversize" | "skip-placeholder";

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

	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.chain;
		const run = (async () => {
			await prev.catch(() => {});
			return fn();
		})();
		this.chain = run.catch(() => {});
		return run;
	}

	fetchLazy(path: string): Promise<"fetched" | "not-lazy" | "modified"> {
		return this.locked(() => this.doFetchLazy(path));
	}

	evict(path: string): Promise<"evicted" | "not-evictable" | "modified"> {
		return this.locked(() => this.doEvict(path));
	}

	preview(): Promise<SyncPlan> {
		return this.locked(() => this.doPreview());
	}

	revert(path: string): Promise<"reverted" | "clean"> {
		return this.locked(() => this.doRevert(path));
	}

	push(): Promise<PushSummary> {
		return this.locked(() => this.doPush());
	}

	sync(): Promise<{ pull: PullSummary; push: PushSummary }> {
		return this.locked(() => this.doSync());
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
		await this.record(path, entry.baseBlobSha, false);
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
		await this.state.setFile(path, { baseBlobSha: entry.baseBlobSha, size: 0, mtime: 0, lazy: true, remoteSize });
		await this.state.flush();
		await this.files.writeBinary(path, new ArrayBuffer(0));
		await this.record(path, entry.baseBlobSha, true, remoteSize);
		await this.state.flush();
		this.log("info", `evicted ${path}; the placeholder stays until you download it again`);
		return "evicted";
	}

	/** Read-only classification of what the next sync would do. Fetches no blobs, writes nothing. */
	private async doPreview(): Promise<SyncPlan> {
		const plan: SyncPlan = { headMoved: false, incoming: [], outgoing: [] };
		const head = await this.gh.getRef(this.config.branch);
		if (head !== this.state.state.lastSyncedCommit) {
			plan.headMoved = true;
			const { treeSha } = await this.gh.getCommit(head);
			const remote = await this.listRemote(treeSha);
			for (const [path, blob] of remote) {
				if (this.excluded(path)) continue;
				const entry = this.state.state.files[path];
				if (entry && entry.baseBlobSha === blob.sha) continue;
				const localSha = await this.localShaIfChanged(path, entry, false);
				let action: IncomingAction;
				const staleStub = !entry && localSha === EMPTY_BLOB_SHA;
				if (localSha === "clean" || staleStub) action = this.isLazyTarget(path, blob.size) ? "placeholder" : "fetch";
				else if (localSha === blob.sha) action = "adopt";
				else if (path.startsWith(".obsidian/") || this.config.conflictPolicy === "remote-wins") action = "overwrite";
				else action = "both-changed";
				plan.incoming.push({ path, action });
			}
			for (const path of Object.keys(this.state.state.files)) {
				if (remote.has(path) || this.excluded(path)) continue;
				const localSha = await this.localShaIfChanged(path, this.state.state.files[path], false);
				plan.incoming.push({ path, action: localSha === "clean" ? "delete" : "keep-local" });
			}
		}
		const localPaths = new Set(
			(await this.files.listRecursive("")).filter((p) => !this.excluded(p)),
		);
		for (const path of localPaths) {
			const entry = this.state.state.files[path];
			const localSha = await this.localShaIfChanged(path, entry, false);
			if (localSha === "clean") continue;
			if (entry?.lazy) {
				plan.outgoing.push({ path, action: "skip-placeholder" });
				continue;
			}
			const stat = (await this.files.stat(path)) as { size: number };
			plan.outgoing.push({
				path,
				action: stat.size > this.config.maxPushBytes ? "skip-oversize" : entry ? "modified" : "new",
			});
		}
		for (const path of Object.keys(this.state.state.files)) {
			const entry = this.state.state.files[path];
			if (localPaths.has(path) || entry.lazy) continue;
			plan.outgoing.push({ path, action: "deleted" });
		}
		return plan;
	}

	/** Discard a local change: restore the last-synced content (or stub), or delete a new file. */
	private async doRevert(path: string): Promise<"reverted" | "clean"> {
		const entry = this.state.state.files[path];
		if (!entry) {
			if ((await this.files.stat(path)) === null) return "clean";
			await this.files.remove(path);
			this.log("info", `reverted ${path}: removed the new file`);
			return "reverted";
		}
		if ((await this.localShaIfChanged(path, entry, false)) === "clean") return "clean";
		if (entry.lazy) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, entry.baseBlobSha, true, entry.remoteSize);
		} else {
			const data = await this.gh.getBlobRaw(entry.baseBlobSha);
			await this.files.writeBinary(path, data);
			await this.record(path, entry.baseBlobSha, false);
		}
		await this.state.flush();
		this.log("info", `reverted ${path} to its last-synced content`);
		return "reverted";
	}

	private async doPush(): Promise<PushSummary> {
		const summary: PushSummary = { pushed: 0, deletedRemote: 0, skipped: 0, commit: null };
		const treeEntries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
		const localPaths = new Set(
			(await this.files.listRecursive("")).filter((p) => !this.excluded(p)),
		);

		for (const path of localPaths) {
			const entry = this.state.state.files[path];
			const localSha = await this.localShaIfChanged(path, entry);
			if (localSha === "clean") continue;
			if (entry?.lazy) {
				summary.skipped += 1;
				this.log("warn", `${path} is an unfetched placeholder that was modified locally; not pushing it`);
				continue;
			}
			const stat = (await this.files.stat(path)) as { size: number };
			if (stat.size > this.config.maxPushBytes) {
				summary.skipped += 1;
				this.log("warn", `${path} is ${stat.size} bytes, over the push limit; push it from desktop git`);
				continue;
			}
			const sha = await this.gh.createBlob(await this.files.readBinary(path));
			treeEntries.push({ path, mode: "100644", type: "blob", sha });
			summary.pushed += 1;
		}

		const droppedPaths: string[] = [];
		let restoredPlaceholders = 0;
		for (const path of Object.keys(this.state.state.files)) {
			if (localPaths.has(path)) continue;
			const entry = this.state.state.files[path];
			if (entry.lazy) {
				// A deleted placeholder must never delete the real remote file;
				// its content was never on this device to judge. Restore the stub.
				await this.files.writeBinary(path, new ArrayBuffer(0));
				await this.record(path, entry.baseBlobSha, true, entry.remoteSize);
				restoredPlaceholders += 1;
				this.log("info", `restored the placeholder for ${path}`);
				continue;
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
			if (e.sha !== null) await this.record(e.path, e.sha, false);
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

		for (const path of Object.keys(this.state.state.files)) {
			if (remote.has(path) || this.excluded(path)) continue;
			await this.applyRemoteDelete(path, summary);
		}

		await this.state.setCommit(head);
		this.log(
			"info",
			`pull done: ${summary.fetched} fetched, ${summary.placeholders} placeholders, ${summary.adopted} adopted, ${summary.deleted} deleted, ${summary.conflicts} conflicts`,
		);
		return summary;
	}

	private async applyRemoteChange(
		path: string,
		blob: RemoteBlob,
		entry: FileEntry | undefined,
		summary: PullSummary,
	): Promise<void> {
		const localSha = await this.localShaIfChanged(path, entry);
		if (localSha !== "clean") {
			if (localSha === blob.sha) {
				// Local content already equals the remote blob: adopt it.
				await this.record(path, blob.sha, false);
				summary.adopted += 1;
				return;
			}
			// A stale zero-byte stub with no tracking has no user data to protect.
			const staleStub = !entry && localSha === EMPTY_BLOB_SHA;
			if (!staleStub && !path.startsWith(".obsidian/") && this.config.conflictPolicy === "merge") {
				await this.resolveConflict(path, blob, entry, localSha, summary);
				return;
			}
			// stale stub, remote-wins policy, and .obsidian/ always: fall through and overwrite.
		}
		if (this.isLazyTarget(path, blob.size)) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, blob.sha, true, blob.size);
			summary.placeholders += 1;
			return;
		}
		const data = await this.gh.getBlobRaw(blob.sha);
		await this.files.writeBinary(path, data);
		await this.record(path, blob.sha, false);
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
		await this.files.writeBinary(`_conflicts/${path}`, remoteData);
		summary.conflicts += 1;
		this.log("warn", `conflict on ${path}: kept the local version, saved the remote one to _conflicts/${path}`);
	}

	private async applyRemoteDelete(path: string, summary: PullSummary): Promise<void> {
		const entry = this.state.state.files[path];
		const localSha = await this.localShaIfChanged(path, entry);
		if (localSha !== "clean") {
			summary.conflicts += 1;
			this.log("warn", `conflict on ${path}: deleted remotely but changed locally, keeping it`);
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
	): Promise<string> {
		const stat = await this.files.stat(path);
		if (!entry) {
			if (!stat) return "clean"; // nothing local, nothing tracked
			return gitBlobSha1(await this.files.readBinary(path));
		}
		if (!stat) return "missing";
		if (stat.mtime === entry.mtime && stat.size === entry.size) return "clean";
		const sha = await gitBlobSha1(await this.files.readBinary(path));
		if (sha === entry.baseBlobSha) {
			if (refresh) {
				await this.record(path, entry.baseBlobSha, entry.lazy === true, entry.remoteSize); // refresh fingerprint
			}
			return "clean";
		}
		return sha;
	}

	private async record(path: string, sha: string, lazy: boolean, remoteSize?: number): Promise<void> {
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
		await this.state.setFile(path, entry);
	}

	private async listRemote(treeSha: string): Promise<Map<string, RemoteBlob>> {
		const out = new Map<string, RemoteBlob>();
		const top = await this.gh.getTree(treeSha, true);
		if (!top.truncated) {
			for (const e of top.entries) {
				if (e.type === "blob") out.set(e.path, { sha: e.sha as string, size: e.size as number });
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
			if (e.type === "blob") out.set(`${prefix}${e.path}`, { sha: e.sha as string, size: e.size as number });
			else await this.walk(e.sha as string, `${prefix}${e.path}/`, out);
		}
	}

	private isLazyTarget(path: string, size: number): boolean {
		return size > this.config.maxAutoFetchBytes || (!this.isText(path) && !path.startsWith(".obsidian/"));
	}

	private excluded(path: string): boolean {
		return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
	}

	private isText(path: string): boolean {
		const dot = path.lastIndexOf(".");
		if (dot === -1) return false;
		return this.config.textExtensions.includes(path.slice(dot + 1).toLowerCase());
	}
}
