import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_EXTENSIONS, SyncEngine } from "../src/sync";
import { StateStore } from "../src/state";
import { CaseFoldMemFiles, FakeGitHub, MemFiles, gitSha } from "./fakes";

const STATE_PATH = ".obsidian/plugins/come-gither/sync-state.json";

function makeEngine(
	overrides: {
		maxAutoFetchBytes?: number;
		maxPushBytes?: number;
		conflictPolicy?: "merge" | "remote-wins";
		configDir?: string;
		excludedPrefixes?: string[];
		files?: MemFiles;
	} = {},
) {
	const gh = new FakeGitHub();
	const files = overrides.files ?? new MemFiles();
	const state = new StateStore(files, STATE_PATH);
	const logs: string[] = [];
	const engine = new SyncEngine(gh, files, state, (level, msg) => logs.push(`${level}: ${msg}`), {
		branch: "master",
		textExtensions: DEFAULT_TEXT_EXTENSIONS,
		maxAutoFetchBytes: overrides.maxAutoFetchBytes ?? 100 * 1048576,
		maxPushBytes: overrides.maxPushBytes ?? 30 * 1048576,
		conflictPolicy: overrides.conflictPolicy ?? "merge",
		configDir: overrides.configDir ?? ".obsidian",
		excludedPrefixes: overrides.excludedPrefixes ?? [
			"_conflicts/",
			".obsidian/plugins/come-gither/",
			".git/",
			".trash/",
		],
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

	it("keeps a locally changed file that was deleted remotely, dropping its entry", async () => {
		const { gh, files, state, engine, logs } = makeEngine();
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		await engine.pull();
		await files.writeBinary("b.md", new TextEncoder().encode("edited").buffer as ArrayBuffer);
		await gh.setFiles({ "a.md": "one" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(files.readText("b.md")).toBe("edited");
		// The path no longer exists on GitHub, so a tracked entry could only make
		// a later push emit an invalid delete. The kept file resurrects as new.
		expect(state.state.files["b.md"]).toBeUndefined();
		expect(logs.some((l) => l.includes("b.md"))).toBe(true);
		const push = await engine.push();
		expect(push.pushed).toBe(1);
		expect(gh.filesByPath.has("b.md")).toBe(true);
	});

	it("does not wedge the push when a conflict-kept file is deleted later", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base", "keep.md": "k" });
		await engine.pull();
		await files.writeBinary("a.md", new TextEncoder().encode("local edit").buffer as ArrayBuffer);
		await gh.setFiles({ "keep.md": "k" }); // a.md deleted on GitHub
		const s1 = await engine.pull();
		expect(s1.conflicts).toBe(1);
		// The user reads the kept file, agrees with the deletion, removes it.
		await files.remove("a.md");
		const push = await engine.push();
		expect(push.commit).toBe(null);
		expect(push.deletedRemote).toBe(0);
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
		// The first file lands, then the connection drops on the second fetch.
		gh.failBlobFetchAtIndex = 1;
		await expect(engine.pull()).rejects.toThrow("network dropped");
		expect(state.state.lastSyncedCommit).toBeNull();
		expect(Object.keys(state.state.files)).toEqual(["a.md"]);
		gh.blobFetches.length = 0;
		const summary = await engine.pull();
		expect(state.state.lastSyncedCommit).toBe(gh.head);
		expect(Object.keys(state.state.files).length).toBe(3);
		// Only the two files the interruption left behind are fetched again.
		expect(summary.fetched).toBe(2);
		expect(gh.blobFetches).not.toContain(await gitSha("one"));
		expect(gh.blobFetches.length).toBe(2);
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
		expect(summary).toEqual({ pushed: 0, deletedRemote: 0, skipped: 0, skippedPaths: [], commit: null });
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

describe("revert safety net", () => {
	it("saves an untracked file to _conflicts/ before deleting it", async () => {
		// Reachable via a conflict-kept file (entry dropped) shown as "New file"
		// in the preview: its Revert button must never destroy the only copy.
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("note.md", text("precious"));
		expect(await engine.revert("note.md")).toBe("reverted-new");
		expect(await files.stat("note.md")).toBeNull();
		expect(files.readText("_conflicts/note.md")).toBe("precious");
	});

	it("parks to a suffixed name instead of clobbering an earlier only-copy", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("note.md", text("first"));
		await engine.revert("note.md");
		await files.writeBinary("note.md", text("second"));
		await engine.revert("note.md");
		expect(files.readText("_conflicts/note.md")).toBe("first");
		expect(files.readText("_conflicts/note.md.1")).toBe("second");
	});

	it("restores the stub for a deleted placeholder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.remove("big.pdf");
		expect(await engine.revert("big.pdf")).toBe("reverted");
		expect((await files.stat("big.pdf"))?.size).toBe(0);
	});

	it("restores the stub for a lazy entry even when the disk holds the base content", async () => {
		// The evict re-stub path: a closing editor saved the pre-evict content
		// back over the stub; that content hashes to baseBlobSha, but a lazy
		// entry with real bytes on disk is never clean for revert purposes.
		const { gh, files, state, engine } = makeEngine();
		const bytes = new Uint8Array([1, 2, 3]);
		await gh.setFiles({ "big.pdf": bytes });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		await engine.evict("big.pdf");
		await files.writeBinary("big.pdf", bytes.buffer.slice(0) as ArrayBuffer); // editor save-back
		expect(await engine.revert("big.pdf")).toBe("reverted");
		expect((await files.stat("big.pdf"))?.size).toBe(0);
		expect(state.state.files["big.pdf"].lazy).toBe(true);
	});
});

describe("oversize local files under remote-wins", () => {
	it("keeps the local file instead of buffering it for a _conflicts park", async () => {
		const { gh, files, engine, logs } = makeEngine({ conflictPolicy: "remote-wins", maxPushBytes: 4 });
		await gh.setFiles({ "keep.md": "k" });
		await engine.pull();
		await files.writeBinary("video.mp4", text("huge local bytes over the cap"));
		await gh.setFiles({ "keep.md": "k", "video.mp4": new Uint8Array([9, 9]) });
		const reads: string[] = [];
		const orig = files.readBinary.bind(files);
		files.readBinary = async (p) => {
			reads.push(p);
			return orig(p);
		};
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(reads).not.toContain("video.mp4");
		expect(files.readText("video.mp4")).toBe("huge local bytes over the cap");
		expect(logs.some((l) => l.includes("video.mp4"))).toBe(true);
	});
});

describe("case-only remote renames", () => {
	it("keeps the single physical file on a case-insensitive filesystem", async () => {
		const files = new CaseFoldMemFiles();
		const { gh, state, engine } = makeEngine({ files });
		await gh.setFiles({ "note.md": "content" });
		await engine.pull();
		// GitHub now holds the same path with different casing.
		await gh.setFiles({ "Note.md": "content" });
		const plan = await engine.preview();
		expect(plan.incoming.find((r) => r.path === "note.md")).toBeUndefined();
		await engine.pull();
		// Both names are one file here; removing "note.md" would destroy it.
		expect(await files.stat("note.md")).not.toBeNull();
		expect(state.state.files["note.md"]).toBeUndefined();
		expect(state.state.files["Note.md"]).toBeDefined();
		// The follow-up push must neither re-upload nor delete anything.
		const push = await engine.push();
		expect(push.commit).toBe(null);
		expect(push.deletedRemote).toBe(0);
		expect(gh.filesByPath.has("Note.md")).toBe(true);
	});

	it("applies the rename as two files on a case-sensitive filesystem", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "note.md": "content" });
		await engine.pull();
		await gh.setFiles({ "Note.md": "content" });
		await engine.pull();
		// Distinct physical files here: the old casing is a real remote delete.
		expect(await files.stat("note.md")).toBeNull();
		expect(await files.stat("Note.md")).not.toBeNull();
		expect(state.state.files["note.md"]).toBeUndefined();
	});

	it("never deletes the remote file when a local case-rename's upload was skipped", async () => {
		const files = new CaseFoldMemFiles();
		const { gh, state, engine } = makeEngine({ files, maxPushBytes: 4 });
		await gh.setFiles({ "big.md": "elevenbytes" });
		await engine.pull();
		files.renameCase("big.md", "Big.md");
		const push = await engine.push();
		// The re-upload of the new casing is over the cap; emitting the delete
		// anyway would remove the file from GitHub entirely.
		expect(push.deletedRemote).toBe(0);
		expect(gh.filesByPath.has("big.md")).toBe(true);
		expect(state.state.files["big.md"]).toBeDefined();
	});

	it("does not push a clean local case-rename as a colliding new file", async () => {
		const files = new CaseFoldMemFiles();
		const { gh, engine } = makeEngine({ files });
		await gh.setFiles({ "note.md": "content" });
		await engine.pull();
		files.renameCase("note.md", "Note.md");
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
		const push = await engine.push();
		expect(push.commit).toBe(null);
		expect(gh.createBlobCalls).toBe(0);
	});

	it("emits a genuine delete when two distinct tracked case twins exist", async () => {
		// Case-sensitive filesystem: note.md and Note.md are two real files.
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "note.md": "lower", "Note.md": "upper" });
		await engine.pull();
		await files.remove("note.md");
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([{ path: "note.md", action: "deleted" }]);
		const push = await engine.push();
		expect(push.deletedRemote).toBe(1);
		expect(gh.filesByPath.has("note.md")).toBe(false);
		expect(gh.filesByPath.has("Note.md")).toBe(true);
	});

	it("preview matches pull for a remote case rename on a case-sensitive filesystem", async () => {
		const { gh, engine } = makeEngine();
		await gh.setFiles({ "note.md": "content" });
		await engine.pull();
		await gh.setFiles({ "Note.md": "content" });
		const plan = await engine.preview();
		// Pull will fetch Note.md as a second file and delete note.md; the
		// panel must say so instead of hiding the delete.
		expect(plan.incoming).toEqual(
			expect.arrayContaining([
				{ path: "Note.md", action: "fetch" },
				{ path: "note.md", action: "delete" },
			]),
		);
	});

	it("propagates a case rename with edits and logs the collision risk", async () => {
		const files = new CaseFoldMemFiles();
		const { gh, engine, logs } = makeEngine({ files });
		await gh.setFiles({ "note.md": "content" });
		await engine.pull();
		files.renameCase("note.md", "Note.md");
		await files.writeBinary("Note.md", text("edited"));
		const push = await engine.push();
		expect(push.pushed).toBe(1);
		expect(push.deletedRemote).toBe(1);
		expect(logs.some((l) => l.includes("only by case"))).toBe(true);
		expect(gh.filesByPath.has("Note.md")).toBe(true);
		expect(gh.filesByPath.has("note.md")).toBe(false);
	});
});

