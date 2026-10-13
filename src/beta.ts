/**
 * The beta manifest: every unfinished feature, what it does, and what it
 * writes or costs. The settings page, the "Show beta features" modal, and
 * the ribbon menu all read this one list.
 */
export interface BetaFeature {
	id: string;
	name: string;
	description: string;
	writes: string;
	commandId?: string; // shown in the ribbon menu while beta is on
}

export const BETA_FEATURES: BetaFeature[] = [];

export const NO_BETA_FEATURES = "No beta features in this version.";

/** One line per feature for the settings page and the modal. */
export function betaFeatureText(f: BetaFeature): string {
	return `${f.description} Writes: ${f.writes}`;
}

/** The ribbon menu, in order; beta commands only while beta is on. */
export function ribbonMenuItems(betaEnabled: boolean, features: BetaFeature[]): { title: string; commandId: string }[] {
	const items = [
		{ title: "Sync now", commandId: "sync-now" },
		{ title: "Preview sync", commandId: "preview-sync" },
		{ title: "Export sync log", commandId: "export-log" },
		{ title: "Show beta features", commandId: "show-beta-features" },
	];
	if (!betaEnabled) return items;
	for (const f of features) if (f.commandId) items.push({ title: f.name, commandId: f.commandId });
	return items;
}
