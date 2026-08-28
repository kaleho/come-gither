import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_EXTENSIONS, SyncEngine } from "../src/sync";
import { StateStore } from "../src/state";
import { FakeGitHub, MemFiles, gitSha } from "./fakes";

const STATE_PATH = ".obsidian/plugins/come-gither/sync-state.json";

function makeEngine(overrides: { maxAutoFetchBytes?: number } = {}) {
	const gh = new FakeGitHub();
	const files = new MemFiles();
	const state = new StateStore(files, STATE_PATH);
	const logs: string[] = [];
	const engine = new SyncEngine(gh, files, state, (level, msg) => logs.push(`${level}: ${msg}`), {
		branch: "master",
		textExtensions: DEFAULT_TEXT_EXTENSIONS,
		maxAutoFetchBytes: overrides.maxAutoFetchBytes ?? 100 * 1048576,
	});
	return { gh, files, state, engine, logs };
}

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
	});

	it("treats an extensionless file as binary and makes a placeholder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ LICENSE: "MIT..." });
		const summary = await engine.pull();
		expect(summary.placeholders).toBe(1);
		expect((await files.stat("LICENSE"))?.size).toBe(0);
	});

	it("keeps the local side when both sides changed (merge comes later)", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", new TextEncoder().encode("local edit").buffer as ArrayBuffer);
		await gh.setFiles({ "a.md": "remote edit" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(files.readText("a.md")).toBe("local edit");
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