describe("retired engines", () => {
	it("rejects new operations after retire while finishing queued ones", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		gh.onCreateBlob = () => gate;
		const syncing = engine.sync();
		engine.retire();
		await expect(engine.evict("a.md")).rejects.toThrow("retired");
		gh.onCreateBlob = undefined;
		release();
		const { push } = await syncing; // the in-flight sync still completes
		expect(push.commit).not.toBe(null);
	});
});

describe("lazy placeholder deleted remotely", () => {
	it("moves a scribbled stub to _conflicts/ instead of uploading its bytes", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]), "keep.md": "k" });
		await engine.pull();
		// The user typed into the empty placeholder; the real content was never
		// downloaded, so those stub bytes must never become the file's content.
		await files.writeBinary("big.pdf", text("scribble"));
		await gh.setFiles({ "keep.md": "k" }); // big.pdf deleted on GitHub
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(await files.stat("big.pdf")).toBeNull();
		expect(files.readText("_conflicts/big.pdf")).toBe("scribble");
		expect(state.state.files["big.pdf"]).toBeUndefined();
		const push = await engine.push();
		expect(push.commit).toBe(null); // nothing resurrects the stub bytes
	});
});

describe("re-baseline memory safety", () => {
	it("classifies a huge untracked local file without reading it when sizes differ", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "video.mp4": new Uint8Array([1, 2, 3]) });
		await files.writeBinary("video.mp4", text("local video bytes over the cap"));
		const reads: string[] = [];
		const orig = files.readBinary.bind(files);
		files.readBinary = async (p) => {
			reads.push(p);
			return orig(p);
		};
		const plan = await engine.preview();
		expect(reads).not.toContain("video.mp4");
		expect(plan.incoming.length).toBe(1);
		expect(plan.incoming[0].path).toBe("video.mp4");
	});
});

