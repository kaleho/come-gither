import { diff3Merge } from "node-diff3";

export function isUtf8Text(data: ArrayBuffer): boolean {
	const bytes = new Uint8Array(data);
	if (bytes.includes(0)) return false; // git's own text heuristic
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/** Three-way text merge. Returns the merged text, or null when the edits overlap. */
export function threeWayMerge(local: string, base: string, remote: string): string | null {
	const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"));
	const lines: string[] = [];
	for (const region of regions) {
		if (!region.ok) return null;
		lines.push(...region.ok);
	}
	return lines.join("\n");
}
