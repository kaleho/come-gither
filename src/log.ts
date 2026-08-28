import type { Files } from "./ports";
import type { LogFn } from "./sync";

export class RingLogger {
	private lines: string[] = [];
	private sinceFlush = 0;
	private capacity: number;
	private flushEvery: number;
	private now: () => number;

	constructor(
		private files: Files,
		private path: string,
		opts: { capacity?: number; flushEvery?: number; now?: () => number } = {},
	) {
		this.capacity = opts.capacity ?? 2000;
		this.flushEvery = opts.flushEvery ?? 50;
		this.now = opts.now ?? (() => Date.now());
	}

	log: LogFn = (level, message) => {
		this.lines.push(`${new Date(this.now()).toISOString()} ${level} ${message}`);
		if (this.lines.length > this.capacity) this.lines.shift();
		this.sinceFlush += 1;
		if (this.sinceFlush >= this.flushEvery) {
			// Fire-and-forget: logging must never block or fail the caller.
			void this.flush().catch(() => {});
		}
	};

	dump(): string {
		return this.lines.join("\n");
	}

	async flush(): Promise<void> {
		this.sinceFlush = 0;
		const data = new TextEncoder().encode(this.dump());
		await this.files.writeBinary(this.path, data.buffer as ArrayBuffer);
	}
}
