import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		"node_modules",
		"dist",
		"coverage",
		"tests",
		"esbuild.config.mjs",
		"eslint.config.js",
		"commitlint.config.js",
		"versions.json",
		"main.js",
		"scripts/version.mjs",
	]),
	// Disable overly strict sentence-case for placeholder text
	{
		files: ["src/settings.ts", "src/sync/ConflictHandler.ts"],
		rules: {
			"obsidianmd/ui/sentence-case": "off",
		},
	},
);
