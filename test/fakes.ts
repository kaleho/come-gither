import { GitHubError } from "../src/github";
import type { Http, HttpRequest, HttpResponse } from "../src/ports";

type Rule = {
	method: string;
	urlPart: string;
	response: Partial<HttpResponse>;
	times: number;
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Partial<HttpResponse> {
	const text = JSON.stringify(body);
	return { status, headers, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

export function binaryResponse(bytes: Uint8Array, status = 200): Partial<HttpResponse> {
	return { status, headers: {}, text: "", arrayBuffer: bytes.buffer as ArrayBuffer };
}

export class FakeHttp implements Http {
	requests: HttpRequest[] = [];
	private rules: Rule[] = [];

	on(method: string, urlPart: string, response: Partial<HttpResponse>, times = Infinity): void {
		this.rules.push({ method, urlPart, response, times });
	}

	async request(req: HttpRequest): Promise<HttpResponse> {
		this.requests.push(req);
		const method = (req.method ?? "GET").toUpperCase();
		const rule = this.rules.find(
			(r) => r.times > 0 && r.method.toUpperCase() === method && req.url.includes(r.urlPart),
		);
		if (!rule) throw new Error(`FakeHttp: no rule for ${method} ${req.url}`);
		rule.times -= 1;
		return {
			status: rule.response.status ?? 200,
			headers: rule.response.headers ?? {},
			text: rule.response.text ?? "",
			arrayBuffer: rule.response.arrayBuffer ?? new ArrayBuffer(0),
		};
	}

	bodyOf(index: number): Record<string, unknown> {
		return JSON.parse(this.requests[index].body as string);
	}
}

import type { Files } from "../src/ports";

export class MemFiles implements Files {
	store = new Map<string, Uint8Array>();
	mtimes = new Map<string, number>();
	writes: string[] = [];
	private tick = 0;

	async readBinary(path: string): Promise<ArrayBuffer> {
		const data = this.store.get(path);
		if (!data) throw new Error(`ENOENT: ${path}`);
		return data.slice().buffer as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.store.set(path, new Uint8Array(data.slice(0)));
		this.mtimes.set(path, ++this.tick);
		this.writes.push(path);
	}

	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const data = this.store.get(path);
		if (!data) return null;
		return { mtime: this.mtimes.get(path) ?? 0, size: data.byteLength };
	}

	async listRecursive(prefix: string): Promise<string[]> {
		return [...this.store.keys()].filter((p) => p.startsWith(prefix)).sort();
	}

	async remove(path: string): Promise<void> {
		this.store.delete(path);
		this.mtimes.delete(path);
	}

	writeText(path: string, text: string): void {
		this.store.set(path, new TextEncoder().encode(text));
	}

	readText(path: string): string {
		const data = this.store.get(path);
		if (!data) throw new Error(`ENOENT: ${path}`);
		return new TextDecoder().decode(data);
	}
}

/** Git blob SHA-1 of raw bytes, independent of the implementation under test. */
export async function gitSha(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const full = new Uint8Array(header.length + bytes.length);
	full.set(header);
	full.set(bytes, header.length);
	const digest = await crypto.subtle.digest("SHA-1", full);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface RemoteFile {
	sha: string;
	size: number;
	bytes: Uint8Array;
}

/**
 * In-memory GitHub remote. Mirrors the API semantics the engine depends on:
 * trees are snapshot-addressed by sha, a pushed commit records its real tree,
 * and create-tree rejects a null-sha delete for a path absent from the base
 * tree, exactly as GitHub does.
 */
export class FakeGitHub {
	head = "commit-0";
	filesByPath = new Map<string, RemoteFile>();
	/** Optional per-path git mode; getTree serves "100644" for unlisted paths. */
	modes = new Map<string, string>();
	blobFetches: string[] = [];
	treeFetches: string[] = [];
	failNextBlobFetches = 0;
	/** Fail the nth getBlobRaw call of the test (0-based), once. */
	failBlobFetchAtIndex: number | null = null;
	truncateRecursive = false;
	private commitCounter = 0;
	private blobFetchCount = 0;

	private allBlobs = new Map<string, Uint8Array>();
	private snapshots = new Map<string, Map<string, RemoteFile>>();

	async setFiles(contents: Record<string, Uint8Array | string>): Promise<void> {
		this.filesByPath = new Map();
		for (const [path, data] of Object.entries(contents)) {
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			const sha = await gitSha(bytes);
			this.filesByPath.set(path, { sha, size: bytes.length, bytes });
			this.allBlobs.set(sha, bytes); // git keeps every historical blob
		}
		this.head = `commit-${++this.commitCounter}`;
		this.snapshots.set(`tree-of-${this.head}`, new Map(this.filesByPath));
	}

	async getRef(_branch: string): Promise<string> {
		return this.head;
	}

	async getCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
		const pushed = this.pushedCommits.get(sha);
		if (pushed) return { treeSha: pushed.treeSha, parents: pushed.parents };
		return { treeSha: `tree-of-${sha}`, parents: [] };
	}

	private resolveTree(sha: string): { map: Map<string, RemoteFile>; root: string; prefix: string } {
		if (sha.startsWith("dir:")) {
			const rest = sha.slice(4);
			const cut = rest.indexOf(":");
			const root = rest.slice(0, cut);
			return { map: this.snapshots.get(root) ?? this.filesByPath, root, prefix: rest.slice(cut + 1) };
		}
		return { map: this.snapshots.get(sha) ?? this.filesByPath, root: sha, prefix: "" };
	}

	async getTree(sha: string, recursive: boolean) {
		this.treeFetches.push(`${sha}:${recursive}`);
		const { map, root, prefix } = this.resolveTree(sha);
		const blob = (path: string, f: RemoteFile, fullPath = path) => ({
			path,
			mode: this.modes.get(fullPath) ?? "100644",
			type: "blob" as const,
			sha: f.sha,
			size: f.size,
		});
		if (recursive) {
			if (this.truncateRecursive) return { entries: [], truncated: true };
			// Real recursive listings include tree rows alongside blobs.
			const dirs = new Set<string>();
			for (const p of map.keys()) {
				const parts = p.split("/").slice(0, -1);
				for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
			}
			return {
				entries: [
					...[...dirs].map((d) => ({ path: d, mode: "040000", type: "tree" as const, sha: `dir:${root}:${d}/` })),
					...[...map.entries()].map(([p, f]) => blob(p, f)),
				],
				truncated: false,
			};
		}
		// Non-recursive: one level under the directory the tree sha names.
		const seen = new Map<string, ReturnType<typeof blob> | { path: string; mode: string; type: "tree"; sha: string; size?: number }>();
		for (const [p, f] of map) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) seen.set(rest, blob(rest, f, p));
			else {
				const dir = rest.slice(0, slash);
				seen.set(dir, { path: dir, mode: "040000", type: "tree", sha: `dir:${root}:${prefix}${dir}/` });
			}
		}
		return { entries: [...seen.values()], truncated: false };
	}

	createdBlobs = new Map<string, Uint8Array>();
	pushedTrees: { baseTree: string; entries: { path: string; mode: string; type: string; sha: string | null }[] }[] = [];
	pushedCommits = new Map<string, { parents: string[]; message: string; treeSha: string }>();
	failUpdateRefTimes = 0;
	/** Test hook: awaited at the top of createBlob, so a test can hold a push mid-flight. */
	onCreateBlob?: () => Promise<void> | void;
	private pushCounter = 0;

	createBlobCalls = 0;

	async createBlob(data: ArrayBuffer): Promise<string> {
		this.createBlobCalls += 1;
		if (this.onCreateBlob) await this.onCreateBlob();
		const bytes = new Uint8Array(data);
		const sha = await gitSha(bytes);
		this.createdBlobs.set(sha, bytes);
		this.allBlobs.set(sha, bytes);
		return sha;
	}

	async createTree(
		baseTree: string,
		entries: { path: string; mode: string; type: "blob" | "tree"; sha: string | null }[],
	): Promise<string> {
		const base = this.snapshots.get(baseTree);
		if (!base) throw new GitHubError(404, "not-found", `fake: unknown base tree ${baseTree}`);
		const result = new Map(base);
		for (const e of entries) {
			if (e.sha === null) {
				// GitHub 422s a delete for a path the base tree does not contain.
				if (!base.has(e.path)) {
					throw new GitHubError(422, "other", `fake: cannot delete ${e.path}: not in base tree`);
				}
				result.delete(e.path);
				continue;
			}
			const bytes = this.allBlobs.get(e.sha);
			if (!bytes) throw new GitHubError(404, "not-found", `fake: unknown blob ${e.sha}`);
			result.set(e.path, { sha: e.sha, size: bytes.length, bytes });
		}
		const treeSha = `tree-push-${++this.pushCounter}`;
		this.snapshots.set(treeSha, result);
		this.pushedTrees.push({ baseTree, entries });
		return treeSha;
	}

	async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
		const sha = `commit-push-${this.pushCounter}`;
		this.pushedCommits.set(sha, { parents, message, treeSha });
		return sha;
	}

	async updateRef(_branch: string, sha: string): Promise<void> {
		if (this.failUpdateRefTimes > 0) {
			this.failUpdateRefTimes -= 1;
			throw new GitHubError(422, "not-fast-forward", "fake: ref moved");
		}
		const commit = this.pushedCommits.get(sha);
		if (!commit || commit.parents[0] !== this.head) {
			throw new GitHubError(422, "not-fast-forward", "fake: not a fast forward");
		}
		this.head = sha;
		// The remote now serves the pushed tree's content.
		this.filesByPath = new Map(this.snapshots.get(commit.treeSha) as Map<string, RemoteFile>);
	}

	async getBlobRaw(sha: string): Promise<ArrayBuffer> {
		const index = this.blobFetchCount++;
		if (this.failNextBlobFetches > 0) {
			this.failNextBlobFetches -= 1;
			throw new Error("network dropped");
		}
		if (this.failBlobFetchAtIndex === index) {
			this.failBlobFetchAtIndex = null;
			throw new Error("network dropped");
		}
		this.blobFetches.push(sha);
		const bytes = this.allBlobs.get(sha);
		if (bytes) return bytes.slice().buffer as ArrayBuffer;
		throw new Error(`no blob ${sha}`);
	}
}

/** Virtual clock: sleep() advances time instantly and records the delay. */
export class FakeClock {
	t = 0;
	sleeps: number[] = [];
	sleep = async (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.t += ms;
	};
	now = (): number => this.t;
}