describe("engine idle", () => {
	it("resolves idle only after the queued operations settle", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		gh.onCreateBlob = () => gate;
		const syncing = engine.sync();
		let idleDone = false;
		const idling = engine.idle().then(() => {
			idleDone = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(idleDone).toBe(false);
		gh.onCreateBlob = undefined;
		release();
		await syncing;
		await idling;
		expect(idleDone).toBe(true);
	});
});

describe("excluded entries in push and preview", () => {
	it("drops a newly excluded tracked entry instead of deleting it on GitHub", async () => {
		// Upgrade shape: 0.3.x synced .trash/, 0.4 excludes it. The entry, the
		// local file, and the remote file all still exist.
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "x", ".trash/old.md": "y" });
		await files.writeBinary(".trash/old.md", text("y"));
		await engine.pull();
		await state.setFile(".trash/old.md", {
			baseBlobSha: await gitSha("y"),
			size: 1,
			mtime: (await files.stat(".trash/old.md"))?.mtime ?? 0,
		});
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
		const push = await engine.push();
		expect(push.deletedRemote).toBe(0);
		expect(push.commit).toBe(null);
		expect(gh.filesByPath.has(".trash/old.md")).toBe(true);
		expect(state.state.files[".trash/old.md"]).toBeUndefined();
	});
});

