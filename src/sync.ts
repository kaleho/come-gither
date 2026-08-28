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
}

export interface SyncConfig {
	branch: string;
	textExtensions: string[];
	maxAutoFetchBytes: number;
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
	conflicts: number;
}

export type LogFn = (level: "info" | "warn" | "error", message: string) => void;

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

	async pull(): Promise<PullSummary> {
		const summary: PullSummary = {
			upToDate: false,
			fetched: 0,
			placeholders: 0,
			adopted: 0,
			deleted: 0,
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
			if (!path.startsWith(".obsidian/")) {
				// ponytail: M4 keeps the local side on any conflict; M6 adds diff3 + policy.
				summary.conflicts += 1;
				this.log("warn", `conflict on ${path}: keeping the local version`);
				return;
			}
			// .obsidian/ is pinned remote-wins: fall through and overwrite.
		}
		if (blob.size > this.config.maxAutoFetchBytes || (!this.isText(path) && !path.startsWith(".obsidian/"))) {
			await this.files.writeBinary(path, new ArrayBuffer(0));
			await this.record(path, blob.sha, true);
			summary.placeholders += 1;
			return;
		}
		const data = await this.gh.getBlobRaw(blob.sha);
		await this.files.writeBinary(path, data);
		await this.record(path, blob.sha, false);
		summary.fetched += 1;
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
			await this.record(path, entry.baseBlobSha, entry.lazy === true); // refresh fingerprint
			return "clean";
		}
		return sha;
	}

	private async record(path: string, sha: string, lazy: boolean): Promise<void> {
		// Only ever called right after a write or on an existing file.
		const stat = (await this.files.stat(path)) as { mtime: number; size: number };
		const entry: FileEntry = {
			baseBlobSha: sha,
			size: stat.size,
			mtime: stat.mtime,
		};
		if (lazy) entry.lazy = true;
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

	private excluded(path: string): boolean {
		return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
	}

	private isText(path: string): boolean {
		const dot = path.lastIndexOf(".");
		if (dot === -1) return false;
		return this.config.textExtensions.includes(path.slice(dot + 1).toLowerCase());
	}
}
