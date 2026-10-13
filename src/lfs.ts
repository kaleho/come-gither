// Git LFS over the batch API, plus the beta "Test large file support" runner.
// Protocol notes: SES-0001, FND-0001.
import type { GitHubClient } from "./github";
import type { Http } from "./ports";

export interface LfsAction {
	href: string;
	header: Record<string, string>;
}

export interface LfsBatchResult {
	status: number;
	actions: { upload?: LfsAction; verify?: LfsAction; download?: LfsAction };
	error?: { code: number; message: string };
}

const LFS_TYPE = "application/vnd.git-lfs+json";
const RANGE_CHECK_BYTES = 1024 * 1024;

export function lfsPointer(oid: string, size: number): string {
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A .gitattributes line that marks exactly `path` for LFS. The leading "/"
 * anchors it to the repo root (and neutralises a leading "#" or "!"). Glob
 * characters get a backslash; whitespace becomes [[:space:]], as `git lfs track` writes it.
 */
export function gitattributesLine(path: string): string {
	const pattern = path.replace(/[\\*?[]/g, "\\$&").replace(/[ \t]/g, "[[:space:]]");
	return `/${pattern} filter=lfs diff=lfs merge=lfs -text`;
}

type RawAction = { href: string; header?: Record<string, string> };

export class LfsClient {
	constructor(
		private http: Http,
		private cfg: { owner: string; repo: string; token: string },
	) {}

	async batch(operation: "upload" | "download", oid: string, size: number): Promise<LfsBatchResult> {
		const res = await this.http.request({
			url: `https://github.com/${this.cfg.owner}/${this.cfg.repo}.git/info/lfs/objects/batch`,
			method: "POST",
			headers: {
				Accept: LFS_TYPE,
				"Content-Type": LFS_TYPE,
				// GitHub ignores the username when the password is a token.
				Authorization: `Basic ${btoa(`x-access-token:${this.cfg.token}`)}`,
			},
			body: JSON.stringify({ operation, transfers: ["basic"], objects: [{ oid, size }], hash_algo: "sha256" }),
			throw: false,
		});
		if (res.status !== 200) return { status: res.status, actions: {} };
		const obj = (JSON.parse(res.text) as {
			objects: { actions?: Record<string, RawAction>; error?: { code: number; message: string } }[];
		}).objects[0];
		const actions: LfsBatchResult["actions"] = {};
		for (const [name, a] of Object.entries(obj.actions ?? {})) {
			actions[name as keyof LfsBatchResult["actions"]] = { href: a.href, header: a.header ?? {} };
		}
		return obj.error ? { status: res.status, actions, error: obj.error } : { status: res.status, actions };
	}

	async verify(action: LfsAction, oid: string, size: number): Promise<number> {
		const res = await this.http.request({
			url: action.href,
			method: "POST",
			headers: { ...action.header, Accept: LFS_TYPE, "Content-Type": LFS_TYPE },
			body: JSON.stringify({ oid, size }),
			throw: false,
		});
		return res.status;
	}

	async readRange(action: LfsAction, start: number, endInclusive: number): Promise<{ status: number; data: ArrayBuffer }> {
		const res = await this.http.request({
			url: action.href,
			method: "GET",
			headers: { ...action.header, Range: `bytes=${start}-${endInclusive}` },
			throw: false,
		});
		return { status: res.status, data: res.arrayBuffer };
	}
}

/** HTTP status; throws on transport failure (e.g. CORS). */
export type Uploader = (action: LfsAction, data: ArrayBuffer) => Promise<number>;

/** One PUT of the whole body with only the action's own header: the GitHub token never goes to storage. */
export function httpUploader(http: Http): Uploader {
	return async (action, data) =>
		(await http.request({ url: action.href, method: "PUT", headers: { ...action.header }, body: data, throw: false })).status;
}

export interface LfsStepResult {
	step: string;
	ok: boolean;
	detail: string;
}

export interface LfsTestDeps {
	lfs: LfsClient;
	gh: Pick<GitHubClient, "getRef" | "getCommit" | "createBlob" | "createTree" | "createCommit" | "createRef" | "deleteRef">;
	baseBranch: string;
	uploaders: { name: string; put: Uploader }[];
	checkpoint: (message: string) => Promise<void>;
	now: () => number;
}

export const LFS_TEST_BRANCH = "come-gither-lfs-test";

const is2xx = (status: number) => status >= 200 && status < 300;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the LFS round trip step by step. Each step yields one result; a step
 * whose prerequisite failed reports "skipped: <reason>". Errors become failed steps.
 */
export async function runLfsTest(deps: LfsTestDeps, path: string, data: ArrayBuffer): Promise<LfsStepResult[]> {
	const results: LfsStepResult[] = [];
	const step = async (name: string, skipReason: string | null, fn: () => Promise<[boolean, string]>) => {
		await deps.checkpoint(`LFS test: ${name}`);
		let outcome: [boolean, string];
		try {
			outcome = skipReason !== null ? [false, `skipped: ${skipReason}`] : await fn();
		} catch (e) {
			outcome = [false, errText(e)];
		}
		results.push({ step: name, ok: outcome[0], detail: outcome[1] });
		return outcome[0];
	};

	let oid = "";
	const size = data.byteLength;
	const hashed = await step("hash", null, async () => {
		const start = deps.now();
		oid = await sha256Hex(data);
		return [true, `oid ${oid.slice(0, 12)}…, ${deps.now() - start} ms`];
	});

	let upload: LfsBatchResult | null = null;
	const batched = await step("batch upload", hashed ? null : "hash failed", async () => {
		upload = await deps.lfs.batch("upload", oid, size);
		if (upload.status === 401 || upload.status === 403) {
			return [false, `HTTP ${upload.status}: the token cannot use LFS on this repo`];
		}
		if (upload.status !== 200) return [false, `HTTP ${upload.status}`];
		if (upload.error) return [false, `HTTP 200, object error ${upload.error.code}: ${upload.error.message}`];
		return [true, "HTTP 200"];
	});
	const actions = (upload as LfsBatchResult | null)?.actions ?? {};

	const uploaded = await step("upload", batched ? null : "batch upload failed", async () => {
		if (!actions.upload) return [true, "already on GitHub"];
		const tried: string[] = [];
		for (const u of deps.uploaders) {
			try {
				const status = await u.put(actions.upload, data);
				tried.push(`${u.name}: ${status}`);
				if (is2xx(status)) return [true, tried.join("; ")];
			} catch (e) {
				tried.push(`${u.name}: ${errText(e)}`);
			}
		}
		return [false, tried.join("; ")];
	});

	const stored = await step("verify", uploaded ? null : "upload failed", async () => {
		if (!actions.verify) return [true, "no verify requested"];
		const status = await deps.lfs.verify(actions.verify, oid, size);
		return [is2xx(status), `HTTP ${status}`];
	});

	// The branch is created directly at the pointer commit. A branch left by a
	// crashed run is deleted and recreated, so it never carries stale commits.
	let created = false;
	await step("pointer commit", stored ? null : "object not stored", async () => {
		const head = await deps.gh.getRef(deps.baseBranch);
		const { treeSha } = await deps.gh.getCommit(head);
		const enc = new TextEncoder();
		const attrSha = await deps.gh.createBlob(enc.encode(`${gitattributesLine(path)}\n`).buffer as ArrayBuffer);
		const pointerSha = await deps.gh.createBlob(enc.encode(lfsPointer(oid, size)).buffer as ArrayBuffer);
		const tree = await deps.gh.createTree(treeSha, [
			{ path: ".gitattributes", mode: "100644", type: "blob", sha: attrSha },
			{ path, mode: "100644", type: "blob", sha: pointerSha },
		]);
		const commit = await deps.gh.createCommit("Come Gither LFS test", tree, [head]);
		let note = "";
		try {
			await deps.gh.createRef(LFS_TEST_BRANCH, commit);
		} catch (e) {
			if (!(e instanceof Error && "status" in e && e.status === 422)) throw e;
			await deps.gh.deleteRef(LFS_TEST_BRANCH);
			await deps.gh.createRef(LFS_TEST_BRANCH, commit);
			note = " (replaced a stale branch)";
		}
		created = true;
		return [true, `${LFS_TEST_BRANCH} at ${commit.slice(0, 7)}${note}`];
	});

	await step("download check", stored ? null : "object not stored", async () => {
		const down = await deps.lfs.batch("download", oid, size);
		if (!down.actions.download) {
			return [false, down.error ? `no download action: ${down.error.message}` : `no download action (HTTP ${down.status})`];
		}
		const n = Math.min(size, RANGE_CHECK_BYTES);
		const res = await deps.lfs.readRange(down.actions.download, 0, n - 1);
		const got = new Uint8Array(res.data).subarray(0, n);
		const want = new Uint8Array(data, 0, n);
		const match = got.length === n && got.every((b, i) => b === want[i]);
		return [match, `HTTP ${res.status}, first ${n} bytes ${match ? "match" : "mismatch"}`];
	});

	await step("cleanup", created ? null : "branch not created", async () => {
		await deps.gh.deleteRef(LFS_TEST_BRANCH);
		return [true, `deleted ${LFS_TEST_BRANCH}`];
	});

	return results;
}

/** One "✓/✗ step — detail" line per step, for the results modal, the log, and the Notice. */
export function lfsTestSummary(results: LfsStepResult[]): { passed: number; total: number; lines: string[] } {
	return {
		passed: results.filter((r) => r.ok).length,
		total: results.length,
		lines: results.map((r) => `${r.ok ? "✓" : "✗"} ${r.step} — ${r.detail}`),
	};
}

const POINTER_MAX_BYTES = 1024;

/** oid and size of a v1 LFS pointer (spec: under 1024 bytes, LF endings), else null. */
export function parseLfsPointer(data: ArrayBuffer): { oid: string; size: number } | null {
	if (data.byteLength >= POINTER_MAX_BYTES) return null;
	const text = new TextDecoder().decode(data);
	if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n") || !text.endsWith("\n")) return null;
	const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text);
	const size = /^size (\d+)$/m.exec(text);
	if (!oid || !size || text.includes("\r")) return null;
	return { oid: oid[1], size: Number(size[1]) };
}

async function batchOrThrow(lfs: LfsClient, operation: "upload" | "download", oid: string, size: number): Promise<LfsBatchResult> {
	const res = await lfs.batch(operation, oid, size);
	if (res.status === 401 || res.status === 403) {
		throw new Error(`LFS batch ${operation} failed: HTTP ${res.status}: the token cannot use LFS on this repo`);
	}
	if (res.status !== 200) throw new Error(`LFS batch ${operation} failed: HTTP ${res.status}`);
	if (res.error) throw new Error(`LFS batch ${operation} failed: object error ${res.error.code}: ${res.error.message}`);
	return res;
}

/** Batch upload → PUT (skipped when GitHub already has the object) → verify (when requested). Throws an Error with a clear message on any failure. */
export async function uploadLfsObject(lfs: LfsClient, put: Uploader, data: ArrayBuffer, oid: string): Promise<void> {
	const size = data.byteLength;
	const { actions } = await batchOrThrow(lfs, "upload", oid, size);
	if (actions.upload) {
		const status = await put(actions.upload, data);
		if (!is2xx(status)) throw new Error(`LFS upload failed: HTTP ${status}`);
	}
	if (actions.verify) {
		const status = await lfs.verify(actions.verify, oid, size);
		if (!is2xx(status)) throw new Error(`LFS verify failed: HTTP ${status}`);
	}
}

const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Batch download → ranged GETs of chunkBytes (default 8 MiB) → concatenate → SHA-256 must equal oid and length must equal size. Throws on any failure. */
export async function downloadLfsObject(
	lfs: LfsClient,
	oid: string,
	size: number,
	chunkBytes = DOWNLOAD_CHUNK_BYTES,
): Promise<ArrayBuffer> {
	// One copy of the file plus one chunk in memory.
	const out = new Uint8Array(size);
	if (size > 0) {
		const { actions } = await batchOrThrow(lfs, "download", oid, size);
		if (!actions.download) throw new Error("LFS batch download failed: no download action");
		for (let start = 0; start < size; start += chunkBytes) {
			const end = Math.min(start + chunkBytes, size) - 1;
			const res = await lfs.readRange(actions.download, start, end);
			const got = res.data.byteLength;
			// A server that ignores Range sends the whole file once, on the first request.
			if (res.status === 200 && start === 0 && got === size) {
				out.set(new Uint8Array(res.data));
				break;
			}
			if (res.status !== 206 || got !== end - start + 1) {
				throw new Error(`LFS download range ${start}-${end}: HTTP ${res.status} with ${got} bytes, expected ${end - start + 1}`);
			}
			out.set(new Uint8Array(res.data), start);
		}
	}
	const hash = await sha256Hex(out.buffer as ArrayBuffer);
	if (hash !== oid) throw new Error(`LFS download: SHA-256 mismatch (got ${hash.slice(0, 12)}…, expected ${oid.slice(0, 12)}…)`);
	return out.buffer as ArrayBuffer;
}
