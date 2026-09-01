import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError } from "../src/github";
import { FakeClock, FakeHttp, binaryResponse, jsonResponse } from "./fakes";

function makeClient(http: FakeHttp, clock = new FakeClock()) {
	return new GitHubClient(http, {
		owner: "kaleho",
		repo: "vault",
		token: "tok123",
		sleep: clock.sleep,
		now: clock.now,
	});
}

describe("GitHubClient reads", () => {
	it("getRef fetches the branch head sha with auth and version headers", async () => {
		const http = new FakeHttp();
		http.on("GET", "/repos/kaleho/vault/git/ref/heads/master", jsonResponse({ object: { sha: "abc" } }));
		const sha = await makeClient(http).getRef("master");
		expect(sha).toBe("abc");
		const req = http.requests[0];
		expect(req.url).toBe("https://api.github.com/repos/kaleho/vault/git/ref/heads/master");
		expect(req.headers?.["Authorization"]).toBe("Bearer tok123");
		expect(req.headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
	});

	it("getCommit returns the tree sha and parents", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/commits/abc", jsonResponse({ tree: { sha: "t1" }, parents: [{ sha: "p1" }] }));
		const commit = await makeClient(http).getCommit("abc");
		expect(commit).toEqual({ treeSha: "t1", parents: ["p1"] });
	});

	it("getTree passes recursive=1 and returns entries with the truncated flag", async () => {
		const http = new FakeHttp();
		http.on(
			"GET",
			"/git/trees/t1",
			jsonResponse({
				truncated: false,
				tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "s1", size: 5 }],
			}),
		);
		const tree = await makeClient(http).getTree("t1", true);
		expect(http.requests[0].url).toContain("/git/trees/t1?recursive=1");
		expect(tree.truncated).toBe(false);
		expect(tree.entries).toEqual([{ path: "a.md", mode: "100644", type: "blob", sha: "s1", size: 5 }]);
	});

	it("getTree omits recursive when not asked", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/trees/t1", jsonResponse({ truncated: false, tree: [] }));
		await makeClient(http).getTree("t1", false);
		expect(http.requests[0].url).not.toContain("recursive");
	});

	it("getBlobRaw requests the raw media type and returns the bytes", async () => {
		const http = new FakeHttp();
		const bytes = new Uint8Array([1, 2, 3]);
		http.on("GET", "/git/blobs/s1", binaryResponse(bytes));
		const buf = await makeClient(http).getBlobRaw("s1");
		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(http.requests[0].headers?.["Accept"]).toBe("application/vnd.github.raw+json");
	});
});

describe("GitHubClient writes", () => {
	it("createBlob posts base64 content and returns the sha (binary roundtrip)", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/blobs", jsonResponse({ sha: "b1" }, 201));
		const data = new Uint8Array(256).map((_, i) => i);
		const sha = await makeClient(http).createBlob(data.buffer as ArrayBuffer);
		expect(sha).toBe("b1");
		const body = http.bodyOf(0);
		expect(body.encoding).toBe("base64");
		const decoded = Uint8Array.from(atob(body.content as string), (c) => c.charCodeAt(0));
		expect(decoded).toEqual(data);
	});

	it("createTree posts base_tree and entries, mapping deletions to sha null", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/trees", jsonResponse({ sha: "t2" }, 201));
		const sha = await makeClient(http).createTree("t1", [
			{ path: "a.md", mode: "100644", type: "blob", sha: "b1" },
			{ path: "gone.md", mode: "100644", type: "blob", sha: null },
		]);
		expect(sha).toBe("t2");
		const body = http.bodyOf(0);
		expect(body.base_tree).toBe("t1");
		expect(body.tree).toEqual([
			{ path: "a.md", mode: "100644", type: "blob", sha: "b1" },
			{ path: "gone.md", mode: "100644", type: "blob", sha: null },
		]);
	});

	it("createCommit posts message, tree, and parents", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/commits", jsonResponse({ sha: "c2" }, 201));
		const sha = await makeClient(http).createCommit("msg", "t2", ["c1"]);
		expect(sha).toBe("c2");
		expect(http.bodyOf(0)).toEqual({ message: "msg", tree: "t2", parents: ["c1"] });
	});

	it("updateRef patches the branch ref without force", async () => {
		const http = new FakeHttp();
		http.on("PATCH", "/git/refs/heads/master", jsonResponse({}, 200));
		await makeClient(http).updateRef("master", "c2");
		const body = http.bodyOf(0);
		expect(body).toEqual({ sha: "c2", force: false });
	});

	it("caps the write throttle when the clock steps backwards", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/blobs", jsonResponse({ sha: "b" }, 201));
		const clock = new FakeClock();
		const client = makeClient(http, clock);
		await client.createBlob(new ArrayBuffer(1));
		clock.t -= 60_000; // an NTP step back must not stall the push silently
		await client.createBlob(new ArrayBuffer(1));
		expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(1000);
	});

	it("throttles consecutive createBlob calls to one per second", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/blobs", jsonResponse({ sha: "b" }, 201));
		const clock = new FakeClock();
		const client = makeClient(http, clock);
		await client.createBlob(new ArrayBuffer(1));
		await client.createBlob(new ArrayBuffer(1));
		expect(clock.sleeps).toContain(1000);
	});
});

