export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, body, headers };
  }
}

export async function withRetry(
  client: HttpClient,
  req: HttpRequest,
  opts: { retries?: number; retryOn?: number[] } = {}
): Promise<HttpResponse> {
  const retries = opts.retries ?? 3;
  const retryOn = opts.retryOn ?? [429, 500, 502, 503, 504];
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await client.request(req);
    if (!retryOn.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
  return last as HttpResponse;
}

export type CoverageMap = Record<string, "OK" | "PARTIAL" | "NOT_AVAILABLE" | "ERROR" | "UNAUTHORIZED">;

export function emptyCoverage(): CoverageMap {
  return {
    workItems: "NOT_AVAILABLE",
    comments: "NOT_AVAILABLE",
    revisions: "NOT_AVAILABLE",
    relations: "NOT_AVAILABLE",
    attachments: "NOT_AVAILABLE",
    pullRequests: "NOT_AVAILABLE",
    builds: "NOT_AVAILABLE",
    deployments: "NOT_AVAILABLE"
  };
}
