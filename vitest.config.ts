import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			exclude: ["*.test.ts", "**/node_modules/**", "**/dist/**"],
		},
		sequence: {
			concurrent: false,
		},
		testTimeout: 15_000,
	},
});