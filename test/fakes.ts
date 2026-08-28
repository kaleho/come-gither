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

/** In-memory GitHub remote: one head commit over a flat set of files. */
export class FakeGitHub {
	head = "commit-0";
	filesByPath = new Map<string, RemoteFile>();
	blobFetches: string[] = [];
	treeFetches: string[] = [];
	failNextBlobFetches = 0;
	truncateRecursive = false;
	private commitCounter = 0;

	async setFiles(contents: Record<string, Uint8Array | string>): Promise<void> {
		this.filesByPath.clear();
		for (const [path, data] of Object.entries(contents)) {
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			this.filesByPath.set(path, { sha: await gitSha(bytes), size: bytes.length, bytes });
		}
		this.head = `commit-${++this.commitCounter}`;
	}

	async getRef(_branch: string): Promise<string> {
		return this.head;
	}

	async getCommit(sha: string): Promise<{ treeSha: string; parents: string[] }> {
		return { treeSha: `tree-of-${sha}`, parents: [] };
	}

	async getTree(sha: string, recursive: boolean) {
		this.treeFetches.push(`${sha}:${recursive}`);
		const blob = (path: string, f: RemoteFile) => ({
			path,
			mode: "100644",
			type: "blob" as const,
			sha: f.sha,
			size: f.size,
		});
		if (recursive) {
			if (this.truncateRecursive) return { entries: [], truncated: true };
			// Real recursive listings include tree rows alongside blobs.
			const dirs = new Set<string>();
			for (const p of this.filesByPath.keys()) {
				const parts = p.split("/").slice(0, -1);
				for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
			}
			return {
				entries: [
					...[...dirs].map((d) => ({ path: d, mode: "040000", type: "tree" as const, sha: `dir:${d}/` })),
					...[...this.filesByPath.entries()].map(([p, f]) => blob(p, f)),
				],
				truncated: false,
			};
		}
		// Non-recursive: one level under the directory the tree sha names.
		const prefix = sha.startsWith("dir:") ? sha.slice(4) : "";
		const seen = new Map<string, ReturnType<typeof blob> | { path: string; mode: string; type: "tree"; sha: string; size?: number }>();
		for (const [p, f] of this.filesByPath) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) seen.set(rest, blob(rest, f));
			else {
				const dir = rest.slice(0, slash);
				seen.set(dir, { path: dir, mode: "040000", type: "tree", sha: `dir:${prefix}${dir}/` });
			}
		}
		return { entries: [...seen.values()], truncated: false };
	}

	async getBlobRaw(sha: string): Promise<ArrayBuffer> {
		if (this.failNextBlobFetches > 0) {
			this.failNextBlobFetches -= 1;
			throw new Error("network dropped");
		}
		this.blobFetches.push(sha);
		for (const f of this.filesByPath.values()) {
			if (f.sha === sha) return f.bytes.slice().buffer as ArrayBuffer;
		}
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
