import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_EXTENSIONS, SyncEngine } from "../src/sync";
import { StateStore } from "../src/state";
import { FakeGitHub, MemFiles, gitSha } from "./fakes";

const STATE_PATH = ".obsidian/plugins/come-gither/sync-state.json";

function makeEngine(
	overrides: { maxAutoFetchBytes?: number; maxPushBytes?: number; conflictPolicy?: "merge" | "remote-wins" } = {},
) {
	const gh = new FakeGitHub();
	const files = new MemFiles();
	const state = new StateStore(files, STATE_PATH);
	const logs: string[] = [];
	const engine = new SyncEngine(gh, files, state, (level, msg) => logs.push(`${level}: ${msg}`), {
		branch: "master",
		textExtensions: DEFAULT_TEXT_EXTENSIONS,
		maxAutoFetchBytes: overrides.maxAutoFetchBytes ?? 100 * 1048576,
		maxPushBytes: overrides.maxPushBytes ?? 30 * 1048576,
		conflictPolicy: overrides.conflictPolicy ?? "merge",
	});
	return { gh, files, state, engine, logs };
}

const text = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("pull: initial", () => {
	it("fetches text files and writes lazy placeholders for binaries", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "notes/a.md": "hello", "docs/big.pdf": new Uint8Array([1, 2, 3, 4]) });
		const summary = await engine.pull();
		expect(summary).toMatchObject({ upToDate: false, fetched: 1, placeholders: 1 });
		expect(files.readText("notes/a.md")).toBe("hello");
		expect((await files.stat("docs/big.pdf"))?.size).toBe(0);
		expect(state.state.files["notes/a.md"].lazy).toBeUndefined();
		expect(state.state.files["docs/big.pdf"].lazy).toBe(true);
		expect(state.state.files["docs/big.pdf"].baseBlobSha).toBe(await gitSha(new Uint8Array([1, 2, 3, 4])));
		expect(state.state.lastSyncedCommit).toBe(gh.head);
	});

	it("fetches .obsidian files fully even with binary extensions", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ ".obsidian/plugins/annotator/main.png": new Uint8Array([9, 9]) });
		const summary = await engine.pull();
		expect(summary.fetched).toBe(1);
		expect(summary.placeholders).toBe(0);
		expect((await files.stat(".obsidian/plugins/annotator/main.png"))?.size).toBe(2);
	});

	it("makes a placeholder for a text file over the size cap", async () => {
		const { gh, files, engine } = makeEngine({ maxAutoFetchBytes: 3 });
		await gh.setFiles({ "big.md": "way too large" });
		const summary = await engine.pull();
		expect(summary.placeholders).toBe(1);
		expect((await files.stat("big.md"))?.size).toBe(0);
	});

	it("never touches _conflicts/ or its own plugin folder on the remote", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({
			"_conflicts/a.md": "x",
			".obsidian/plugins/come-gither/data.json": "{token}",
			"ok.md": "y",
		});
		const summary = await engine.pull();
		expect(summary.fetched).toBe(1);
		expect(await files.stat("_conflicts/a.md")).toBeNull();
		expect(await files.stat(".obsidian/plugins/come-gither/data.json")).toBeNull();
		expect(state.state.files["_conflicts/a.md"]).toBeUndefined();
	});

	it("adopts an untracked local file that matches the remote content without fetching", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "same.md": "identical" });
		await files.writeBinary("same.md", new TextEncoder().encode("identical").buffer as ArrayBuffer);
		const summary = await engine.pull();
		expect(summary.adopted).toBe(1);
		expect(summary.fetched).toBe(0);
		expect(gh.blobFetches).toEqual([]);
		expect(state.state.files["same.md"].baseBlobSha).toBe(await gitSha("identical"));
	});
});

