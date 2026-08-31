import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state";
import type { FileEntry } from "../src/state";
import { FakeClock, MemFiles } from "./fakes";

const PATH = ".obsidian/plugins/come-gither/sync-state.json";
const entry = (sha: string): FileEntry => ({ baseBlobSha: sha, size: 1, mtime: 1 });

function makeStore(files = new MemFiles(), clock = new FakeClock()) {
	return { store: new StateStore(files, PATH, clock.now), files, clock };
}

describe("StateStore load", () => {
	it("starts empty when no state file exists", async () => {
		const { store } = makeStore();
		await store.load();
		expect(store.state).toEqual({ version: 1, lastSyncedCommit: null, files: {} });
	});

	it("loads a valid state file", async () => {
		const files = new MemFiles();
		files.writeText(
			PATH,
			JSON.stringify({ version: 1, lastSyncedCommit: "c1", files: { "a.md": entry("s1") } }),
		);
		const { store } = makeStore(files);
		await store.load();
		expect(store.state.lastSyncedCommit).toBe("c1");
		expect(store.state.files["a.md"]).toEqual(entry("s1"));
	});

	it("treats corrupt JSON as empty state", async () => {
		const files = new MemFiles();
		files.writeText(PATH, "{not json");
		const { store } = makeStore(files);
		await store.load();
		expect(store.state).toEqual({ version: 1, lastSyncedCommit: null, files: {} });
	});

	it("treats an unknown version as empty state", async () => {
		const files = new MemFiles();
		files.writeText(PATH, JSON.stringify({ version: 99, lastSyncedCommit: "c1", files: {} }));
		const { store } = makeStore(files);
		await store.load();
		expect(store.state).toEqual({ version: 1, lastSyncedCommit: null, files: {} });
	});
});

describe("StateStore remote identity", () => {
	it("keeps entries for the same remote and re-baselines for a different one", async () => {
		const files = new MemFiles();
		const a = new StateStore(files, PATH);
		await a.load("kaleho/vault#master");
		await a.setFile("a.md", entry("s1"));
		await a.setCommit("c1");
		const same = new StateStore(files, PATH);
		await same.load("kaleho/vault#master");
		expect(same.state.files["a.md"]).toEqual(entry("s1"));
		// Pointing the settings at another repo or branch must never reuse
		// entries: trusting them would mass-delete local files on the next pull.
		const other = new StateStore(files, PATH);
		await other.load("kaleho/testbed#master");
		expect(other.state.files).toEqual({});
		expect(other.state.lastSyncedCommit).toBe(null);
	});

	it("adopts a legacy state file that has no remote stamp and stamps it", async () => {
		const files = new MemFiles();
		files.writeText(
			PATH,
			JSON.stringify({ version: 1, lastSyncedCommit: "c1", files: { "a.md": entry("s1") } }),
		);
		const store = new StateStore(files, PATH);
		await store.load("kaleho/vault#master");
		expect(store.state.files["a.md"]).toEqual(entry("s1"));
		await store.setCommit("c2");
		expect(JSON.parse(files.readText(PATH)).remote).toBe("kaleho/vault#master");
	});
});

describe("StateStore flush cadence", () => {
	it("does not write on every setFile", async () => {
		const { store, files } = makeStore();
		await store.load();
		await store.setFile("a.md", entry("s1"));
		expect(files.writes).toEqual([]);
	});

	it("flushes after twenty dirty updates, then resets the counter", async () => {
		const { store, files } = makeStore();
		await store.load();
		for (let i = 0; i < 20; i++) await store.setFile(`f${i}.md`, entry("s"));
		expect(files.writes).toEqual([PATH]);
		for (let i = 0; i < 19; i++) await store.setFile(`g${i}.md`, entry("s"));
		expect(files.writes).toEqual([PATH]);
		await store.setFile("g19.md", entry("s"));
		expect(files.writes).toEqual([PATH, PATH]);
	});

	it("flushes when ten seconds have passed since the last flush", async () => {
		const { store, files, clock } = makeStore();
		await store.load();
		await store.setFile("a.md", entry("s1"));
		expect(files.writes).toEqual([]);
		clock.t += 10_000;
		await store.setFile("b.md", entry("s2"));
		expect(files.writes).toEqual([PATH]);
	});

	it("removeFile counts as a dirty update and drops the entry", async () => {
		const { store, files } = makeStore();
		await store.load();
		for (let i = 0; i < 19; i++) await store.setFile(`f${i}.md`, entry("s"));
		await store.removeFile("f0.md");
		expect(files.writes).toEqual([PATH]);
		expect(store.state.files["f0.md"]).toBeUndefined();
	});

	it("setCommit flushes immediately", async () => {
		const { store, files } = makeStore();
		await store.load();
		await store.setCommit("c9");
		expect(files.writes).toEqual([PATH]);
		expect(JSON.parse(files.readText(PATH)).lastSyncedCommit).toBe("c9");
	});
});

describe("StateStore round trip", () => {
	it("works with the real clock when none is injected", async () => {
		const files = new MemFiles();
		const store = new StateStore(files, PATH);
		await store.load();
		await store.setCommit("c1");
		expect(JSON.parse(files.readText(PATH)).lastSyncedCommit).toBe("c1");
	});

	it("persists everything through flush and a fresh load", async () => {
		const files = new MemFiles();
		const a = makeStore(files).store;
		await a.load();
		await a.setFile("a.md", entry("s1"));
		await a.setFile("b.pdf", { baseBlobSha: "s2", size: 9, mtime: 7, lazy: true });
		await a.setCommit("c1");
		const b = makeStore(files).store;
		await b.load();
		expect(b.state).toEqual(a.state);
	});
});
