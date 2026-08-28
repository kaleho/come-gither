import {
	App,
	ItemView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	normalizePath,
	requestUrl,
} from "obsidian";
import { GitHubClient } from "./github";
import { RingLogger } from "./log";
import type { Files, Http, HttpRequest, HttpResponse } from "./ports";
import { StateStore } from "./state";
import { DEFAULT_TEXT_EXTENSIONS, SyncEngine } from "./sync";

interface ComeGitherSettings {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	conflictPolicy: "merge" | "remote-wins";
	lazyFetchMode: "prompt" | "auto";
	maxAutoFetchMB: number;
	autoSyncMinutes: number; // 0 = off; otherwise clamped to 3..60
	pullOnStart: boolean;
}

const DEFAULT_SETTINGS: ComeGitherSettings = {
	owner: "",
	repo: "",
	branch: "main",
	token: "",
	conflictPolicy: "merge",
	lazyFetchMode: "prompt",
	maxAutoFetchMB: 100,
	autoSyncMinutes: 0,
	pullOnStart: true,
};

const PLUGIN_DIR = ".obsidian/plugins/come-gither";
const MAX_PUSH_BYTES = 30 * 1048576;

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

class AdapterFiles implements Files {
	constructor(private app: App) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(normalizePath(path));
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const norm = normalizePath(path);
		const parts = norm.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
		}
		await this.adapter.writeBinary(norm, data);
	}

	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const s = await this.adapter.stat(normalizePath(path));
		if (!s || s.type !== "file") return null;
		return { mtime: s.mtime, size: s.size };
	}

	async listRecursive(prefix: string): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = await this.adapter.list(dir);
			out.push(...listing.files);
			for (const sub of listing.folders) await walk(sub);
		};
		await walk(normalizePath(prefix === "" ? "/" : prefix));
		return out;
	}

	async remove(path: string): Promise<void> {
		await this.adapter.remove(normalizePath(path));
	}
}

const PLACEHOLDER_VIEW = "come-gither-placeholder";

class PlaceholderView extends ItemView {
	private path = "";
	private sizeBytes = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ComeGitherPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PLACEHOLDER_VIEW;
	}

	getDisplayText(): string {
		return this.path.split("/").pop() ?? "Not downloaded";
	}

	getIcon(): string {
		return "cloud-download";
	}

	async setState(state: { path?: string; sizeBytes?: number }, result: ViewStateResult): Promise<void> {
		this.path = state.path ?? "";
		this.sizeBytes = state.sizeBytes ?? 0;
		this.render();
		return super.setState(state, result);
	}

	getState(): { path: string; sizeBytes: number } {
		return { path: this.path, sizeBytes: this.sizeBytes };
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const wrap = el.createDiv({ cls: "come-gither-placeholder" });
		wrap.createEl("h3", { text: this.getDisplayText() });
		const mb = this.sizeBytes / 1048576;
		wrap.createEl("p", {
			text: `This file (${mb >= 1 ? mb.toFixed(1) + " MB" : Math.max(1, Math.round(this.sizeBytes / 1024)) + " KB"}) is not on this device yet.`,
		});
		const button = wrap.createEl("button", { text: "Download and open" });
		button.addClass("mod-cta");
		button.addEventListener("click", () => {
			button.disabled = true;
			button.setText("Downloading…");
			void this.plugin.downloadAndOpen(this.path, this.leaf).catch(() => {
				button.disabled = false;
				button.setText("Download and open");
			});
		});
	}
}

export default class ComeGitherPlugin extends Plugin {
	settings: ComeGitherSettings = { ...DEFAULT_SETTINGS };
	private logger!: RingLogger;
	private vaultFiles!: AdapterFiles;
	private statusEl: HTMLElement | null = null;
	private syncing = false;
	private lazySizes = new Map<string, number>();
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
		this.vaultFiles = new AdapterFiles(this.app);
		this.logger = new RingLogger(this.vaultFiles, `${PLUGIN_DIR}/log.txt`);
		this.statusEl = this.addStatusBarItem();
		this.setStatus("idle");

