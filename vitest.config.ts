import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// main.ts and ports.ts need the Obsidian runtime; covered by hand-testing.
			exclude: ["src/main.ts", "src/ports.ts"],
			thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
		},
	},
});