describe("GitHubClient errors", () => {
	it("maps 401 to an auth error", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/ref/", jsonResponse({ message: "Bad credentials" }, 401));
		const err = await makeClient(http).getRef("master").catch((e) => e);
		expect(err).toBeInstanceOf(GitHubError);
		expect(err.kind).toBe("auth");
		expect(err.status).toBe(401);
	});

	it("maps 404 to not-found", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/ref/", jsonResponse({ message: "Not Found" }, 404));
		const err = await makeClient(http).getRef("master").catch((e) => e);
		expect(err.kind).toBe("not-found");
	});

	it("maps 422 on updateRef to not-fast-forward", async () => {
		const http = new FakeHttp();
		http.on("PATCH", "/git/refs/heads/master", jsonResponse({ message: "Update is not a fast forward" }, 422));
		const err = await makeClient(http).updateRef("master", "c2").catch((e) => e);
		expect(err.kind).toBe("not-fast-forward");
	});

	it("retries after retry-after on 403 rate limiting, then succeeds", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		http.on(
			"GET",
			"/git/ref/",
			jsonResponse({ message: "rate limited" }, 403, { "retry-after": "2", "x-ratelimit-remaining": "0" }),
			1,
		);
		http.on("GET", "/git/ref/", jsonResponse({ object: { sha: "abc" } }));
		const sha = await makeClient(http, clock).getRef("master");
		expect(sha).toBe("abc");
		expect(clock.sleeps).toContain(2000);
		expect(http.requests.length).toBe(2);
	});

	it("gives up after three rate-limited attempts", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		http.on("GET", "/git/ref/", jsonResponse({ message: "rate limited" }, 429, { "retry-after": "1" }));
		const err = await makeClient(http, clock).getRef("master").catch((e) => e);
		expect(err.kind).toBe("rate-limited");
		expect(http.requests.length).toBe(3);
	});

	it("gives up at once when the required wait exceeds the cap, naming the wait", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		http.on(
			"GET",
			"/git/ref/",
			jsonResponse({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }),
		);
		const err = await makeClient(http, clock).getRef("master").catch((e) => e);
		expect(err.kind).toBe("rate-limited");
		expect(clock.sleeps).toEqual([]);
		expect(http.requests.length).toBe(1);
		expect(err.message).toContain("try again in ~3600s");
	});

	it("logs each rate-limit wait with the attempt number", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		const logs: string[] = [];
		http.on(
			"GET",
			"/git/ref/",
			jsonResponse({ message: "rate limited" }, 403, { "retry-after": "2", "x-ratelimit-remaining": "0" }),
			1,
		);
		http.on("GET", "/git/ref/", jsonResponse({ object: { sha: "abc" } }));
		const client = new GitHubClient(http, {
			owner: "kaleho",
			repo: "vault",
			token: "tok123",
			sleep: clock.sleep,
			now: clock.now,
			log: (_level, message) => logs.push(message),
		});
		await client.getRef("master");
		expect(logs.some((m) => m.includes("waiting 2s") && m.includes("attempt 1/3"))).toBe(true);
	});

	it("maps plain 403 without rate-limit headers to auth", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/ref/", jsonResponse({ message: "Forbidden" }, 403));
		const err = await makeClient(http).getRef("master").catch((e) => e);
		expect(err.kind).toBe("auth");
	});

	it("waits until x-ratelimit-reset when there is no retry-after", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		http.on(
			"GET",
			"/git/ref/",
			jsonResponse({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5" }),
			1,
		);
		http.on("GET", "/git/ref/", jsonResponse({ object: { sha: "abc" } }));
		await makeClient(http, clock).getRef("master");
		expect(clock.sleeps).toContain(5000);
	});

	it("falls back to a one second delay on 429 without headers", async () => {
		const http = new FakeHttp();
		const clock = new FakeClock();
		http.on("GET", "/git/ref/", jsonResponse({ message: "slow down" }, 429), 1);
		http.on("GET", "/git/ref/", jsonResponse({ object: { sha: "abc" } }));
		await makeClient(http, clock).getRef("master");
		expect(clock.sleeps).toContain(1000);
	});

	it("keeps the generic message when the error body is not JSON", async () => {
		const http = new FakeHttp();
		http.on("GET", "/git/ref/", { status: 500, text: "<html>oops</html>" });
		const err = await makeClient(http).getRef("master").catch((e) => e);
		expect(err.kind).toBe("other");
		expect(err.message).toBe("GitHub 500 on /git/ref/heads/master");
	});

	it("maps 413 to too-large", async () => {
		const http = new FakeHttp();
		http.on("POST", "/git/blobs", jsonResponse({ message: "too big" }, 413));
		const err = await makeClient(http).createBlob(new ArrayBuffer(1)).catch((e) => e);
		expect(err.kind).toBe("too-large");
	});

	it("uses the real clock when no clock is injected", async () => {
		vi.useFakeTimers();
		try {
			const http = new FakeHttp();
			http.on("POST", "/git/blobs", jsonResponse({ sha: "b" }, 201));
			const client = new GitHubClient(http, {
				owner: "kaleho",
				repo: "vault",
				token: "tok123",
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			});
			await client.createBlob(new ArrayBuffer(1));
			const second = client.createBlob(new ArrayBuffer(1));
			await vi.advanceTimersByTimeAsync(1000);
			await second;
			expect(http.requests.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