describe("blob cache integrity", () => {
	it("never serves another file's bytes when content mutates mid-push", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "keep.md": "k" });
		await engine.pull();
		await files.writeBinary("a.md", text("shared"));
		await files.writeBinary("b.md", text("shared"));
		// Mutate a.md between its change-detection read and its upload read.
		const orig = files.readBinary.bind(files);
		let aReads = 0;
		files.readBinary = async (p) => {
			if (p === "a.md") {
				aReads += 1;
				if (aReads === 2) files.store.set("a.md", new TextEncoder().encode("mutated"));
			}
			return orig(p);
		};
		await engine.sync();
		const b = gh.filesByPath.get("b.md");
		expect(new TextDecoder().decode(b?.bytes as Uint8Array)).toBe("shared");
	});

	it("keeps the running push's blob cache when another sync is queued", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		gh.failUpdateRefTimes = 1;
		let second: Promise<unknown> = Promise.resolve();
		gh.onUpdateRef = () => {
			gh.onUpdateRef = undefined;
			second = engine.sync(); // queued mid-push; must not wipe the cache
		};
		await engine.sync();
		await second;
		expect(gh.createBlobCalls).toBe(1);
	});
});

describe("lazy entry healing", () => {
	it("marks a lazy entry non-lazy when the full content is present", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		// Crash shape: the download landed but a stale lazy entry survived.
		const entry = state.state.files["big.pdf"];
		await state.setFile("big.pdf", {
			baseBlobSha: entry.baseBlobSha,
			size: 0,
			mtime: 0,
			lazy: true,
			remoteSize: 3,
		});
		await engine.push();
		expect(state.state.files["big.pdf"].lazy).toBeUndefined();
		// Later edits sync normally instead of being skipped as a placeholder.
		await files.writeBinary("big.pdf", text("edited"));
		const push = await engine.push();
		expect(push.skipped).toBe(0);
		expect(push.pushed).toBe(1);
	});
});

describe("oversize healing", () => {
	it("heals a touched-but-identical oversize file silently", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "big.md": "elevenbytes" });
		await engine.pull();
		await files.writeBinary("big.md", text("elevenbytes")); // mtime drift only
		// The preview (read-only) already hides the drifted file...
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
		// ...and the push heals the fingerprint silently.
		const push = await engine.push();
		expect(push.skipped).toBe(0);
		expect(push.commit).toBe(null);
	});

	it("still skips an oversize file whose content changed", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "big.md": "elevenbytes" });
		await engine.pull();
		await files.writeBinary("big.md", text("ELEVENBYTES"));
		const push = await engine.push();
		expect(push.skipped).toBe(1);
		expect(push.skippedPaths).toEqual(["big.md"]);
	});
});

describe("config dir case folding", () => {
	it("pins the config-folder overwrite case-insensitively", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ ".Obsidian/app.json": "{}" });
		await engine.pull();
		await files.writeBinary(".Obsidian/app.json", text("{local}"));
		await gh.setFiles({ ".Obsidian/app.json": "{remote}" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText(".Obsidian/app.json")).toBe("{remote}");
	});
});