describe("pull: incremental", () => {
	it("is a no-op when the head commit has not moved", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const before = gh.treeFetches.length;
		const summary = await engine.pull();
		expect(summary.upToDate).toBe(true);
		expect(gh.treeFetches.length).toBe(before);
	});

	it("refetches only remotely changed files", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		gh.blobFetches.length = 0;
		await gh.setFiles({ "a.md": "one", "b.md": "TWO" });
		const summary = await engine.pull();
		expect(summary.fetched).toBe(1);
		expect(gh.blobFetches).toEqual([await gitSha("TWO")]);
		expect(files.readText("b.md")).toBe("TWO");
	});

	it("deletes locally what was deleted remotely when the local copy is clean", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await gh.setFiles({ "a.md": "one" });
		const summary = await engine.pull();
		expect(summary.deleted).toBe(1);
		expect(await files.stat("b.md")).toBeNull();
		expect(state.state.files["b.md"]).toBeUndefined();
	});

	it("keeps a locally changed file that was deleted remotely", async () => {
		const { gh, files, state, engine, logs } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await files.writeBinary("b.md", new TextEncoder().encode("edited").buffer as ArrayBuffer);
		await gh.setFiles({ "a.md": "one" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(files.readText("b.md")).toBe("edited");
		expect(state.state.files["b.md"]).toBeDefined();
		expect(logs.some((l) => l.includes("b.md"))).toBe(true);
	});

	it("counts a conflict when a file was deleted locally but changed remotely", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.remove("a.md");
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(await files.stat("a.md")).toBeNull();
		expect(files.readText("_conflicts/a.md")).toBe("remote edit");
	});

	it("treats an extensionless file as binary and makes a placeholder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ LICENSE: "MIT..." });
		const summary = await engine.pull();
		expect(summary.placeholders).toBe(1);
		expect((await files.stat("LICENSE"))?.size).toBe(0);
	});

	it("keeps the local side and saves the remote copy when text edits overlap", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", new TextEncoder().encode("local edit").buffer as ArrayBuffer);
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(files.readText("a.md")).toBe("local edit");
		expect(files.readText("_conflicts/a.md")).toBe("remote edit");
	});

	it("takes the remote side for a both-changed file under .obsidian/", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ ".obsidian/app.json": "{}" });
		await engine.pull();
		await files.writeBinary(".obsidian/app.json", new TextEncoder().encode("{local}").buffer as ArrayBuffer);
		await gh.setFiles({ ".obsidian/app.json": "{remote}" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText(".obsidian/app.json")).toBe("{remote}");
	});

	it("treats a touched-but-identical local file as clean and refreshes its fingerprint", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", new TextEncoder().encode("base").buffer as ArrayBuffer);
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(summary.fetched).toBe(1);
		expect(files.readText("a.md")).toBe("remote edit");
	});
});

describe("pull: resumability and truncation", () => {
	it("resumes an interrupted pull without refetching applied files", async () => {
		const { gh, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two", "c.md": "three" });
		gh.failNextBlobFetches = 0;
		// First attempt: let one blob fetch fail mid-pull.
		gh.failNextBlobFetches = 0;
		const firstShas = gh.blobFetches;
		gh.failNextBlobFetches = 1;
		// The first fetch fails, so at most the later files land.
		await expect(engine.pull()).rejects.toThrow("network dropped");
		expect(state.state.lastSyncedCommit).toBeNull();
		const applied = Object.keys(state.state.files).length;
		expect(applied).toBeLessThan(3);
		firstShas.length = 0;
		const summary = await engine.pull();
		expect(state.state.lastSyncedCommit).toBe(gh.head);
		expect(Object.keys(state.state.files).length).toBe(3);
		expect(summary.fetched).toBe(3 - applied);
		expect(gh.blobFetches.length).toBe(3 - applied);
	});

	it("falls back to walking subtrees when the recursive listing truncates", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "deep/nested/b.md": "two" });
		gh.truncateRecursive = true;
		const summary = await engine.pull();
		expect(summary.fetched).toBe(2);
		expect(files.readText("deep/nested/b.md")).toBe("two");
	});
});