		this.registerView(PLACEHOLDER_VIEW, (leaf) => new PlaceholderView(leaf, this));
		this.addSettingTab(new ComeGitherSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.runSync(),
		});
		this.addCommand({
			id: "export-log",
			name: "Export sync log",
			callback: () => void this.exportLog(),
		});
		this.addCommand({
			id: "evict-file",
			name: "Remove local copy (keep on GitHub)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.evictFile(file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) void this.maybeFetchLazy(file);
			}),
		);

		this.applyAutoSyncInterval();

		this.app.workspace.onLayoutReady(() => {
			void this.refreshLazyIndex();
			if (this.settings.pullOnStart && this.configured()) void this.runSync(true);
		});
	}

	onunload(): void {
		void this.logger.flush();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applyAutoSyncInterval();
	}

	private applyAutoSyncInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.settings.autoSyncMinutes > 0) {
			const minutes = Math.min(60, Math.max(3, this.settings.autoSyncMinutes));
			this.intervalId = window.setInterval(() => void this.runSync(), minutes * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	private configured(): boolean {
		const { owner, repo, branch, token } = this.settings;
		return Boolean(owner && repo && branch && token);
	}

	private async makeEngine(): Promise<SyncEngine> {
		const client = new GitHubClient(new ObsidianHttp(), {
			owner: this.settings.owner,
			repo: this.settings.repo,
			token: this.settings.token,
		});
		const state = new StateStore(this.vaultFiles, `${PLUGIN_DIR}/sync-state.json`);
		await state.load();
		return new SyncEngine(client, this.vaultFiles, state, this.logger.log, {
			branch: this.settings.branch,
			textExtensions: DEFAULT_TEXT_EXTENSIONS,
			maxAutoFetchBytes: this.settings.maxAutoFetchMB * 1048576,
			maxPushBytes: MAX_PUSH_BYTES,
			conflictPolicy: this.settings.conflictPolicy,
		});
	}

	private async runSync(startup = false): Promise<void> {
		if (this.syncing) {
			new Notice("Come Gither: a sync is already running.");
			return;
		}
		if (!this.configured()) {
			if (!startup) new Notice("Come Gither: fill in the repository settings first.");
			return;
		}
		this.syncing = true;
		this.setStatus("syncing…");
		try {
			const engine = await this.makeEngine();
			const { pull, push } = await engine.sync();
			await this.refreshLazyIndex();
			const parts: string[] = [];
			if (pull.upToDate && push.commit === null) parts.push("already up to date");
			if (pull.fetched) parts.push(`${pull.fetched} fetched`);
			if (pull.placeholders) parts.push(`${pull.placeholders} placeholders`);
			if (pull.merged) parts.push(`${pull.merged} merged`);
			if (pull.deleted) parts.push(`${pull.deleted} deleted here`);
			if (pull.conflicts) parts.push(`${pull.conflicts} conflicts (see _conflicts/)`);
			if (push.pushed) parts.push(`${push.pushed} pushed`);
			if (push.deletedRemote) parts.push(`${push.deletedRemote} deleted on GitHub`);
			if (push.skipped) parts.push(`${push.skipped} skipped`);
			new Notice(`Come Gither: ${parts.join(", ") || "done"}.`);
			this.setStatus("idle");
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logger.log("error", `sync failed: ${message}`);
			new Notice(`Come Gither: sync failed — ${message}`);
			this.setStatus("error");
		} finally {
			await this.logger.flush();
			this.syncing = false;
		}
	}

	private async refreshLazyIndex(): Promise<void> {
		const state = new StateStore(this.vaultFiles, `${PLUGIN_DIR}/sync-state.json`);
		await state.load();
		this.lazySizes.clear();
		for (const [path, entry] of Object.entries(state.state.files)) {
			if (entry.lazy) this.lazySizes.set(path, entry.remoteSize ?? 0);
		}
	}

	private async maybeFetchLazy(file: TFile): Promise<void> {
		if (!this.lazySizes.has(file.path) || this.syncing) return;
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (this.settings.lazyFetchMode === "auto") {
			await this.downloadAndOpen(file.path, leaf ?? undefined);
			return;
		}
		// Replace the broken binary viewer with the placeholder view in the same tab.
		if (leaf) {
			await leaf.setViewState({
				type: PLACEHOLDER_VIEW,
				active: true,
				state: { path: file.path, sizeBytes: this.lazySizes.get(file.path) },
			});
		}
	}

	async downloadAndOpen(path: string, leaf?: WorkspaceLeaf): Promise<void> {
		try {
			const engine = await this.makeEngine();
			const result = await engine.fetchLazy(path);
			if (result === "fetched") {
				this.lazySizes.delete(path);
				const file = this.app.vault.getFileByPath(path);
				if (file && leaf) await leaf.openFile(file);
				else new Notice(`Come Gither: downloaded ${path}.`);
			} else if (result === "modified") {
				new Notice(`Come Gither: ${path} was changed locally; not overwriting it.`);
			}
		} catch (e) {
			new Notice(`Come Gither: download failed — ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		} finally {
			await this.logger.flush();
		}
	}

	private async evictFile(file: TFile): Promise<void> {
		try {
			const engine = await this.makeEngine();
			const result = await engine.evict(file.path);
			if (result === "evicted") {
				await this.refreshLazyIndex();
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (leaf && this.app.workspace.getActiveFile()?.path === file.path) {
					await leaf.setViewState({
						type: PLACEHOLDER_VIEW,
						active: true,
						state: { path: file.path, sizeBytes: this.lazySizes.get(file.path) ?? 0 },
					});
				}
				new Notice(`Come Gither: removed the local copy of ${file.name}. It stays on GitHub.`);
			} else if (result === "modified") {
				new Notice(`Come Gither: ${file.name} has unpushed changes. Sync first.`);
			} else {
				new Notice(`Come Gither: ${file.name} is not a downloaded synced file.`);
			}
		} finally {
			await this.logger.flush();
		}
	}

	private async exportLog(): Promise<void> {
		await this.logger.flush();
		const target = normalizePath(`come-gither-log-${new Date().toISOString().slice(0, 10)}.md`);
		const body = `# Come Gither sync log\n\n\`\`\`\n${this.logger.dump()}\n\`\`\`\n`;
		await this.vaultFiles.writeBinary(target, new TextEncoder().encode(body).buffer as ArrayBuffer);
		new Notice(`Come Gither: log exported to ${target}.`);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(`cg: ${text}`);
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
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Repository owner")
			.setDesc("The GitHub user or organization.")
			.addText((t) => t.setValue(s.owner).onChange((v) => ((s.owner = v.trim()), save())));
		new Setting(containerEl)
			.setName("Repository name")
			.setDesc("The repository that holds your vault.")
			.addText((t) => t.setValue(s.repo).onChange((v) => ((s.repo = v.trim()), save())));
		new Setting(containerEl)
			.setName("Branch")
			.setDesc("The branch to sync with.")
			.addText((t) => t.setValue(s.branch).onChange((v) => ((s.branch = v.trim()), save())));
		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc("Fine-grained token with Contents read and write. Stored in plain text on this device only.")
			.addText((t) => t.setValue(s.token).onChange((v) => ((s.token = v.trim()), save())));

		new Setting(containerEl)
			.setName("Conflict policy")
			.setDesc("Merge tries a three-way merge and saves the remote copy of unresolved conflicts under _conflicts/. Remote wins takes the server version.")
			.addDropdown((d) =>
				d
					.addOptions({ merge: "Merge", "remote-wins": "Remote wins" })
					.setValue(s.conflictPolicy)
					.onChange((v) => ((s.conflictPolicy = v as "merge" | "remote-wins"), save())),
			);
		new Setting(containerEl)
			.setName("Placeholder downloads")
			.setDesc("Opening an unfetched file shows a download page, or downloads at once.")
			.addDropdown((d) =>
				d
					.addOptions({ prompt: "Show a download page", auto: "Download immediately" })
					.setValue(s.lazyFetchMode)
					.onChange((v) => ((s.lazyFetchMode = v as "prompt" | "auto"), save())),
			);
		new Setting(containerEl)
			.setName("Largest automatic download (MB)")
			.setDesc("Files above this size stay placeholders until you open them.")
			.addText((t) =>
				t.setValue(String(s.maxAutoFetchMB)).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n > 0) {
						s.maxAutoFetchMB = n;
						save();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Automatic sync interval (minutes)")
			.setDesc("0 turns it off. Between 3 and 60 otherwise.")
			.addText((t) =>
				t.setValue(String(s.autoSyncMinutes)).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0) {
						s.autoSyncMinutes = n === 0 ? 0 : Math.min(60, Math.max(3, Math.round(n)));
						save();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Pull when Obsidian starts")
			.addToggle((t) => t.setValue(s.pullOnStart).onChange((v) => ((s.pullOnStart = v), save())));
	}
}