describe("remote fidelity", () => {
	it("pushes a commit whose tree builds on the synced base tree", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const base = gh.head;
		await files.writeBinary("new.md", text("fresh"));
		const push = await engine.push();
		expect(gh.pushedTrees[0].baseTree).toBe(`tree-of-${base}`);
		const commit = gh.pushedCommits.get(push.commit as string);
		expect(commit?.treeSha).toBe("tree-push-1");
		// The remote now serves the pushed content under the new head.
		const { treeSha } = await gh.getCommit(gh.head);
		const tree = await gh.getTree(treeSha, true);
		expect(tree.entries.filter((e) => e.type === "blob").map((e) => e.path).sort()).toEqual(["a.md", "new.md"]);
	});

	it("FakeGitHub rejects deleting a path missing from the base tree, like GitHub", async () => {
		const { gh } = makeEngine();
		await gh.setFiles({ "a.md": "x" });
		await expect(
			gh.createTree(`tree-of-${gh.head}`, [{ path: "ghost.md", mode: "100644", type: "blob", sha: null }]),
		).rejects.toThrow("not in base tree");
	});

	it("FakeGitHub serves historical trees by sha after the remote moves on", async () => {
		const { gh } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		const oldTree = `tree-of-${gh.head}`;
		await gh.setFiles({ "a.md": "one", "b.md": "two" });
		const old = await gh.getTree(oldTree, true);
		expect(old.entries.filter((e) => e.type === "blob").map((e) => e.path)).toEqual(["a.md"]);
	});
});

describe("sync: fast-forward retry", () => {
	it("integrates an interloper commit when the push retries", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		// The head moves while the push is uploading its blob: the first
		// updateRef fails as a genuine not-fast-forward, not an injected error.
		gh.onCreateBlob = async () => {
			gh.onCreateBlob = undefined;
			await gh.setFiles({ "a.md": "one", "interloper.md": "surprise" });
		};
		const { push } = await engine.sync();
		expect(push.commit).not.toBe(null);
		// The retry pulled the interloper's file and rebased onto the moved head.
		expect(files.readText("interloper.md")).toBe("surprise");
		const commit = gh.pushedCommits.get(push.commit as string);
		expect(commit?.parents).not.toEqual([]);
		expect(gh.head).toBe(push.commit);
		const { treeSha } = await gh.getCommit(gh.head);
		const tree = await gh.getTree(treeSha, true);
		const paths = tree.entries.filter((e) => e.type === "blob").map((e) => e.path).sort();
		expect(paths).toEqual(["a.md", "interloper.md", "new.md"]);
	});

	it("reuses blobs already uploaded when the push retries", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		gh.failUpdateRefTimes = 1;
		const { push } = await engine.sync();
		expect(push.commit).not.toBe(null);
		// Blobs are content-addressed and persist server-side; a retry after
		// not-fast-forward must not re-upload them at one request per second.
		expect(gh.createBlobCalls).toBe(1);
	});

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
			configDir: ".obsidian",
			excludedPrefixes: ["_conflicts/", ".obsidian/plugins/come-gither/", ".git/", ".trash/"],
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
		expect(await engine.revert("new.md")).toBe("reverted-new");
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

describe("both-sides deletions", () => {
	it("treats a file deleted on both sides as agreement, not a conflict", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "x", "b.md": "keep" });
		await engine.pull();
		await files.remove("a.md");
		await gh.setFiles({ "b.md": "keep" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(summary.deleted).toBe(1);
		expect(state.state.files["a.md"]).toBeUndefined();
		// The zombie entry is gone, so push never emits a delete for a path
		// absent from the base tree (GitHub rejects that with a 422).
		const push = await engine.push();
		expect(push.deletedRemote).toBe(0);
		expect(push.commit).toBe(null);
	});

	it("preview shows no row for a file deleted on both sides", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "x", "b.md": "keep" });
		await engine.pull();
		await files.remove("a.md");
		await gh.setFiles({ "b.md": "keep" });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual([]);
		expect(plan.outgoing).toEqual([]);
	});
});