describe("push", () => {
	it("does nothing when there are no local changes", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const summary = await engine.push();
		expect(summary).toEqual({ pushed: 0, deletedRemote: 0, skipped: 0, commit: null });
		expect(gh.pushedTrees).toEqual([]);
	});

	it("pushes a new local file as blob, tree, commit, and ref update", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const base = gh.head;
		await files.writeBinary("new.md", text("fresh"));
		const summary = await engine.push();
		expect(summary.pushed).toBe(1);
		const sha = await gitSha("fresh");
		expect(gh.createdBlobs.has(sha)).toBe(true);
		expect(gh.pushedTrees[0].entries).toEqual([{ path: "new.md", mode: "100644", type: "blob", sha }]);
		const commit = gh.pushedCommits.get(summary.commit as string);
		expect(commit?.parents).toEqual([base]);
		expect(gh.head).toBe(summary.commit);
		expect(state.state.lastSyncedCommit).toBe(summary.commit);
		expect(state.state.files["new.md"].baseBlobSha).toBe(sha);
	});

	it("pushes only the modified file, not untouched ones", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await files.writeBinary("b.md", text("TWO local"));
		const summary = await engine.push();
		expect(summary.pushed).toBe(1);
		expect(gh.createdBlobs.size).toBe(1);
		expect(gh.pushedTrees[0].entries.map((e) => e.path)).toEqual(["b.md"]);
	});

	it("does not push a file whose mtime changed but content did not", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("a.md", text("one"));
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
	});

	it("propagates a local deletion as a null-sha tree entry", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await files.remove("b.md");
		const summary = await engine.push();
		expect(summary.deletedRemote).toBe(1);
		expect(gh.pushedTrees[0].entries).toEqual([{ path: "b.md", mode: "100644", type: "blob", sha: null }]);
		expect(state.state.files["b.md"]).toBeUndefined();
	});

	it("skips oversized files with a warning", async () => {
		const { gh, files, engine, logs } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("huge.md", text("way past the cap"));
		const summary = await engine.push();
		expect(summary.skipped).toBe(1);
		expect(summary.commit).toBe(null);
		expect(logs.some((l) => l.includes("huge.md"))).toBe(true);
	});

	it("never pushes an untouched lazy placeholder", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
	});

	it("skips a modified placeholder with a warning instead of overwriting the remote file", async () => {
		const { gh, files, engine, logs } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.writeBinary("big.pdf", text("scribble"));
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
		expect(summary.skipped).toBe(1);
		expect(logs.some((l) => l.includes("big.pdf"))).toBe(true);
	});

	it("does not delete the remote file when a placeholder is deleted locally", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.remove("big.pdf");
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
		expect(summary.deletedRemote).toBe(0);
		expect(state.state.files["big.pdf"].lazy).toBe(true); // stub restored, still tracked
	});

	it("never pushes _conflicts/ or its own plugin folder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("_conflicts/x.md", text("copy"));
		await files.writeBinary(".obsidian/plugins/come-gither/data.json", text("{token}"));
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
	});
});

describe("sync: fast-forward retry", () => {
	it("re-pulls and retries when the ref moved under it", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		gh.failUpdateRefTimes = 1;
		const { push } = await engine.sync();
		expect(push.commit).not.toBe(null);
		expect(gh.head).toBe(push.commit);
	});

	it("gives up after three attempts", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		gh.failUpdateRefTimes = 99;
		const err = await engine.sync().catch((e) => e);
		expect(err.kind).toBe("not-fast-forward");
		expect(gh.failUpdateRefTimes).toBe(96);
	});
});

