import type { DeletionDecision, PullSummary, PushSummary } from "./sync";

/**
 * Pure helpers for the Obsidian transport and wiring layer. They live here,
 * outside main.ts, so the coverage gate applies to them: the rate-limit retry
 * depends on lowercase headers, and every nested pull depends on the parent-
 * directory walk.
 */

/** Bust the iOS URL cache on reads: GitHub's max-age=60 serves stale refs. */
export function cacheBustedUrl(url: string, method: string, now: () => number = Date.now): string {
	if (method !== "GET") return url;
	return url + (url.includes("?") ? "&" : "?") + `cb=${now()}`;
}

/** GitHubClient reads rate-limit headers in lowercase. */
export function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Every ancestor directory of a normalized path, shallowest first. */
export function parentDirs(normPath: string): string[] {
	const parts = normPath.split("/").slice(0, -1);
	const out: string[] = [];
	for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

/** The auto-sync interval contract: 0 is off, anything else lands in 3..60. */
export function clampSyncMinutes(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(60, Math.max(3, Math.round(n)));
}

/**
 * A cleared, fractional, or invalid field is null, never 0: only a typed 0
 * turns the deletion guard off ("0.4" must not round down to off).
 */
export function parseDeletionThreshold(value: unknown): number | null {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The deletion guard setting contract: 0 is off. */
export function maxDeletionsFor(threshold: number): number {
	return threshold > 0 ? threshold : Infinity;
}

/** An unattended run (interval or startup) never asks: nobody is there to answer. */
export function confirmOrDefer(
	unattended: boolean,
	ask: () => Promise<DeletionDecision>,
): Promise<DeletionDecision> {
	return unattended ? Promise.resolve("defer") : ask();
}

/** The parts of a sync's completion Notice; "already up to date" only when nothing moved. */
export function syncParts(pull: PullSummary, push: PushSummary | null): string[] {
	const parts: string[] = [];
	if (pull.upToDate && (push === null || push.commit === null)) parts.push("already up to date");
	if (pull.fetched) parts.push(`${pull.fetched} fetched`);
	if (pull.adopted) parts.push(`${pull.adopted} adopted`);
	if (pull.placeholders) parts.push(`${pull.placeholders} placeholders`);
	if (pull.merged) parts.push(`${pull.merged} merged`);
	if (pull.deleted) parts.push(`${pull.deleted} deleted here`);
	if (pull.conflicts) parts.push(`${pull.conflicts} conflicts (see _conflicts/ and the log)`);
	if (pull.kept) parts.push(`${pull.kept} kept here`);
	if (push?.pushed) parts.push(`${push.pushed} pushed`);
	if (push?.deletedRemote) parts.push(`${push.deletedRemote} deleted on GitHub`);
	if (push?.readded) parts.push(`${push.readded} kept files back on GitHub`);
	if (push?.restored) parts.push(`${push.restored} restored here`);
	if (push && push.skipped > 0) {
		const names = push.skippedPaths.slice(0, 2).join(", ");
		parts.push(`${push.skipped} skipped (${names}${push.skippedPaths.length > 2 ? ", …" : ""})`);
	}
	return parts;
}
