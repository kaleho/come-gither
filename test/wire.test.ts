import { describe, expect, it } from "vitest";
import { cacheBustedUrl, clampSyncMinutes, lowercaseHeaders, parentDirs } from "../src/wire";

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
		expect(clampSyncMinutes(4.4)).toBe(4);
		expect(clampSyncMinutes(999)).toBe(60);
	});
});