describe("push protections", () => {
	it("leaves an untracked empty stub alone even when the head has not moved", async () => {
		const { gh, files, state, engine } = makeEngine();
		await gh.setFiles({ "a.md": "x", "photo.png": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		// Simulate a lost state entry: the stub file exists but nothing tracks it.
		await state.removeFile("photo.png");
		const push = await engine.push();
		expect(push.commit).toBe(null);
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
	});

	it("records the fingerprint captured at read time, so a mid-push edit is still pushed later", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		gh.onCreateBlob = async () => {
			gh.onCreateBlob = undefined;
			await files.writeBinary("a.md", text("edited again"));
		};
		await engine.push();
		const second = await engine.push();
		expect(second.pushed).toBe(1);
		expect(gh.createdBlobs.has(await gitSha("edited again"))).toBe(true);
	});

	it("skips an oversize file without reading its content", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("huge.bin", text("way past the four byte cap"));
		const reads: string[] = [];
		const origRead = files.readBinary.bind(files);
		files.readBinary = async (path) => {
			reads.push(path);
			return origRead(path);
		};
		const push = await engine.push();
		expect(push.skipped).toBe(1);
		expect(reads).not.toContain("huge.bin");
		reads.length = 0;
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([{ path: "huge.bin", action: "skip-oversize" }]);
		expect(reads).not.toContain("huge.bin");
	});

	it("names the skipped paths in the push summary", async () => {
		const { gh, files, engine } = makeEngine({ maxPushBytes: 4 });
		await gh.setFiles({ "a.md": "one", "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.writeBinary("huge.md", text("way past the four byte cap"));
		await files.writeBinary("big.pdf", text("scr"));
		const push = await engine.push();
		expect(push.skipped).toBe(2);
		expect([...push.skippedPaths].sort()).toEqual(["big.pdf", "huge.md"]);
	});

	it("skips a file that disappears between listing and stat", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		const origList = files.listRecursive.bind(files);
		files.listRecursive = async (p) => [...(await origList(p)), "ghost.md"];
		expect((await engine.push()).commit).toBe(null);
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
	});

	it("preview ignores a touched-but-identical file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("a.md", text("one"));
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([]);
	});

	it("preserves the remote file mode when pushing an edit", async () => {
		const { gh, files, engine } = makeEngine();
		gh.modes.set("run.sh", "100755");
		await gh.setFiles({ "run.sh": "#!/bin/sh" });
		await engine.pull();
		await files.writeBinary("run.sh", text("#!/bin/sh\necho hi"));
		await engine.push();
		expect(gh.pushedTrees[0].entries[0]).toMatchObject({ path: "run.sh", mode: "100755" });
	});
});

describe("placeholder drift", () => {
	it("treats a stub whose mtime drifted as an untouched placeholder", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		// A backup restore or file-provider touch rewrites the stub: still empty,
		// but the fingerprint no longer matches.
		await files.writeBinary("big.pdf", new ArrayBuffer(0));
		expect(await engine.fetchLazy("big.pdf")).toBe("fetched");
		expect((await files.stat("big.pdf"))?.size).toBe(3);
	});
});

describe("overwrite safety under remote-wins", () => {
	it("saves the local bytes before replacing a changed binary with a placeholder", async () => {
		const { gh, files, engine } = makeEngine({ conflictPolicy: "remote-wins" });
		await gh.setFiles({ "img.png": new Uint8Array([0, 1, 2]) });
		await engine.pull();
		await engine.fetchLazy("img.png");
		const localBytes = new Uint8Array([7, 7, 7]);
		await files.writeBinary("img.png", localBytes.buffer.slice(0) as ArrayBuffer);
		await gh.setFiles({ "img.png": new Uint8Array([9, 9, 9]) });
		await engine.pull();
		expect((await files.stat("img.png"))?.size).toBe(0);
		expect(new Uint8Array(await files.readBinary("_conflicts/img.png"))).toEqual(localBytes);
	});

	it("logs a warning when the remote version overwrites local changes", async () => {
		const { gh, files, engine, logs } = makeEngine({ conflictPolicy: "remote-wins" });
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", text("local edit"));
		await gh.setFiles({ "a.md": "remote edit" });
		await engine.pull();
		expect(logs.some((l) => l.includes("overwriting local changes to a.md"))).toBe(true);
	});
});

