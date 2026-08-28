import type { Http, HttpResponse } from "./ports";

export type GitHubErrorKind =
	| "auth"
	| "not-found"
	| "not-fast-forward"
	| "rate-limited"
	| "too-large"
	| "other";

export class GitHubError extends Error {
	constructor(
		public status: number,
		public kind: GitHubErrorKind,
		message: string,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree";
	sha: string | null;
	size?: number;
}

export interface GitHubClientOptions {
	owner: string;
	repo: string;
	token: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const API = "https://api.github.com";
const MAX_ATTEMPTS = 3;
const WRITE_INTERVAL_MS = 1000;

function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export class GitHubClient {
	private sleep: (ms: number) => Promise<void>;
	private now: () => number;
	private lastWriteAt = -Infinity;

	constructor(
		private http: Http,
		private opts: GitHubClientOptions,
	) {
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.now = opts.now ?? (() => Date.now());
	}

	async getRef(branch: string): Promise<string> {
		const res = await this.call("GET", `/git/ref/heads/${branch}`);
		return this.json(res).object.sha;
	}

	async getCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
		const res = await this.call("GET", `/git/commits/${sha}`);
		const body = this.json(res);
		return { treeSha: body.tree.sha, parents: body.parents.map((p: { sha: string }) => p.sha) };
	}

	async getTree(
		sha: string,
		recursive: boolean,
	): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
		const res = await this.call("GET", `/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
		const body = this.json(res);
		return { entries: body.tree, truncated: body.truncated };
	}

	async getBlobRaw(sha: string): Promise<ArrayBuffer> {
		const res = await this.call("GET", `/git/blobs/${sha}`, undefined, {
			Accept: "application/vnd.github.raw+json",
		});
		return res.arrayBuffer;
	}

	async createBlob(data: ArrayBuffer): Promise<string> {
		const wait = this.lastWriteAt + WRITE_INTERVAL_MS - this.now();
		if (wait > 0) await this.sleep(wait);
		this.lastWriteAt = this.now();
		const res = await this.call("POST", "/git/blobs", {
			content: toBase64(data),
			encoding: "base64",
		});
		return this.json(res).sha;
	}

	async createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
		const res = await this.call("POST", "/git/trees", {
			base_tree: baseTree,
			tree: entries.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
		});
		return this.json(res).sha;
	}

	async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
		const res = await this.call("POST", "/git/commits", {
			message,
			tree: treeSha,
			parents,
		});
		return this.json(res).sha;
	}

	async updateRef(branch: string, sha: string): Promise<void> {
		await this.call("PATCH", `/git/refs/heads/${branch}`, { sha, force: false });
	}

	private async call(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
		attempt = 1,
	): Promise<HttpResponse> {
		const res = await this.http.request({
			url: `${API}/repos/${this.opts.owner}/${this.opts.repo}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${this.opts.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				Accept: "application/vnd.github+json",
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...extraHeaders,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (res.status < 400) return res;

		const rateLimited =
			res.status === 429 ||
			(res.status === 403 &&
				(res.headers["retry-after"] !== undefined ||
					res.headers["x-ratelimit-remaining"] === "0"));
		if (rateLimited && attempt < MAX_ATTEMPTS) {
			await this.sleep(this.retryDelayMs(res));
			return this.call(method, path, body, extraHeaders, attempt + 1);
		}
		throw this.toError(res, path, rateLimited);
	}

	private retryDelayMs(res: HttpResponse): number {
		const retryAfter = Number(res.headers["retry-after"]);
		if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
		const reset = Number(res.headers["x-ratelimit-reset"]);
		if (Number.isFinite(reset) && reset > 0) {
			return Math.max(1000, reset * 1000 - this.now());
		}
		return 1000;
	}

	private toError(res: HttpResponse, path: string, rateLimited: boolean): GitHubError {
		let message = `GitHub ${res.status} on ${path}`;
		try {
			message = `${message}: ${JSON.parse(res.text).message}`;
		} catch {
			// non-JSON error body; keep the generic message
		}
		let kind: GitHubErrorKind = "other";
		if (rateLimited) kind = "rate-limited";
		else if (res.status === 401 || res.status === 403) kind = "auth";
		else if (res.status === 404) kind = "not-found";
		else if (res.status === 422 && path.startsWith("/git/refs/")) kind = "not-fast-forward";
		else if (res.status === 413) kind = "too-large";
		return new GitHubError(res.status, kind, message);
	}

	private json(res: HttpResponse): any {
		return JSON.parse(res.text);
	}
}
