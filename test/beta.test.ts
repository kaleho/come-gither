import { describe, expect, it } from "vitest";
import { BETA_FEATURES, betaFeatureText, ribbonMenuItems } from "../src/beta";
import type { BetaFeature } from "../src/beta";

const CORE = [
	{ title: "Sync now", commandId: "sync-now" },
	{ title: "Preview sync", commandId: "preview-sync" },
	{ title: "Export sync log", commandId: "export-log" },
	{ title: "Show beta features", commandId: "show-beta-features" },
];

const withCommand: BetaFeature = {
	id: "a",
	name: "Feature A",
	description: "Does A.",
	writes: "A file under _a/.",
	commandId: "beta-a",
};
const withoutCommand: BetaFeature = { id: "b", name: "Feature B", description: "Does B.", writes: "Nothing." };

describe("BETA_FEATURES", () => {
	it("lists the LFS test command, shown in the ribbon menu only while beta is on", () => {
		const f = BETA_FEATURES.find((x) => x.id === "lfs-test");
		expect(f).toMatchObject({ name: "Test large file support", commandId: "lfs-test" });
		expect(f?.description).toMatch(/Git LFS/);
		expect(f?.writes).toMatch(/come-gither-lfs-test/);
		expect(ribbonMenuItems(true, BETA_FEATURES)).toContainEqual({ title: "Test large file support", commandId: "lfs-test" });
		expect(ribbonMenuItems(false, BETA_FEATURES)).toEqual(CORE);
	});
});

describe("BETA_FEATURES: LFS sync", () => {
	it("is out of beta: only the LFS test command stays listed", () => {
		expect(BETA_FEATURES.map((f) => f.id)).toEqual(["lfs-test"]);
	});
});

describe("ribbonMenuItems", () => {
	it("lists the core commands in order with an empty manifest", () => {
		expect(ribbonMenuItems(true, [])).toEqual(CORE);
		expect(ribbonMenuItems(false, [])).toEqual(CORE);
	});

	it("hides beta commands while beta is off", () => {
		expect(ribbonMenuItems(false, [withCommand, withoutCommand])).toEqual(CORE);
	});

	it("appends each beta feature that has a command while beta is on", () => {
		expect(ribbonMenuItems(true, [withoutCommand, withCommand])).toEqual([
			...CORE,
			{ title: "Feature A", commandId: "beta-a" },
		]);
	});
});

describe("betaFeatureText", () => {
	it("joins what the feature does and what it writes", () => {
		expect(betaFeatureText(withCommand)).toBe("Does A. Writes: A file under _a/.");
	});
});