describe("oversize conflicts", () => {
	it("records the conflict without downloading an oversize remote blob", async () => {
		const { gh, files, engine, logs } = makeEngine({ maxAutoFetchBytes: 4 });
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.writeBinary("a.md", text("local edit"));
		await gh.setFiles({ "a.md": "remote edit!" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(1);
		expect(gh.blobFetches).not.toContain(await gitSha("remote edit!"));
		expect(await files.stat("_conflicts/a.md")).toBeNull();
		expect(files.readText("a.md")).toBe("local edit");
		expect(logs.some((l) => l.includes("too large"))).toBe(true);
	});
});

describe("preview parity with sync", () => {
	it("labels a locally deleted, remotely changed file as deleted-conflict", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "base" });
		await engine.pull();
		await files.remove("a.md");
		await gh.setFiles({ "a.md": "remote edit" });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual([{ path: "a.md", action: "deleted-conflict" }]);
	});

	it("shows a restore row for a deleted placeholder instead of hiding it", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await files.remove("big.pdf");
		const plan = await engine.preview();
		expect(plan.outgoing).toEqual([{ path: "big.pdf", action: "restore-placeholder" }]);
	});

	it("classifies an untracked empty file matching an empty remote blob as adopt", async () => {
		const { gh, files, engine } = makeEngine();
		await files.writeBinary("empty.md", new ArrayBuffer(0));
		await gh.setFiles({ "empty.md": "" });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual([{ path: "empty.md", action: "adopt" }]);
		expect(plan.outgoing).toEqual([]);
	});
});

describe("config dir and exclusions", () => {
	it("excludes prefixes case-insensitively", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ ".obsidian/plugins/Come-Gither/data.json": "{evil}", "ok.md": "y" });
		const summary = await engine.pull();
		expect(summary.fetched).toBe(1);
		expect(await files.stat(".obsidian/plugins/Come-Gither/data.json")).toBeNull();
	});

	it("honors a custom config dir for exclusion and the remote-wins pin", async () => {
		const { gh, files, engine } = makeEngine({
			configDir: ".obsidian-work",
			excludedPrefixes: ["_conflicts/", ".obsidian-work/plugins/come-gither/"],
		});
		await gh.setFiles({
			".obsidian-work/plugins/come-gither/data.json": "{token}",
			".obsidian-work/app.json": "{}",
		});
		await engine.pull();
		expect(await files.stat(".obsidian-work/plugins/come-gither/data.json")).toBeNull();
		await files.writeBinary(".obsidian-work/app.json", text("{local}"));
		await gh.setFiles({
			".obsidian-work/plugins/come-gither/data.json": "{token}",
			".obsidian-work/app.json": "{remote}",
		});
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText(".obsidian-work/app.json")).toBe("{remote}");
	});

	it("fetches binaries under a custom config dir fully", async () => {
		const { gh, files, engine } = makeEngine({
			configDir: ".obsidian-work",
			excludedPrefixes: ["_conflicts/"],
		});
		await gh.setFiles({ ".obsidian-work/plugins/x/icon.png": new Uint8Array([9, 9]) });
		const summary = await engine.pull();
		expect(summary.placeholders).toBe(0);
		expect((await files.stat(".obsidian-work/plugins/x/icon.png"))?.size).toBe(2);
	});

	it("never pushes .git/ or .trash/ from a desktop checkout vault", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary(".git/config", text("[remote]"));
		await files.writeBinary(".trash/old.md", text("bye"));
		const summary = await engine.push();
		expect(summary.commit).toBe(null);
	});
});

