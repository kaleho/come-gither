import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubError } from "../src/github";
import {
	LFS_TEST_BRANCH,
	LfsClient,
	type LfsTestDeps,
	type Uploader,
	gitattributesLine,
	httpUploader,
	lfsPointer,
	lfsTestSummary,
	parseLfsPointer,
	runLfsTest,
	sha256Hex,
} from "../src/lfs";
import { FakeGitHub, FakeHttp, binaryResponse, jsonResponse } from "./fakes";

const BATCH = "https://github.com/kaleho/vault.git/info/lfs/objects/batch";
const LFS_TYPE = "application/vnd.git-lfs+json";
const MIB = 1024 * 1024;

function bytes(n: number, seed = 0): Uint8Array {
	return Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function makeLfs(http: FakeHttp): LfsClient {
	return new LfsClient(http, { owner: "kaleho", repo: "vault", token: "tok123" });
}

const UPLOAD = { href: "https://s3.example/up", header: { Authorization: "AWS4 up-sig" } };
const VERIFY = { href: "https://lfs.github.com/kaleho/vault/verify", header: { Authorization: "RemoteAuth v" } };
const DOWNLOAD = { href: "https://s3.example/down", header: { "X-Sig": "d" } };

describe("lfsPointer", () => {
	it("writes the v1 pointer with LF endings and a trailing newline", () => {
		const oid = "a".repeat(64);
		expect(lfsPointer(oid, 123)).toBe(
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n`,
		);
	});
});

describe("parseLfsPointer", () => {
	const enc = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer;
	const oid = "0123456789abcdef".repeat(4);

	it("reads oid and size from a v1 pointer", () => {
		expect(parseLfsPointer(enc(lfsPointer(oid, 120087058)))).toEqual({ oid, size: 120087058 });
	});

	it("accepts extra keys between version and oid, as the spec allows", () => {
		const text = `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${"1".repeat(64)}\noid sha256:${oid}\nsize 5\n`;
		expect(parseLfsPointer(enc(text))).toEqual({ oid, size: 5 });
	});

	it("rejects anything that is not a v1 pointer", () => {
		const cases = [
			"hello world",
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`, // no size
			`version https://git-lfs.github.com/spec/v1\nsize 5\n`, // no oid
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.toUpperCase()}\nsize 5\n`, // uppercase hex
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -1\n`,
			`version https://git-lfs.github.com/spec/v1\r\noid sha256:${oid}\r\nsize 5\r\n`, // CRLF
			`version https://example.com/v2\noid sha256:${oid}\nsize 5\n`,
		];
		for (const c of cases) expect(parseLfsPointer(enc(c)), c).toBeNull();
	});

	it("rejects data of 1024 bytes or more without decoding it", () => {
		const big = new Uint8Array(1024);
		big.set(new TextEncoder().encode(lfsPointer(oid, 5)));
		expect(parseLfsPointer(big.buffer as ArrayBuffer)).toBeNull();
	});
});

