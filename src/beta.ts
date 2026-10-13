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

export const BETA_FEATURES: BetaFeature[] = [
	{
		id: "lfs-test",
		name: "Test large file support",
		commandId: "lfs-test",
		description:
			"You pick a vault file. It checks whether this device and your token can send the file to GitHub's large file storage (Git LFS), the route for files over GitHub's 100 MB limit, and reports each step.",
		writes:
			"Uploads the chosen file to Git LFS in your repository. The file stays there and counts toward your LFS storage (10 GiB included on Free and Pro). Commits a pointer on a temporary branch, come-gither-lfs-test, and deletes the branch afterwards. Your sync branch is not changed.",
	},
	{
		// No command: it changes how sync behaves.
		id: "lfs-sync",
		name: "Sync large files with Git LFS",
		description:
			'Files over 100 MB (up to 2 GB, and within your "Largest upload (MB)" setting — raise it above 100 to use this) are pushed through Git LFS. LFS files from GitHub arrive as placeholders and download when you open them.',
		writes:
			"Uploads those files to Git LFS storage in your repository. They count toward your LFS quota (10 GiB storage and 10 GiB download per month included on Free and Pro). Adds one line per file to .gitattributes and never removes lines. Desktop git needs git-lfs installed to see these files.",
	},
];

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
