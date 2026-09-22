import { describe, expect, it } from "vitest";
import {
	cacheBustedUrl,
	clampSyncMinutes,
	confirmOrDefer,
	lowercaseHeaders,
	maxDeletionsFor,
	parentDirs,
	parseDeletionThreshold,
	syncParts,
} from "../src/wire";
import type { PullSummary, PushSummary } from "../src/sync";

describe("cacheBustedUrl", () => {
	it("appends cb with ? on a bare GET url", () => {
		expect(cacheBustedUrl("https://x/y", "GET", () => 7)).toBe("https://x/y?cb=7");
	});

	it("appends cb with & when a query already exists", () => {
		expect(cacheBustedUrl("https://x/y?recursive=1", "GET", () => 7)).toBe("https://x/y?recursive=1&cb=7");
	});

	it("leaves non-GET urls alone", () => {
		expect(cacheBustedUrl("https://x/y", "POST", () => 7)).toBe("https://x/y");
	});

	it("uses the real clock when none is injected", () => {
		expect(cacheBustedUrl("https://x/y", "GET")).toMatch(/\?cb=\d+$/);
	});
});

describe("lowercaseHeaders", () => {
	it("lowercases the keys and keeps the values", () => {
		expect(lowercaseHeaders({ "Retry-After": "2", "X-RateLimit-Remaining": "0" })).toEqual({
			"retry-after": "2",
			"x-ratelimit-remaining": "0",
		});
	});
});

describe("parentDirs", () => {
	it("returns every ancestor, shallowest first", () => {
		expect(parentDirs("a/b/c/file.md")).toEqual(["a", "a/b", "a/b/c"]);
	});

	it("returns nothing for a root-level file", () => {
		expect(parentDirs("file.md")).toEqual([]);
	});
});

describe("clampSyncMinutes", () => {
	it("maps zero, negatives, and non-numbers to off", () => {
		expect(clampSyncMinutes(0)).toBe(0);
		expect(clampSyncMinutes(-5)).toBe(0);
		expect(clampSyncMinutes(Number.NaN)).toBe(0);
	});

	it("clamps into the 3..60 contract and rounds", () => {
		expect(clampSyncMinutes(1)).toBe(3);
		expect(clampSyncMinutes(3)).toBe(3);
		expect(clampSyncMinutes(4.4)).toBe(4);
		expect(clampSyncMinutes(60)).toBe(60);
		expect(clampSyncMinutes(999)).toBe(60);
	});
});

describe("parseDeletionThreshold", () => {
	it("accepts whole non-negative numbers", () => {
		expect(parseDeletionThreshold("25")).toBe(25);
		expect(parseDeletionThreshold(" 0 ")).toBe(0);
		expect(parseDeletionThreshold(7)).toBe(7);
	});

	it("rejects blank, fractional, and invalid input, so only a typed 0 turns the guard off", () => {
		for (const v of ["", "   ", null, undefined, "abc", "-3", Number.NaN, "0.4", ".3", 7.6, "1e-9"]) {
			expect(parseDeletionThreshold(v)).toBeNull();
		}
	});
});

describe("maxDeletionsFor", () => {
	it("maps 0 to off and passes other thresholds through", () => {
		expect(maxDeletionsFor(0)).toBe(Infinity);
		expect(maxDeletionsFor(10)).toBe(10);
	});
});

describe("confirmOrDefer", () => {
	it("defers an unattended run without asking", async () => {
		let asked = 0;
		const ask = async () => ((asked += 1), "delete" as const);
		expect(await confirmOrDefer(true, ask)).toBe("defer");
		expect(asked).toBe(0);
	});

	it("asks when someone is there", async () => {
		expect(await confirmOrDefer(false, async () => "keep")).toBe("keep");
	});
});

describe("syncParts", () => {
	const pull = (o: Partial<PullSummary> = {}): PullSummary => ({
		upToDate: false, fetched: 0, placeholders: 0, adopted: 0, deleted: 0, merged: 0, conflicts: 0, kept: 0, ...o,
	});
	const push = (o: Partial<PushSummary> = {}): PushSummary => ({
		pushed: 0, deletedRemote: 0, skipped: 0, skippedPaths: [], commit: null, readded: 0, restored: 0, ...o,
	});

	it("says up to date only when nothing moved", () => {
		expect(syncParts(pull({ upToDate: true }), push())).toEqual(["already up to date"]);
		expect(syncParts(pull({ upToDate: true }), null)).toEqual(["already up to date"]);
		expect(syncParts(pull({ upToDate: true }), push({ commit: "c" }))).toEqual([]);
	});

	it("reports every count, including what Keep brought back", () => {
		expect(
			syncParts(
				pull({ fetched: 1, adopted: 2, placeholders: 3, merged: 4, deleted: 5, conflicts: 6, kept: 7 }),
				push({ pushed: 8, deletedRemote: 9, readded: 10, restored: 11, commit: "c" }),
			),
		).toEqual([
			"1 fetched", "2 adopted", "3 placeholders", "4 merged", "5 deleted here",
			"6 conflicts (see _conflicts/ and the log)", "7 kept here",
			"8 pushed", "9 deleted on GitHub", "10 kept files back on GitHub", "11 restored here",
		]);
	});

	it("names at most two skipped files", () => {
		expect(syncParts(pull(), push({ skipped: 3, skippedPaths: ["a", "b", "c"] }))).toEqual(["3 skipped (a, b, …)"]);
		expect(syncParts(pull(), push({ skipped: 1, skippedPaths: ["a"] }))).toEqual(["1 skipped (a)"]);
	});
});
