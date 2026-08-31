import {
	App,
	ItemView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	requestUrl,
} from "obsidian";
import { GitHubClient } from "./github";
import { RingLogger } from "./log";
import type { Files, Http, HttpRequest, HttpResponse } from "./ports";
import { StateStore } from "./state";
import { DEFAULT_TEXT_EXTENSIONS, SyncEngine } from "./sync";
import type { PullSummary, PushSummary, SyncPlan } from "./sync";
import { cacheBustedUrl, clampSyncMinutes, lowercaseHeaders, parentDirs } from "./wire";

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

const MAX_PUSH_BYTES = 30 * 1048576;

class ObsidianHttp implements Http {
	async request(req: HttpRequest): Promise<HttpResponse> {
		const method = req.method ?? "GET";
		// The iOS URL cache honors GitHub's max-age=60 and serves stale refs
		// for up to a minute after a push, which breaks fast-forward updates.
		// Bust the cache per request and ask the cache layer to revalidate.
		const res = await requestUrl({
			url: cacheBustedUrl(req.url, method),
			method,
			headers: { "Cache-Control": "no-cache", ...req.headers },
			body: req.body,
			throw: false,
		});
		return {
			status: res.status,
			headers: lowercaseHeaders(res.headers),
			arrayBuffer: res.arrayBuffer,
			text: res.text,
		};
	}
}

