import { Plugin } from "obsidian";

export default class ComeGitherPlugin extends Plugin {
	async onload(): Promise<void> {
		console.log("come-gither: loaded");
	}

	onunload(): void {
		console.log("come-gither: unloaded");
	}
}