describe("pull: conflict resolution", () => {
	it("auto-merges text edits on different lines and leaves the merge for push", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one\ntwo\nthree\nfour\nfive" });
		await engine.pull();
		const baseSha = state.state.files["a.md"].baseBlobSha;
		await files.writeBinary("a.md", text("ONE\ntwo\nthree\nfour\nfive"));
		await gh.setFiles({ "a.md": "one\ntwo\nthree\nfour\nFIVE" });
		const summary = await engine.pull();
		expect(summary.merged).toBe(1);
		expect(summary.conflicts).toBe(0);
		expect(files.readText("a.md")).toBe("ONE\ntwo\nthree\nfour\nFIVE");
		expect(state.state.files["a.md"].baseBlobSha).toBe(baseSha);
		const push = await engine.push();
		expect(push.pushed).toBe(1);
		expect(gh.createdBlobs.has(await gitSha("ONE\ntwo\nthree\nfour\nFIVE"))).toBe(true);
	});

	it("saves the remote copy for a both-changed binary file", async () => {
		const { gh, files, engine } = makeEngine();
		const base = new Uint8Array([0, 1, 2]);
		const local = new Uint8Array([0, 9, 2]);
		const remote = new Uint8Array([0, 1, 9]);
		await gh.setFiles({ "img.png": base });
		await engine.pull();
		// The placeholder is lazy; simulate a fetched-then-edited binary instead.
		await files.writeBinary("img.png", local.buffer as ArrayBuffer);
		await gh.setFiles({ "img.png": remote });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(new Uint8Array(await files.readBinary("img.png"))).toEqual(local);
		expect(new Uint8Array(await files.readBinary("_conflicts/img.png"))).toEqual(remote);
	});

	it("takes the remote version everywhere under the remote-wins policy", async () => {
		const { gh, files, engine } = makeEngine({ conflictPolicy: "remote-wins" });
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", text("local edit"));
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText("a.md")).toBe("remote edit");
		expect(await files.stat("_conflicts/a.md")).toBeNull();
	});

	it("restores a locally deleted file under the remote-wins policy", async () => {
		const { gh, files, engine } = makeEngine({ conflictPolicy: "remote-wins" });
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.remove("a.md");
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText("a.md")).toBe("remote edit");
	});

	it("saves a conflict copy when an untracked local file differs from a new remote file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "new.md": "remote version" });
		await files.writeBinary("new.md", text("local version"));
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(files.readText("new.md")).toBe("local version");
		expect(files.readText("_conflicts/new.md")).toBe("remote version");
	});
});

describe("fetchLazy", () => {
	it("downloads the real content for a placeholder and clears the lazy flag", async () => {
		const { gh, files, state, engine } = makeEngine();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await gh.setFiles({ "big.pdf": bytes });
		await engine.pull();
		const result = await engine.fetchLazy("big.pdf");
		expect(result).toBe("fetched");
		expect(new Uint8Array(await files.readBinary("big.pdf"))).toEqual(bytes);
		expect(state.state.files["big.pdf"].lazy).toBeUndefined();
		// Now clean: neither push nor pull touches it again.
		expect((await engine.push()).commit).toBe(null);
		await gh.setFiles({ "big.pdf": bytes, "other.md": "x" });
		gh.blobFetches.length = 0;
		await engine.pull();
		expect(gh.blobFetches).toEqual([await gitSha("x")]);
	});

	it("returns not-lazy for a normally tracked file", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		gh.blobFetches.length = 0;
		expect(await engine.fetchLazy("a.md")).toBe("not-lazy");
		expect(gh.blobFetches).toEqual([]);
	});

	it("returns not-lazy for an unknown path", async () => {
		const { engine } = makeEngine();
		expect(await engine.fetchLazy("nope.pdf")).toBe("not-lazy");
	});

	it("refuses to overwrite a placeholder the user modified", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.writeBinary("big.pdf", text("scribble"));
		expect(await engine.fetchLazy("big.pdf")).toBe("modified");
		expect(files.readText("big.pdf")).toBe("scribble");
	});
});

