import { App, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type { Http, HttpRequest, HttpResponse } from "./ports";

interface ComeGitherSettings {
	owner: string;
	repo: string;
	branch: string;
	token: string;
}

const DEFAULT_SETTINGS: ComeGitherSettings = {
	owner: "",
	repo: "",
	branch: "master",
	token: "",
};

class ObsidianHttp implements Http {
	async request(req: HttpRequest): Promise<HttpResponse> {
		const res = await requestUrl({
			url: req.url,
			method: req.method ?? "GET",
			headers: req.headers,
			body: req.body,
			throw: false,
		});
		return {
			status: res.status,
			headers: Object.fromEntries(
				Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]),
			),
			arrayBuffer: res.arrayBuffer,
			text: res.text,
		};
	}
}

export default class ComeGitherPlugin extends Plugin {
	settings: ComeGitherSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
		this.addSettingTab(new ComeGitherSettingTab(this.app, this));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}


}

class ComeGitherSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ComeGitherPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const bind = (key: keyof ComeGitherSettings, name: string, desc: string) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text.setValue(this.plugin.settings[key]).onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					}),
				);
		bind("owner", "Repository owner", "The GitHub user or organization.");
		bind("repo", "Repository name", "The repository that holds your vault.");
		bind("branch", "Branch", "The branch to sync with.");
		bind("token", "Personal access token", "Fine-grained token with Contents read and write. Stored in plain text on this device.");
	}
}
