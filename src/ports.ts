// The seams between pure sync logic and the Obsidian runtime.
// Production implementations (requestUrl, Vault.adapter) are wired in main.ts.

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

export interface Http {
	request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Files {
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	stat(path: string): Promise<{ mtime: number; size: number } | null>;
	listRecursive(prefix: string): Promise<string[]>;
	remove(path: string): Promise<void>;
}