describe("state persistence across engine instances", () => {
	function secondEngine(files: MemFiles, gh: FakeGitHub) {
		const state = new StateStore(files, STATE_PATH);
		const engine = new SyncEngine(gh, files, state, () => {}, {
			branch: "master",
			textExtensions: DEFAULT_TEXT_EXTENSIONS,
			maxAutoFetchBytes: 100 * 1048576,
			maxPushBytes: 30 * 1048576,
			conflictPolicy: "merge",
		});
		return { state, engine };
	}

	it("persists a lazy fetch immediately, so a fresh engine sees the file as downloaded", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		const { state } = secondEngine(files, gh);
		await state.load();
		expect(state.state.files["big.pdf"].lazy).toBeUndefined();
	});

	it("a downloaded binary deleted locally propagates as a remote deletion in a fresh engine", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]), "a.md": "keep" });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		await files.remove("big.pdf");
		const { state, engine: engine2 } = secondEngine(files, gh);
		await state.load();
		const summary = await engine2.push();
		expect(summary.deletedRemote).toBe(1);
		expect(gh.pushedTrees[0].entries).toEqual([{ path: "big.pdf", mode: "100644", type: "blob", sha: null }]);
	});

	it("restores a deleted placeholder on push and keeps its state entry, persisted", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.remove("big.pdf");
		const summary = await engine.push();
		expect(summary.deletedRemote).toBe(0);
		expect(summary.commit).toBe(null);
		expect((await files.stat("big.pdf"))?.size).toBe(0);
		expect(state.state.files["big.pdf"].lazy).toBe(true);
		const { state: fresh } = secondEngine(files, gh);
		await fresh.load();
		expect(fresh.state.files["big.pdf"].lazy).toBe(true);
	});
});

describe("evict", () => {
	it("turns a downloaded file back into a placeholder, persisted", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		expect(await engine.evict("big.pdf")).toBe("evicted");
		expect((await files.stat("big.pdf"))?.size).toBe(0);
		const fresh = new StateStore(files, STATE_PATH);
		await fresh.load();
		expect(fresh.state.files["big.pdf"].lazy).toBe(true);
		// Evicted file is not treated as a local change by push.
		expect((await engine.push()).commit).toBe(null);
	});

	it("refuses to evict a file with unpushed local edits", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		expect(await engine.evict("a.md")).toBe("modified");
		expect(files.readText("a.md")).toBe("edited");
	});

	it("refuses to evict an untracked file or an existing placeholder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		expect(await engine.evict("big.pdf")).toBe("not-evictable");
		await files.writeBinary("untracked.md", text("x"));
		expect(await engine.evict("untracked.md")).toBe("not-evictable");
	});
});

describe("remote size on lazy entries", () => {
	it("records the remote size on a placeholder from pull", async () => {
		const { gh, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array(2048) });
		await engine.pull();
		expect(state.state.files["big.pdf"].remoteSize).toBe(2048);
	});

	it("keeps the size through evict and drops it on fetch", async () => {
		const { gh, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array(2048) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		expect(state.state.files["big.pdf"].remoteSize).toBeUndefined();
		await engine.evict("big.pdf");
		expect(state.state.files["big.pdf"].remoteSize).toBe(2048);
		expect(state.state.files["big.pdf"].lazy).toBe(true);
	});
});

describe("preview", () => {
	it("classifies incoming and outgoing changes without touching anything", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two", "c.md": "three", "big.pdf": new Uint8Array(9) });
		await engine.pull();
		// outgoing: modify a.md, create new.md, delete c.md
		await files.writeBinary("a.md", text("one EDITED"));
		await files.writeBinary("new.md", text("brand new"));
		await files.remove("c.md");
		// incoming: change b.md remotely, add remote-new.md, keep the rest
		await gh.setFiles({ "a.md": "one", "b.md": "TWO", "c.md": "three", "big.pdf": new Uint8Array(9), "remote-new.md": "hi" });
		gh.blobFetches.length = 0;
		const stateJson = files.readText(STATE_PATH);
		const plan = await engine.preview();
		expect(plan.headMoved).toBe(true);
		expect(plan.incoming).toEqual(
			expect.arrayContaining([
				{ path: "b.md", action: "fetch" },
				{ path: "remote-new.md", action: "fetch" },
			]),
		);
		expect(plan.incoming.length).toBe(2);
		expect(plan.outgoing).toEqual(
			expect.arrayContaining([
				{ path: "a.md", action: "modified" },
				{ path: "new.md", action: "new" },
				{ path: "c.md", action: "deleted" },
			]),
		);
		expect(plan.outgoing.length).toBe(3);
		// read-only: no blob downloads, no file writes, no state change
		expect(gh.blobFetches).toEqual([]);
		expect(files.readText("a.md")).toBe("one EDITED");
		expect(files.readText(STATE_PATH)).toBe(stateJson);
	});

	it("marks both-changed files and placeholder skips", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base", "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.writeBinary("a.md", text("local"));
		await files.writeBinary("big.pdf", text("scribble"));
		await gh.setFiles({ "a.md": "remote", "big.pdf": new Uint8Array([1, 2, 3]) });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual([{ path: "a.md", action: "both-changed" }]);
		expect(plan.outgoing).toEqual(expect.arrayContaining([{ path: "big.pdf", action: "skip-placeholder" }]));
	});

	it("reports an unmoved head with no incoming rows", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const plan = await engine.preview();
		expect(plan.headMoved).toBe(false);
		expect(plan.incoming).toEqual([]);
		expect(plan.outgoing).toEqual([]);
	});

	it("classifies remote deletions and new remote binaries", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await gh.setFiles({ "a.md": "one", "img.png": new Uint8Array(5) });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual(
			expect.arrayContaining([
				{ path: "b.md", action: "delete" },
				{ path: "img.png", action: "placeholder" },
			]),
		);
		expect(await files.stat("b.md")).not.toBeNull();
	});
});