describe("sha256Hex", () => {
	it("matches the known vector for 'abc'", async () => {
		const data = new TextEncoder().encode("abc").buffer as ArrayBuffer;
		expect(await sha256Hex(data)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("gitattributesLine", () => {
	it("anchors the exact path and marks it for LFS", () => {
		expect(gitattributesLine("big.mp4")).toBe("/big.mp4 filter=lfs diff=lfs merge=lfs -text");
	});

	it("escapes spaces as [[:space:]] and glob characters with a backslash", () => {
		expect(gitattributesLine("My Videos/a\tb*c?[d]\\e.bin")).toBe(
			"/My[[:space:]]Videos/a[[:space:]]b\\*c\\?\\[d]\\\\e.bin filter=lfs diff=lfs merge=lfs -text",
		);
	});
});

describe("LfsClient", () => {
	it("batch posts the LFS JSON body with Basic token auth and returns the actions", async () => {
		const http = new FakeHttp();
		http.on(
			"POST",
			BATCH,
			jsonResponse({ objects: [{ oid: "o1", size: 5, actions: { upload: UPLOAD, verify: { href: VERIFY.href } } }] }),
		);
		const result = await makeLfs(http).batch("upload", "o1", 5);
		const req = http.requests[0];
		expect(req.url).toBe(BATCH);
		expect(req.method).toBe("POST");
		expect(req.throw).toBe(false);
		expect(req.headers).toEqual({
			Accept: LFS_TYPE,
			"Content-Type": LFS_TYPE,
			Authorization: `Basic ${btoa("x-access-token:tok123")}`,
		});
		expect(http.bodyOf(0)).toEqual({
			operation: "upload",
			transfers: ["basic"],
			objects: [{ oid: "o1", size: 5 }],
			hash_algo: "sha256",
		});
		expect(result).toEqual({ status: 200, actions: { upload: UPLOAD, verify: { href: VERIFY.href, header: {} } } });
	});

	it("batch carries a per-object error", async () => {
		const http = new FakeHttp();
		http.on("POST", BATCH, jsonResponse({ objects: [{ oid: "o1", size: 5, error: { code: 404, message: "Object does not exist" } }] }));
		const result = await makeLfs(http).batch("download", "o1", 5);
		expect(http.bodyOf(0).operation).toBe("download");
		expect(result).toEqual({ status: 200, actions: {}, error: { code: 404, message: "Object does not exist" } });
	});

	it("batch returns a failing status without throwing or parsing the body", async () => {
		const http = new FakeHttp();
		http.on("POST", BATCH, { status: 401, text: "<html>no</html>" });
		expect(await makeLfs(http).batch("upload", "o1", 5)).toEqual({ status: 401, actions: {} });
	});

	it("verify posts oid and size with the action header only, and returns the status", async () => {
		const http = new FakeHttp();
		http.on("POST", VERIFY.href, { status: 200 });
		const status = await makeLfs(http).verify(VERIFY, "o1", 5);
		expect(status).toBe(200);
		const req = http.requests[0];
		expect(req.headers).toEqual({ Authorization: "RemoteAuth v", Accept: LFS_TYPE, "Content-Type": LFS_TYPE });
		expect(req.throw).toBe(false);
		expect(http.bodyOf(0)).toEqual({ oid: "o1", size: 5 });
	});

	it("readRange sends an inclusive Range header and returns status and bytes", async () => {
		const http = new FakeHttp();
		http.on("GET", DOWNLOAD.href, binaryResponse(new Uint8Array([7, 8]), 206));
		const res = await makeLfs(http).readRange(DOWNLOAD, 0, 1);
		expect(http.requests[0].headers).toEqual({ "X-Sig": "d", Range: "bytes=0-1" });
		expect(http.requests[0].throw).toBe(false);
		expect(res.status).toBe(206);
		expect(new Uint8Array(res.data)).toEqual(new Uint8Array([7, 8]));
	});
});

describe("httpUploader", () => {
	it("PUTs the whole body with only the action header (no GitHub token)", async () => {
		const http = new FakeHttp();
		http.on("PUT", UPLOAD.href, { status: 200 });
		const data = bytes(4).buffer as ArrayBuffer;
		expect(await httpUploader(http)(UPLOAD, data)).toBe(200);
		const req = http.requests[0];
		expect(req.headers).toEqual({ Authorization: "AWS4 up-sig" });
		expect(req.body).toBe(data);
		expect(req.throw).toBe(false);
	});
});

interface Scenario {
	data?: Uint8Array;
	uploadBatch?: Partial<import("../src/ports").HttpResponse>;
	verifyStatus?: number;
	downloadBatch?: Partial<import("../src/ports").HttpResponse>;
	rangeBody?: Uint8Array;
	uploaders?: { name: string; put: Uploader }[];
}

async function scenario(s: Scenario = {}) {
	const data = s.data ?? bytes(10);
	const oid = sha256(data);
	const http = new FakeHttp();
	http.on(
		"POST",
		BATCH,
		s.uploadBatch ?? jsonResponse({ objects: [{ oid, size: data.length, actions: { upload: UPLOAD, verify: VERIFY } }] }),
		1,
	);
	http.on(
		"POST",
		BATCH,
		s.downloadBatch ?? jsonResponse({ objects: [{ oid, size: data.length, actions: { download: DOWNLOAD } }] }),
		1,
	);
	http.on("POST", VERIFY.href, { status: s.verifyStatus ?? 200 });
	http.on("GET", DOWNLOAD.href, binaryResponse(s.rangeBody ?? data.slice(0, MIB), 206));
	const gh = new FakeGitHub();
	await gh.setFiles({ "note.md": "hi" });
	const log: string[] = [];
	let t = 0;
	const deps: LfsTestDeps = {
		lfs: makeLfs(http),
		gh,
		baseBranch: "main",
		uploaders: s.uploaders ?? [
			{
				name: "fetch",
				put: async () => {
					log.push("put:fetch");
					return 200;
				},
			},
		],
		checkpoint: async (m) => {
			log.push(m);
		},
		now: () => (t += 21),
	};
	return { data, oid, http, gh, log, deps };
}

function byStep(results: { step: string; ok: boolean; detail: string }[]) {
	return Object.fromEntries(results.map((r) => [r.step, r]));
}

const STEPS = ["hash", "batch upload", "upload", "verify", "pointer commit", "download check", "cleanup"];

describe("runLfsTest", () => {
	it("passes every step on the happy path, checkpointing before each one", async () => {
		const { data, oid, log, deps, gh } = await scenario();
		const results = await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer);
		expect(results.map((r) => r.step)).toEqual(STEPS);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(log.filter((l) => l !== "put:fetch")).toEqual(STEPS.map((s) => `LFS test: ${s}`));
		expect(log.indexOf("put:fetch")).toBe(log.indexOf("LFS test: upload") + 1);
		const r = byStep(results);
		expect(r.hash.detail).toContain(oid.slice(0, 12));
		expect(r.hash.detail).toContain("21 ms");
		expect(gh.refs.size).toBe(0);
	});

	it("reports an already-stored object and skips the uploaders", async () => {
		const put = vi.fn(async () => 200);
		const data = bytes(10);
		const { deps } = await scenario({
			data,
			uploadBatch: jsonResponse({ objects: [{ oid: sha256(data), size: 10 }] }),
			uploaders: [{ name: "fetch", put }],
		});
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r.upload).toEqual({ step: "upload", ok: true, detail: "already on GitHub" });
		expect(r.verify).toEqual({ step: "verify", ok: true, detail: "no verify requested" });
		expect(put).not.toHaveBeenCalled();
		expect(r["download check"].ok).toBe(true);
	});

	it("falls back to the next uploader when the first throws, and stops at the first 2xx", async () => {
		const third = vi.fn(async () => 200);
		const { deps, data } = await scenario({
			uploaders: [
				{ name: "fetch", put: async () => Promise.reject(new TypeError("Failed to fetch")) },
				{ name: "requestUrl", put: async () => 200 },
				{ name: "spare", put: third },
			],
		});
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r.upload.ok).toBe(true);
		expect(r.upload.detail).toContain("fetch: Failed to fetch");
		expect(r.upload.detail).toContain("requestUrl: 200");
		expect(third).not.toHaveBeenCalled();
	});

	it("fails the upload when every uploader fails and skips the dependent steps", async () => {
		const { deps, data, gh } = await scenario({
			uploaders: [
				{ name: "fetch", put: async () => Promise.reject("CORS") },
				{ name: "requestUrl", put: async () => 403 },
			],
		});
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r.upload.ok).toBe(false);
		expect(r.upload.detail).toContain("fetch: CORS");
		expect(r.upload.detail).toContain("requestUrl: 403");
		for (const s of ["verify", "pointer commit", "download check", "cleanup"]) {
			expect(r[s].ok).toBe(false);
			expect(r[s].detail).toMatch(/^skipped: /);
		}
		expect(gh.pushedTrees).toEqual([]);
	});

	it("fails verify on a non-2xx status", async () => {
		const { deps, data } = await scenario({ verifyStatus: 500 });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r.verify.ok).toBe(false);
		expect(r.verify.detail).toContain("500");
		expect(r["pointer commit"].detail).toMatch(/^skipped: /);
	});

	it("commits .gitattributes and the pointer on the test branch, parented on the base head", async () => {
		const { deps, data, oid, gh } = await scenario();
		const head = gh.head;
		const createRef = vi.spyOn(gh, "createRef");
		const path = "Large Files/my video.mp4";
		const r = byStep(await runLfsTest(deps, path, data.buffer as ArrayBuffer));
		expect(r["pointer commit"].ok).toBe(true);
		const tree = gh.pushedTrees[0];
		expect(tree.baseTree).toBe(`tree-of-${head}`);
		const blob = (p: string) => {
			const e = tree.entries.find((x) => x.path === p);
			expect(e?.mode).toBe("100644");
			return new TextDecoder().decode(gh.createdBlobs.get(e?.sha as string));
		};
		expect(blob(".gitattributes")).toBe(
			"/Large[[:space:]]Files/my[[:space:]]video.mp4 filter=lfs diff=lfs merge=lfs -text\n",
		);
		expect(blob(path)).toBe(lfsPointer(oid, 10));
		const [branch, sha] = createRef.mock.calls[0];
		expect(branch).toBe(LFS_TEST_BRANCH);
		expect(gh.pushedCommits.get(sha)?.parents).toEqual([head]);
		expect(gh.head).toBe(head); // the sync branch never moves
	});

	it("replaces a test branch left over from a crashed run", async () => {
		const { deps, data, gh } = await scenario();
		gh.refs.set(LFS_TEST_BRANCH, "stale");
		const createRef = vi.spyOn(gh, "createRef");
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["pointer commit"].ok).toBe(true);
		expect(r["pointer commit"].detail).toContain("replaced");
		expect(createRef).toHaveBeenCalledTimes(2);
		expect(r.cleanup.ok).toBe(true);
		expect(gh.refs.size).toBe(0);
	});

	it("reports a pointer commit failure, still checks the download, and skips cleanup", async () => {
		const { deps, data, gh } = await scenario();
		gh.failCreateRef = new GitHubError(403, "auth", "GitHub 403 on /git/refs: no");
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["pointer commit"]).toEqual({ step: "pointer commit", ok: false, detail: "GitHub 403 on /git/refs: no" });
		expect(r["download check"].ok).toBe(true);
		expect(r.cleanup.detail).toMatch(/^skipped: /);
	});

	it("reads at most the first MiB and reports a match", async () => {
		const data = bytes(MIB + MIB / 2);
		const { deps, http } = await scenario({ data });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		const range = http.requests.find((q) => q.url === DOWNLOAD.href);
		expect(range?.headers?.Range).toBe(`bytes=0-${MIB - 1}`);
		expect(r["download check"].ok).toBe(true);
		expect(r["download check"].detail).toContain("206");
		expect(r["download check"].detail).toContain("match");
	});

	it("reports a mismatch and still cleans up", async () => {
		const { deps, data, gh } = await scenario({ rangeBody: bytes(10, 1) });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["download check"].ok).toBe(false);
		expect(r["download check"].detail).toContain("mismatch");
		expect(r.cleanup.ok).toBe(true);
		expect(gh.refs.size).toBe(0);
	});

	it("reports a short range body as a mismatch", async () => {
		const { deps, data } = await scenario({ rangeBody: bytes(5) });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["download check"].detail).toContain("mismatch");
	});

	it("fails the download check when no download action comes back, and still cleans up", async () => {
		const { deps, data, gh } = await scenario({
			downloadBatch: jsonResponse({ objects: [{ oid: "x", size: 10, error: { code: 404, message: "Object does not exist" } }] }),
		});
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["download check"].ok).toBe(false);
		expect(r["download check"].detail).toContain("Object does not exist");
		expect(r.cleanup.ok).toBe(true);
		expect(gh.refs.size).toBe(0);
	});

	it("fails the download check on a non-200 download batch", async () => {
		const { deps, data } = await scenario({ downloadBatch: { status: 500 } });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["download check"].ok).toBe(false);
		expect(r["download check"].detail).toContain("500");
	});

	it("reports a cleanup failure", async () => {
		const { deps, data, gh } = await scenario();
		gh.failDeleteRef = new GitHubError(403, "auth", "GitHub 403 on delete");
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r.cleanup).toEqual({ step: "cleanup", ok: false, detail: "GitHub 403 on delete" });
	});

	it("explains a 401 batch as a token without LFS access and skips every later step", async () => {
		const put = vi.fn(async () => 200);
		const { deps, data, gh } = await scenario({ uploadBatch: { status: 401 }, uploaders: [{ name: "fetch", put }] });
		const results = await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer);
		const r = byStep(results);
		expect(r["batch upload"].ok).toBe(false);
		expect(r["batch upload"].detail).toContain("401");
		expect(r["batch upload"].detail).toContain("cannot use LFS");
		for (const s of STEPS.slice(2)) expect(r[s].detail).toMatch(/^skipped: /);
		expect(put).not.toHaveBeenCalled();
		expect(gh.pushedTrees).toEqual([]);
		expect(results.map((x) => x.step)).toEqual(STEPS);
	});

	it("reports other batch failures without blaming the token", async () => {
		const { deps, data } = await scenario({ uploadBatch: { status: 500 } });
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["batch upload"]).toEqual({ step: "batch upload", ok: false, detail: "HTTP 500" });
	});

	it("fails the batch step on a per-object error", async () => {
		const { deps, data } = await scenario({
			uploadBatch: jsonResponse({ objects: [{ oid: "x", size: 10, error: { code: 422, message: "bad oid" } }] }),
		});
		const r = byStep(await runLfsTest(deps, "big.bin", data.buffer as ArrayBuffer));
		expect(r["batch upload"].ok).toBe(false);
		expect(r["batch upload"].detail).toContain("bad oid");
	});

	it("skips everything after a failed hash", async () => {
		const { deps } = await scenario();
		const results = await runLfsTest(deps, "big.bin", "not a buffer" as unknown as ArrayBuffer);
		expect(results[0].ok).toBe(false);
		for (const r of results.slice(1)) expect(r.detail).toMatch(/^skipped: /);
	});
});

describe("lfsTestSummary", () => {
	it("counts passed steps and marks each line", () => {
		expect(
			lfsTestSummary([
				{ step: "hash", ok: true, detail: "oid 1a2b…, 812 ms" },
				{ step: "upload", ok: false, detail: "fetch: TypeError: Failed to fetch; requestUrl: 500" },
			]),
		).toEqual({
			passed: 1,
			total: 2,
			lines: ["✓ hash — oid 1a2b…, 812 ms", "✗ upload — fetch: TypeError: Failed to fetch; requestUrl: 500"],
		});
	});

	it("handles no steps", () => {
		expect(lfsTestSummary([])).toEqual({ passed: 0, total: 0, lines: [] });
	});
});
