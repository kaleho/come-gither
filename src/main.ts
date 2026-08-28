import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath, requestUrl } from "obsidian";
import { GitHubClient } from "./github";
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

		// ponytail: temporary M1 spike command; delete after the spike report.
		this.addCommand({
			id: "m1-spike",
			name: "Run M1 spike (temporary)",
			callback: () => void this.runSpike(),
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async runSpike(): Promise<void> {
		const { owner, repo, branch, token } = this.settings;
		if (!owner || !repo || !token) {
			new Notice("Come Gither: fill in owner, repo, and token in settings first.");
			return;
		}
		const lines: string[] = [`# come-gither M1 spike — ${new Date().toISOString()}`, ""];
		const report = (line: string) => {
			lines.push(line);
			console.log(`come-gither spike: ${line}`);
		};
		const notice = new Notice("Spike: starting…", 0);
		try {
			const client = new GitHubClient(new ObsidianHttp(), { owner, repo, token });
			const mem = () => {
				const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
				return m ? ` heap=${(m.usedJSHeapSize / 1048576).toFixed(0)}MB` : "";
			};

			notice.setMessage("Spike: listing tree…");
			let t = Date.now();
			const head = await client.getRef(branch);
			const { treeSha } = await client.getCommit(head);
			const tree = await client.getTree(treeSha, true);
			report(`tree: ${tree.entries.length} entries, truncated=${tree.truncated}, ${Date.now() - t}ms${mem()}`);

			const blobs = tree.entries
				.filter((e) => e.type === "blob" && e.size !== undefined)
				.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
				.slice(0, 2);
			for (const blob of blobs) {
				notice.setMessage(`Spike: fetching ${blob.path}…`);
				t = Date.now();
				const data = await client.getBlobRaw(blob.sha as string);
				const fetched = Date.now() - t;
				const name = blob.path.split("/").pop() as string;
				const target = normalizePath(`_spike/${name}`);
				t = Date.now();
				await this.ensureFolder("_spike");
				await this.app.vault.adapter.writeBinary(target, data);
				report(
					`fetch ${blob.path}: ${(data.byteLength / 1048576).toFixed(1)}MB in ${fetched}ms, write ${Date.now() - t}ms${mem()}`,
				);
			}

			notice.setMessage("Spike: uploading 30MB blob…");
			const big = new Uint8Array(30 * 1048576);
			for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
			t = Date.now();
			const sha = await client.createBlob(big.buffer as ArrayBuffer);
			report(`createBlob 30MB: sha=${sha.slice(0, 12)} in ${Date.now() - t}ms${mem()}`);
			report("");
			report("RESULT: all spike steps passed.");
		} catch (e) {
			report(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
		} finally {
			notice.hide();
			const out = normalizePath("come-gither-spike.md");
			await this.app.vault.adapter.write(out, lines.join("\n"));
			new Notice(`Spike done — results in ${out}`);
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(normalizePath(path)))) {
			await adapter.mkdir(normalizePath(path));
		}
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
