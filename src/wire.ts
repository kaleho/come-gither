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
