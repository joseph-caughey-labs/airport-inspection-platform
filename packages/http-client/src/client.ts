import { HttpClientError, isRetryableStatus } from "./errors.js";

export interface HttpClientOptions {
  /** Prepended to every request path. No trailing slash. */
  baseUrl: string;
  /** Default per-request timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Retry attempts beyond the first try. Default 3 (so up to 4 tries). */
  retries?: number;
  /** Base backoff in ms. Default 100. */
  retryBackoffMs?: number;
  /** Cap on per-attempt backoff in ms. Default 5_000. */
  retryMaxBackoffMs?: number;
  /**
   * Whether to apply jitter to backoff (50%–150% of computed value).
   * Default `true`. Turn off in tests for determinism.
   */
  jitter?: boolean;
  /** Default headers attached to every request. */
  defaultHeaders?: Record<string, string>;
  /** Override fetch (for tests). Default global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Sleep function. Override in tests for determinism.
   * Default: setTimeout-based.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Override the client-level timeout. */
  timeoutMs?: number;
  /** AbortSignal for caller-initiated cancellation. */
  signal?: AbortSignal;
}

export interface HttpClient {
  request: (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts?: RequestOptions,
  ) => Promise<Response>;
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retries = opts.retries ?? 3;
  const backoff = opts.retryBackoffMs ?? 100;
  const maxBackoff = opts.retryMaxBackoffMs ?? 5_000;
  const jitter = opts.jitter ?? true;
  const defaultHeaders = opts.defaultHeaders ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));

  function computeBackoff(attempt: number): number {
    const base = Math.min(backoff * 2 ** attempt, maxBackoff);
    if (!jitter) return base;
    return Math.floor(base * (0.5 + Math.random()));
  }

  async function attempt(
    method: string,
    url: string,
    body: unknown,
    headers: Record<string, string>,
    requestTimeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const finalHeaders: Record<string, string> = {
        ...defaultHeaders,
        ...headers,
      };
      const init: RequestInit = {
        method,
        headers: finalHeaders,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        finalHeaders["content-type"] ??= "application/json";
      }
      return await fetchImpl(url, init);
    } catch (err) {
      if (controller.signal.aborted && !callerSignal?.aborted) {
        throw new HttpClientError("timeout", `request timed out after ${requestTimeoutMs}ms`);
      }
      throw new HttpClientError("network", err instanceof Error ? err.message : "network error");
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    async request(method, path, requestOpts = {}) {
      const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const requestTimeoutMs = requestOpts.timeoutMs ?? timeoutMs;
      let lastError: HttpClientError | undefined;

      for (let i = 0; i <= retries; i++) {
        try {
          const res = await attempt(
            method,
            url,
            requestOpts.body,
            requestOpts.headers ?? {},
            requestTimeoutMs,
            requestOpts.signal,
          );

          if (res.ok) return res;

          if (!isRetryableStatus(res.status)) {
            throw new HttpClientError(
              `http_${res.status}` as `http_${number}`,
              `unexpected status ${res.status}`,
              { status: res.status, attempts: i + 1 },
            );
          }

          lastError = new HttpClientError(
            `http_${res.status}` as `http_${number}`,
            `retryable status ${res.status}`,
            { status: res.status, attempts: i + 1 },
          );
        } catch (err) {
          if (err instanceof HttpClientError && err.code.startsWith("http_")) {
            // already classified; non-retryable
            if (err.status !== undefined && !isRetryableStatus(err.status)) {
              throw err;
            }
            lastError = err;
          } else if (err instanceof HttpClientError) {
            lastError = err;
          } else {
            throw err;
          }
        }

        if (i < retries) await sleep(computeBackoff(i));
      }

      throw new HttpClientError("exhausted", `retries exhausted after ${retries + 1} attempts`, {
        attempts: retries + 1,
        ...(lastError?.status !== undefined ? { status: lastError.status } : {}),
      });
    },
  };
}
