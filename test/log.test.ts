import { describe, expect, it } from "vitest";
import { RingLogger } from "../src/log";
import { MemFiles } from "./fakes";

const PATH = ".obsidian/plugins/come-gither/log.txt";

describe("RingLogger", () => {
	it("records level, message, and timestamp", () => {
		const logger = new RingLogger(new MemFiles(), PATH, { now: () => 1000 });
		logger.log("warn", "something odd");
		expect(logger.dump()).toBe("1970-01-01T00:00:01.000Z warn something odd");
	});

	it("drops the oldest entries past capacity", () => {
		const logger = new RingLogger(new MemFiles(), PATH, { capacity: 3, now: () => 0 });
		for (let i = 1; i <= 5; i++) logger.log("info", `m${i}`);
		const lines = logger.dump().split("\n");
		expect(lines.length).toBe(3);
		expect(lines[0]).toContain("m3");
		expect(lines[2]).toContain("m5");
	});

	it("flushes automatically every flushEvery entries", async () => {
		const files = new MemFiles();
		const logger = new RingLogger(files, PATH, { flushEvery: 5, now: () => 0 });
		for (let i = 0; i < 4; i++) logger.log("info", "x");
		await Promise.resolve();
		expect(files.writes).toEqual([]);
		logger.log("info", "fifth");
		await Promise.resolve();
		expect(files.writes).toEqual([PATH]);
		expect(files.readText(PATH)).toContain("fifth");
	});

	it("flush writes the current buffer to the log file", async () => {
		const files = new MemFiles();
		const logger = new RingLogger(files, PATH, { now: () => 0 });
		logger.log("error", "boom");
		await logger.flush();
		expect(files.readText(PATH)).toBe("1970-01-01T00:00:00.000Z error boom");
	});

	it("seeds the ring from the previous session's file", async () => {
		const files = new MemFiles();
		files.writeText(PATH, "old line 1\nold line 2");
		const logger = new RingLogger(files, PATH, { now: () => 0 });
		logger.log("info", "early");
		await logger.init();
		logger.log("info", "later");
		expect(logger.dump().split("\n")).toEqual([
			"old line 1",
			"old line 2",
			"--- session start ---",
			"1970-01-01T00:00:00.000Z info early",
			"1970-01-01T00:00:00.000Z info later",
		]);
		// The next flush keeps the history instead of erasing the crash evidence.
		await logger.flush();
		expect(files.readText(PATH)).toContain("old line 1");
	});

	it("caps the seeded history at capacity", async () => {
		const files = new MemFiles();
		files.writeText(PATH, Array.from({ length: 10 }, (_, i) => `o${i}`).join("\n"));
		const logger = new RingLogger(files, PATH, { capacity: 4, now: () => 0 });
		await logger.init();
		const lines = logger.dump().split("\n");
		expect(lines).toEqual(["o7", "o8", "o9", "--- session start ---"]);
	});

	it("init tolerates a missing previous log", async () => {
		const logger = new RingLogger(new MemFiles(), PATH, { now: () => 0 });
		await logger.init();
		logger.log("info", "x");
		expect(logger.dump()).toContain("info x");
		expect(logger.dump()).not.toContain("session start");
	});

	it("uses the real clock when none is injected", async () => {
		const files = new MemFiles();
		const logger = new RingLogger(files, PATH);
		logger.log("info", "hello");
		expect(logger.dump()).toMatch(/^20\d\d-.*Z info hello$/);
	});
});