// Deliberately uses Vault.adapter rather than the Vault API: sync must reach
// dot-paths (.obsidian/), needs raw ArrayBuffer I/O, and bulk writes during a
// pull should not churn the metadata cache file-by-file.
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
		for (const dir of parentDirs(norm)) {
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

class ConfirmFetchModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private path: string,
		private sizeBytes: number,
		private onConfirm: () => void,
		private onDone: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const mb = this.sizeBytes / 1048576;
		const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(this.sizeBytes / 1024))} KB`;
		this.contentEl.createEl("p", {
			text: `${this.path} is not on this device yet. Download the full file (${size})?`,
		});
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Download").setCta().onClick(() => {
					this.confirmed = true;
					this.close();
					this.onConfirm();
				}),
			)
			.addButton((b) => b.setButtonText("Not now").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone(this.confirmed);
	}
}

const PREVIEW_VIEW = "come-gither-preview";

const INCOMING_LABELS: Record<string, string> = {
	fetch: "Will download",
	placeholder: "Placeholder will be added",
	delete: "Will be deleted here",
	"both-changed": "Conflict: merge will be tried",
	"deleted-conflict": "Deleted here; the GitHub copy goes to _conflicts/",
	"keep-local": "Deleted on GitHub, kept here",
	adopt: "Already identical",
	overwrite: "GitHub version will be taken",
};
const OUTGOING_LABELS: Record<string, string> = {
	new: "New file",
	modified: "Changed",
	deleted: "Will be deleted on GitHub",
	"restore-placeholder": "Deleted placeholder will be restored",
	"skip-oversize": "Skipped: too large to push",
	"skip-placeholder": "Skipped: modified placeholder",
};
const REVERTIBLE = new Set(["new", "modified", "deleted"]);

class PreviewView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ComeGitherPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PREVIEW_VIEW;
	}

	getDisplayText(): string {
		return "Sync preview";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		await this.reload();
	}

	async reload(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { text: "Checking…" });
		let plan: SyncPlan;
		try {
			plan = await this.plugin.previewPlan();
		} catch (e) {
			el.empty();
			el.createEl("p", { text: `Preview failed: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		el.empty();
		const root = el.createDiv({ cls: "come-gither-preview" });

		const header = root.createDiv({ cls: "come-gither-preview-actions" });
		const syncBtn = header.createEl("button", { text: "Sync now" });
		syncBtn.addClass("mod-cta");
		syncBtn.addEventListener("click", () => {
			void this.plugin.runSync().then(() => this.reload());
		});
		const refreshBtn = header.createEl("button", { text: "Refresh" });
		refreshBtn.addEventListener("click", () => void this.reload());

		if (plan.incoming.length === 0 && plan.outgoing.length === 0) {
			root.createEl("p", {
				text: plan.headMoved
					? "No file changes. GitHub advanced without touching synced files; Sync now records the new baseline."
					: "Nothing to sync. Everything matches GitHub.",
			});
			return;
		}

		this.section(root, `Incoming from GitHub (${plan.incoming.length})`, plan.incoming, INCOMING_LABELS, null);
		this.section(root, `Outgoing to GitHub (${plan.outgoing.length})`, plan.outgoing, OUTGOING_LABELS, (row, item) => {
			if (!REVERTIBLE.has(item.action)) return;
			const btn = row.createEl("button", { text: "Revert" });
			btn.addEventListener("click", () => {
				btn.disabled = true;
				void this.plugin.revertPath(item.path).then(() => this.reload());
			});
		});
	}

	private section(
		root: HTMLElement,
		title: string,
		items: { path: string; action: string }[],
		labels: Record<string, string>,
		extra: ((row: HTMLElement, item: { path: string; action: string }) => void) | null,
	): void {
		if (items.length === 0) return;
		root.createEl("h4", { text: title });
		const list = root.createDiv({ cls: "come-gither-preview-list" });
		for (const item of items) {
			const row = list.createDiv({ cls: "come-gither-preview-row" });
			const info = row.createDiv({ cls: "come-gither-preview-info" });
			info.createDiv({ cls: "come-gither-preview-path", text: item.path });
			info.createDiv({ cls: "come-gither-preview-action", text: labels[item.action] ?? item.action });
			if (extra) extra(row, item);
		}
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
	// One engine + one StateStore for the whole plugin: every entry point shares
	// them, and the engine's internal lock serializes the operations. Two stores
	// over the same sync-state.json would clobber each other's flushes. The
	// PROMISE is cached, not the result, so concurrent first callers (the two
	// onLayoutReady kicks) can never each build their own engine. A settings
	// change retires the old engine, and the next use rebuilds lazily after the
	// retired engine's queue drains — one build per burst of keystrokes, and a
	// failed build clears the cache so the next call retries.
	private sessionPromise: Promise<{ engine: SyncEngine; state: StateStore }> | null = null;
	private pendingDrain: Promise<void> | null = null;
	private rebaselineNoticed = false;
	// Paths with an open download prompt or a download in flight; file-open
	// events for them are ignored so modals never stack.
	private busyPaths = new Set<string>();

	// Never hardcode ".obsidian": users can override the vault's config folder,
	// and with a custom folder a hardcoded path would leave the plugin's own
	// data.json (which holds the token) unexcluded from sync.
	private pluginDir!: string;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
		this.pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.vaultFiles = new AdapterFiles(this.app);
		this.logger = new RingLogger(this.vaultFiles, `${this.pluginDir}/log.txt`);
		await this.logger.init(); // keep the previous session's log for exports
		this.statusEl = this.addStatusBarItem();
		this.setStatus("idle");

		this.registerView(PREVIEW_VIEW, (leaf) => new PreviewView(leaf, this));
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
			id: "preview-sync",
			name: "Preview sync",
			callback: () => void this.openPreview(),
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
		// The engine's client config may have changed. Never drop a live engine:
		// retire it (new operations refuse; queued ones finish) and rebuild
		// lazily on next use, after the retired engine's queue drains. Two
		// engines can never run over the same files and state.
		this.rebaselineNoticed = false; // a settings change opens a new episode
		const old = this.sessionPromise;
		if (old !== null) {
			this.sessionPromise = null;
			const prevDrain = this.pendingDrain;
			this.pendingDrain = (async () => {
				if (prevDrain) await prevDrain;
				const previous = await old.catch(() => null);
				if (previous) {
					previous.engine.retire();
					await previous.engine.idle();
				}
			})();
		}
		this.applyAutoSyncInterval();
	}

	private applyAutoSyncInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		const minutes = clampSyncMinutes(this.settings.autoSyncMinutes);
		if (minutes > 0) {
			this.intervalId = window.setInterval(() => void this.runSync(false, true), minutes * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	private configured(): boolean {
		const { owner, repo, branch, token } = this.settings;
		return Boolean(owner && repo && branch && token);
	}

	private getSession(): Promise<{ engine: SyncEngine; state: StateStore }> {
		if (!this.sessionPromise) {
			const drain = this.pendingDrain;
			this.pendingDrain = null;
			const p = (async () => {
				if (drain) await drain;
				return this.buildSession();
			})();
			this.sessionPromise = p;
			// A failed build must not poison the cache: the next call retries.
			void p.catch(() => {
				if (this.sessionPromise === p) this.sessionPromise = null;
			});
		}
		return this.sessionPromise;
	}

	private async getEngine(): Promise<SyncEngine> {
		return (await this.getSession()).engine;
	}

	private async buildSession(): Promise<{ engine: SyncEngine; state: StateStore }> {
		const client = new GitHubClient(new ObsidianHttp(), {
			owner: this.settings.owner,
			repo: this.settings.repo,
			token: this.settings.token,
			log: this.logger.log,
		});
		const state = new StateStore(this.vaultFiles, `${this.pluginDir}/sync-state.json`);
		await state.load(`${this.settings.owner}/${this.settings.repo}#${this.settings.branch}`);
		if (state.rebaselined) {
			this.logger.log("warn", "sync state was unreadable or pointed at another repository; re-baselining");
			if (!this.rebaselineNoticed) {
				this.rebaselineNoticed = true; // once per cause, not per rebuild
				new Notice("Come Gither: sync state reset. The next sync re-scans the vault and can be slow.");
			}
		}
		const engine = new SyncEngine(client, this.vaultFiles, state, this.logger.log, {
			branch: this.settings.branch,
			textExtensions: DEFAULT_TEXT_EXTENSIONS,
			maxAutoFetchBytes: this.settings.maxAutoFetchMB * 1048576,
			maxPushBytes: MAX_PUSH_BYTES,
			conflictPolicy: this.settings.conflictPolicy,
			configDir: this.app.vault.configDir,
			excludedPrefixes: ["_conflicts/", `${this.pluginDir}/`, ".git/", ".trash/"],
		});
		return { engine, state };
	}

	async openPreview(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(PREVIEW_VIEW)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			await (existing.view as PreviewView).reload();
			return;
		}
		await this.app.workspace.getLeaf(true).setViewState({ type: PREVIEW_VIEW, active: true });
	}

	async previewPlan(): Promise<SyncPlan> {
		const engine = await this.getEngine();
		return engine.preview();
	}

	async revertPath(path: string): Promise<void> {
		try {
			const engine = await this.getEngine();
			const result = await engine.revert(path);
			new Notice(
				result === "reverted-new"
					? `Come Gither: reverted ${path}. A copy is in _conflicts/.`
					: result === "reverted"
						? `Come Gither: reverted ${path}.`
						: `Come Gither: ${path} has no local changes.`,
			);
		} catch (e) {
			new Notice(`Come Gither: revert failed — ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			await this.logger.flush();
		}
	}

	async runSync(startup = false, quiet = startup): Promise<void> {
		if (this.syncing) {
			if (!quiet) new Notice("Come Gither: a sync is already running.");
			return;
		}
		if (!this.configured()) {
			if (!quiet) new Notice("Come Gither: fill in the repository settings first.");
			return;
		}
		this.syncing = true;
		this.setStatus("syncing…");
		// The status bar is not shown on mobile, so a manual sync announces
		// itself; interval and startup runs stay quiet.
		if (!quiet) new Notice("Come Gither: syncing…");
		try {
			const engine = await this.getEngine();
			// Startup honors the "Pull when Obsidian starts" toggle literally:
			// it never pushes local edits or deletions without a command.
			let pull: PullSummary;
			let push: PushSummary | null = null;
			if (startup) {
				pull = await engine.pull();
			} else {
				({ pull, push } = await engine.sync());
			}
			await this.refreshLazyIndex();
			const parts: string[] = [];
			if (pull.upToDate && (push === null || push.commit === null)) parts.push("already up to date");
			if (pull.fetched) parts.push(`${pull.fetched} fetched`);
			if (pull.adopted) parts.push(`${pull.adopted} adopted`);
			if (pull.placeholders) parts.push(`${pull.placeholders} placeholders`);
			if (pull.merged) parts.push(`${pull.merged} merged`);
			if (pull.deleted) parts.push(`${pull.deleted} deleted here`);
			if (pull.conflicts) parts.push(`${pull.conflicts} conflicts (see _conflicts/ and the log)`);
			if (push?.pushed) parts.push(`${push.pushed} pushed`);
			if (push?.deletedRemote) parts.push(`${push.deletedRemote} deleted on GitHub`);
			if (push && push.skipped > 0) {
				const names = push.skippedPaths.slice(0, 2).join(", ");
				parts.push(`${push.skipped} skipped (${names}${push.skippedPaths.length > 2 ? ", …" : ""})`);
			}
			// A quiet run reports only real work; "already up to date" every
			// interval tick would be noise.
			const happened = parts.some((p) => p !== "already up to date");
			if (!quiet || happened) new Notice(`Come Gither: ${parts.join(", ") || "done"}.`);
			this.rebaselineNoticed = false; // a finished sync closes the episode
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
		// Use the resolved session, never a re-read of the mutable field: a
		// settings save can swap it between the await and the read.
		const { state } = await this.getSession();
		this.lazySizes.clear();
		for (const [path, entry] of Object.entries(state.state.files)) {
			if (entry.lazy) this.lazySizes.set(path, entry.remoteSize ?? 0);
		}
	}

	private async maybeFetchLazy(file: TFile): Promise<void> {
		if (!this.lazySizes.has(file.path)) {
			// Diagnostic: a zero-byte file that is not tracked as lazy is a stale stub.
			const stat = await this.vaultFiles.stat(file.path);
			if (stat?.size === 0) {
				this.logger.log(
					"warn",
					`opened zero-byte ${file.path} but it is not tracked as lazy (${this.lazySizes.size} lazy entries known)`,
				);
			}
			return;
		}
		// A running sync is no reason to ignore the open: the engine lock queues
		// the download safely behind it, and downloadAndOpen says so.
		if (this.busyPaths.has(file.path)) return; // a prompt is open or a download runs
		this.logger.log("info", `opened placeholder ${file.path} (mode: ${this.settings.lazyFetchMode})`);
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (this.settings.lazyFetchMode === "auto") {
			await this.downloadAndOpen(file.path, leaf ?? undefined);
			return;
		}
		this.busyPaths.add(file.path);
		new ConfirmFetchModal(
			this.app,
			file.path,
			this.lazySizes.get(file.path) as number,
			() => void this.downloadAndOpen(file.path, leaf ?? undefined),
			(confirmed) => {
				// A dismissed prompt frees the path; a confirmed one stays busy
				// until the download settles in downloadAndOpen's finally.
				if (!confirmed) this.busyPaths.delete(file.path);
			},
		).open();
	}

	async downloadAndOpen(path: string, leaf?: WorkspaceLeaf): Promise<void> {
		this.busyPaths.add(path);
		try {
			if (this.syncing) {
				this.logger.log("info", `download of ${path} queued behind the running sync`);
				new Notice("Come Gither: the download starts when the running sync finishes.");
			}
			const engine = await this.getEngine();
			const result = await engine.fetchLazy(path);
			if (result === "fetched") {
				this.lazySizes.delete(path);
				// getAbstractFileByPath, not getFileByPath: the latter needs
				// Obsidian 1.5.7 and the manifest promises 1.5.0.
				const abstract = this.app.vault.getAbstractFileByPath(path);
				const file = abstract instanceof TFile ? abstract : null;
				if (file) {
					// Reload every view showing the old stub, so no stale buffer
					// can save empty content back over the fetched file.
					const showing: WorkspaceLeaf[] = [];
					this.app.workspace.iterateAllLeaves((l) => {
						if ((l.view as { file?: TFile }).file?.path === path) showing.push(l);
					});
					for (const l of showing) await l.openFile(file);
					if (showing.length === 0 && leaf) await leaf.openFile(file);
					else if (showing.length === 0) new Notice(`Come Gither: downloaded ${path}.`);
				} else {
					new Notice(`Come Gither: downloaded ${path}.`);
				}
			} else if (result === "modified") {
				new Notice(`Come Gither: ${path} was changed locally; not overwriting it.`);
			} else {
				await this.refreshLazyIndex();
				const still = await this.vaultFiles.stat(path);
				new Notice(
					still === null
						? `Come Gither: ${path} was removed on GitHub by the last sync.`
						: `Come Gither: ${path} is already downloaded.`,
				);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logger.log("error", `download of ${path} failed: ${message}`);
			new Notice(`Come Gither: download failed — ${message}`);
		} finally {
			this.busyPaths.delete(path);
			await this.logger.flush();
		}
	}

	private detachLeavesShowing(path: string): void {
		// An open view still holds the full pre-evict content in its buffer; a
		// later save would silently write it back over the stub. Close it.
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const shown = (leaf.view as { file?: TFile }).file;
			if (shown?.path === path) leaves.push(leaf);
		});
		for (const leaf of leaves) leaf.detach();
	}

	private async evictFile(file: TFile): Promise<void> {
		try {
			const engine = await this.getEngine();
			const result = await engine.evict(file.path);
			if (result === "evicted") {
				await this.refreshLazyIndex(); // index first: a detach can re-focus the path
				this.detachLeavesShowing(file.path);
				// A dirty editor buffer can save itself while its view closes,
				// writing the full content back over the stub. Verify and redo.
				// A retire mid-evict must not turn the finished evict into an
				// error Notice; the next sync heals the entry either way.
				const stat = await this.vaultFiles.stat(file.path);
				if (stat && stat.size > 0) {
					await engine.revert(file.path).catch((e) => {
						const message = e instanceof Error ? e.message : String(e);
						// A retire mid-command is expected; anything else is logged.
						if (!message.includes("retired")) {
							this.logger.log("error", `re-stub of ${file.path} after evict failed: ${message}`);
						}
					});
				}
				new Notice(`Come Gither: removed the local copy of ${file.name}. It stays on GitHub.`);
			} else if (result === "modified") {
				new Notice(`Come Gither: ${file.name} has unpushed changes. Sync first.`);
			} else {
				new Notice(`Come Gither: ${file.name} is not a downloaded synced file.`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logger.log("error", `evict of ${file.path} failed: ${message}`);
			new Notice(`Come Gither: could not remove the local copy — ${message}`);
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
			.setDesc("Opening an unfetched file asks first, or downloads at once.")
			.addDropdown((d) =>
				d
					.addOptions({ prompt: "Ask first", auto: "Download immediately" })
					.setValue(s.lazyFetchMode)
					.onChange((v) => ((s.lazyFetchMode = v as "prompt" | "auto"), save())),
			);
		new Setting(containerEl)
			.setName("Largest automatic download (MB)")
			.setDesc("Text files above this size, and all binary files, stay placeholders until you open them.")
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
						s.autoSyncMinutes = clampSyncMinutes(n);
						save();
					}
				}),
			);
		new Setting(containerEl)
			.setName("Pull when Obsidian starts")
			.addToggle((t) => t.setValue(s.pullOnStart).onChange((v) => ((s.pullOnStart = v), save())));
	}
}
