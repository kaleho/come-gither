import { describe, expect, it } from "vitest";
import { isUtf8Text, threeWayMerge } from "../src/merge";

describe("isUtf8Text", () => {
	it("accepts plain text", () => {
		expect(isUtf8Text(new TextEncoder().encode("hello wörld").buffer as ArrayBuffer)).toBe(true);
	});

	it("rejects content with NUL bytes", () => {
		expect(isUtf8Text(new Uint8Array([104, 0, 105]).buffer as ArrayBuffer)).toBe(false);
	});

	it("rejects invalid UTF-8", () => {
		expect(isUtf8Text(new Uint8Array([0xff, 0xfe, 0x41]).buffer as ArrayBuffer)).toBe(false);
	});
});

describe("threeWayMerge", () => {
	it("merges edits on different lines", () => {
		const base = "one\ntwo\nthree\nfour\nfive";
		const local = "ONE\ntwo\nthree\nfour\nfive";
		const remote = "one\ntwo\nthree\nfour\nFIVE";
		expect(threeWayMerge(local, base, remote)).toBe("ONE\ntwo\nthree\nfour\nFIVE");
	});

	it("returns null when edits overlap", () => {
		expect(threeWayMerge("local", "base", "remote")).toBe(null);
	});

	it("keeps an identical no-op merge intact", () => {
		expect(threeWayMerge("same\ntext", "same\ntext", "same\ntext")).toBe("same\ntext");
	});
});
