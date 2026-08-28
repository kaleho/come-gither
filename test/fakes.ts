import type { Http, HttpRequest, HttpResponse } from "../src/ports";

type Rule = {
	method: string;
	urlPart: string;
	response: Partial<HttpResponse>;
	times: number;
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Partial<HttpResponse> {
	const text = JSON.stringify(body);
	return { status, headers, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

export function binaryResponse(bytes: Uint8Array, status = 200): Partial<HttpResponse> {
	return { status, headers: {}, text: "", arrayBuffer: bytes.buffer as ArrayBuffer };
}

export class FakeHttp implements Http {
	requests: HttpRequest[] = [];
	private rules: Rule[] = [];

	on(method: string, urlPart: string, response: Partial<HttpResponse>, times = Infinity): void {
		this.rules.push({ method, urlPart, response, times });
	}

	async request(req: HttpRequest): Promise<HttpResponse> {
		this.requests.push(req);
		const method = (req.method ?? "GET").toUpperCase();
		const rule = this.rules.find(
			(r) => r.times > 0 && r.method.toUpperCase() === method && req.url.includes(r.urlPart),
		);
		if (!rule) throw new Error(`FakeHttp: no rule for ${method} ${req.url}`);
		rule.times -= 1;
		return {
			status: rule.response.status ?? 200,
			headers: rule.response.headers ?? {},
			text: rule.response.text ?? "",
			arrayBuffer: rule.response.arrayBuffer ?? new ArrayBuffer(0),
		};
	}

	bodyOf(index: number): Record<string, unknown> {
		return JSON.parse(this.requests[index].body as string);
	}
}

/** Virtual clock: sleep() advances time instantly and records the delay. */
export class FakeClock {
	t = 0;
	sleeps: number[] = [];
	sleep = async (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.t += ms;
	};
	now = (): number => this.t;
}
