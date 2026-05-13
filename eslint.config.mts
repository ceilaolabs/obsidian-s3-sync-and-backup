import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Obsidian-provided globals for popout-window compatibility.
				// `activeDocument` resolves to the focused document (main or
				// popout) and `activeWindow` to the focused window. The lint
				// rules in `eslint-plugin-obsidianmd` push code toward these
				// over the bare `document` / `window`.
				activeDocument: "readonly",
				activeWindow: "readonly",
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
	// Enable sentence-case with MinIO as a recognized brand
	{
		files: ["src/**/*.ts"],
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: ["MinIO"],
			}],
		},
	},
);
