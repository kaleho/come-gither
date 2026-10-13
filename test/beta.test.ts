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
	it("starts empty", () => {
		expect(BETA_FEATURES).toEqual([]);
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