describe("preview: remaining classifications", () => {
	it("classifies adopt, overwrite, keep-local, oversize and skips excluded paths", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 15 });
		await gh.setFiles({ "a.md": "base", ".obsidian/app.json": "{}", "gone.md": "bye" });
		await engine.pull();
		// adopt: local already holds the new remote content
		await files.writeBinary("a.md", text("same-on-both"));
		// overwrite: .obsidian both-changed is pinned remote-wins
		await files.writeBinary(".obsidian/app.json", text("{local}"));
		// keep-local: gone.md deleted remotely but changed locally
		await files.writeBinary("gone.md", text("bye EDITED"));
		// oversize outgoing
		await files.writeBinary("big-note.md", text("way past eight bytes"));
		await gh.setFiles({
			"a.md": "same-on-both",
			".obsidian/app.json": "{remote}",
			"_conflicts/junk.md": "ignore me",
		});
		const plan = await engine.preview();
		expect(plan.incoming).toEqual(
			expect.arrayContaining([
				{ path: "a.md", action: "adopt" },
				{ path: ".obsidian/app.json", action: "overwrite" },
				{ path: "gone.md", action: "keep-local" },
			]),
		);
		expect(plan.incoming.find((r) => r.path.startsWith("_conflicts/"))).toBeUndefined();
		expect(plan.outgoing).toEqual(
			expect.arrayContaining([
				{ path: "big-note.md", action: "skip-oversize" },
				{ path: "gone.md", action: "modified" },
			]),
		);
	});
});

describe("revert", () => {
	it("reports an unknown absent path as clean", async () => {
		const { engine } = makeEngine();
		expect(await engine.revert("never-existed.md")).toBe("clean");
	});

	it("restores the last-synced content of a modified file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		expect(await engine.revert("a.md")).toBe("reverted");
		expect(files.readText("a.md")).toBe("base");
		expect((await engine.push()).commit).toBe(null);
	});

	it("deletes a new untracked file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("new.md", text("scratch"));
		expect(await engine.revert("new.md")).toBe("reverted");
		expect(await files.stat("new.md")).toBeNull();
	});

	it("restores a locally deleted file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.remove("a.md");
		expect(await engine.revert("a.md")).toBe("reverted");
		expect(files.readText("a.md")).toBe("base");
	});

	it("restores the stub for a modified placeholder", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.writeBinary("big.pdf", text("scribble"));
		expect(await engine.revert("big.pdf")).toBe("reverted");
		expect((await files.stat("big.pdf"))?.size).toBe(0);
		expect(state.state.files["big.pdf"].lazy).toBe(true);
	});

	it("reports a clean file as clean and persists nothing new", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		expect(await engine.revert("a.md")).toBe("clean");
	});
});