describe("operation serialization", () => {
	it("queues a lazy fetch behind a running sync", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "big.pdf": new Uint8Array([9, 9]) });
		await engine.pull();
		await files.writeBinary("a.md", text("edited"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		gh.onCreateBlob = () => gate;
		const syncing = engine.sync();
		const fetching = engine.fetchLazy("big.pdf");
		await new Promise((r) => setTimeout(r, 0));
		expect((await files.stat("big.pdf"))?.size).toBe(0); // still a stub
		gh.onCreateBlob = undefined;
		release();
		await syncing;
		expect(await fetching).toBe("fetched");
		expect((await files.stat("big.pdf"))?.size).toBe(2);
	});

	it("queues an evict behind a running sync instead of racing it", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one", "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		await files.writeBinary("a.md", text("edited"));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		gh.onCreateBlob = () => gate; // the sync's push now blocks inside createBlob
		const syncing = engine.sync();
		const evicting = engine.evict("big.pdf");
		await new Promise((r) => setTimeout(r, 0));
		// The evict must not have touched the file while the sync holds the lock.
		expect((await files.stat("big.pdf"))?.size).toBe(3);
		gh.onCreateBlob = undefined;
		release();
		await syncing;
		expect(await evicting).toBe("evicted");
		// The push carried the real edit; no empty blob was ever uploaded for big.pdf.
		expect(gh.createdBlobs.has(await gitSha("edited"))).toBe(true);
		expect(gh.createdBlobs.has(await gitSha(new Uint8Array(0)))).toBe(false);
		expect((await files.stat("big.pdf"))?.size).toBe(0);
	});

	it("runs a queued operation even when the one before it failed", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "a.md": "one" });
		await engine.pull();
		await files.writeBinary("new.md", text("fresh"));
		gh.failUpdateRefTimes = 99;
		const failing = engine.sync().catch((e) => e);
		const reverting = engine.revert("new.md");
		expect((await failing).kind).toBe("not-fast-forward");
		expect(await reverting).toBe("reverted-new");
		expect(await files.stat("new.md")).toBeNull();
	});
});

describe("evict crash safety", () => {
	it("persists the lazy entry before truncating the file", async () => {
		const { gh, files, engine } = makeEngine();
		await gh.setFiles({ "big.pdf": new Uint8Array([1, 2, 3]) });
		await engine.pull();
		await engine.fetchLazy("big.pdf");
		let stateAtTruncate: string | null = null;
		const origWrite = files.writeBinary.bind(files);
		files.writeBinary = async (path, data) => {
			if (path === "big.pdf" && data.byteLength === 0) stateAtTruncate = files.readText(STATE_PATH);
			await origWrite(path, data);
		};
		expect(await engine.evict("big.pdf")).toBe("evicted");
		expect(stateAtTruncate).not.toBeNull();
		// A crash right after the truncation must leave a lazy entry on disk,
		// so the next push skips the stub instead of uploading empty content.
		const persisted = JSON.parse(stateAtTruncate ?? "{}");
		expect(persisted.files["big.pdf"].lazy).toBe(true);
	});
});

describe("stale empty stubs", () => {
	it("treats an untracked zero-byte file as absent, not a conflict", async () => {
		const { gh, files, state, engine } = makeEngine();
		// A stale stub with no state entry (state lost), remote has the real binary.
		await files.writeBinary("assets/photo.png", new ArrayBuffer(0));
		await gh.setFiles({ "assets/photo.png": new Uint8Array([1, 2, 3]), "a.md": "hi" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(summary.placeholders).toBe(1);
		expect(state.state.files["assets/photo.png"].lazy).toBe(true);
		expect(await files.stat("_conflicts/assets/photo.png")).toBeNull();
	});

	it("fetches over an untracked zero-byte stub of a text file", async () => {
		const { gh, files, engine } = makeEngine();
		await files.writeBinary("note.md", new ArrayBuffer(0));
		await gh.setFiles({ "note.md": "real content" });
		const summary = await engine.pull();
		expect(summary.conflicts).toBe(0);
		expect(files.readText("note.md")).toBe("real content");
	});

	it("preview classifies an untracked zero-byte stub as placeholder, not both-changed", async () => {
		const { gh, files, engine } = makeEngine();
		await files.writeBinary("assets/photo.png", new ArrayBuffer(0));
		await gh.setFiles({ "assets/photo.png": new Uint8Array([1, 2, 3]) });
		const plan = await engine.preview();
		expect(plan.incoming).toEqual([{ path: "assets/photo.png", action: "placeholder" }]);
	});

	it("still protects an untracked zero-byte file when the remote file is also empty-equal", async () => {
		const { gh, files, engine } = makeEngine();
		await files.writeBinary("empty.md", new ArrayBuffer(0));
		await gh.setFiles({ "empty.md": "" });
		const summary = await engine.pull();
		expect(summary.adopted).toBe(1); // identical empty content adopts, no fetch
	});
});
