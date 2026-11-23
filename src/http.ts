/**
 * Núcleo HTTP: autenticação, timeout, novas tentativas e tradução de erro.
 */
import { RouterApiError, RouterConnectionError, RouterError, RouterTimeoutError, apiErrorFromBody } from './errors.js';

/** Api-gateway de produção da plataforma. */
export const DEFAULT_BASE_URL = 'https://zeus.adalink.app';

/** Nome da variável de ambiente lida quando `apiKey` não é informada. */
export const API_KEY_ENV = 'ADALINK_ROUTER_API_KEY';

/** Nome da variável de ambiente lida quando `baseUrl` não é informada. */
export const BASE_URL_ENV = 'ADALINK_ROUTER_BASE_URL';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;
declare const __SDK_VERSION__: string | undefined;
/** Injetada no build (`tsup.config.ts`). Fora do build (testes), `dev`. */
const SDK_VERSION = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : 'dev';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RouterClientOptions {
  /**
   * Chave de aplicação do Router. Sem ela, o SDK lê `ADALINK_ROUTER_API_KEY`.
   * Token de sessão (JWT) é recusado pelo Router nestas rotas.
   */
  apiKey?: string;
  /**
   * Endereço do api-gateway, sem caminho (por exemplo `https://zeus.adalink.app`).
   * Sem ele, o SDK lê `ADALINK_ROUTER_BASE_URL` e depois usa o gateway de produção.
   */
  baseUrl?: string;
  /** Tempo máximo até a resposta começar a chegar. Padrão: 10 minutos. */
  timeoutMs?: number;
  /**
   * Novas tentativas em rate limit (429 `rate_limited`) e em 503. Padrão: 2.
   * Saldo esgotado, limite de uso e erro do provedor nunca são repetidos.
   */
  maxRetries?: number;
  /** Cabeçalhos enviados em toda requisição. */
  headers?: Record<string, string>;
  /** Implementação de `fetch`. Padrão: a global do runtime. */
  fetch?: FetchLike;
}

/** Opções de uma chamada, que sobrepõem as do cliente. */
export interface RequestOptions {
  /** Cancela a chamada (e o stream, se já aberto). */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `true` pede `text/event-stream` e devolve a resposta com o corpo ainda aberto. */
  stream?: boolean;
  options?: RequestOptions;
}

export interface HttpResult {
  response: Response;
  /** Aborta a conexão. Em stream, é o que `RouterStream.abort()` chama. */
  controller: AbortController;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name]?.trim();
  return value ? value : undefined;
}

/** Aceita o host puro ou um endereço que já termine em `/v1` ou `/v1/router`. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1\/router$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\//.test(url)) {
    throw new RouterError(`baseUrl inválida: "${input}". Informe o endereço completo, começando por https://.`);
  }
  return url;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function shouldRetry(error: RouterApiError): boolean {
  return error.isRateLimit || error.status === 503;
}

function retryWaitMs(error: RouterApiError, attempt: number): number | undefined {
  if (error.retryAfterSeconds !== undefined) {
    const ms = error.retryAfterSeconds * 1000;
    // Espera longa demais: melhor devolver o erro e deixar quem chama decidir.
    return ms > MAX_RETRY_WAIT_MS ? undefined : ms;
  }
  const backoff = Math.min(500 * 2 ** attempt, 8_000);
  return backoff / 2 + Math.random() * (backoff / 2);
}

export class HttpClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;

  constructor(options: RouterClientOptions = {}) {
    const apiKey = options.apiKey?.trim() || readEnv(API_KEY_ENV);
    if (!apiKey) {
      throw new RouterError(
        `Chave de aplicação do Router ausente. Informe "apiKey" ou defina a variável ${API_KEY_ENV}.`,
      );
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new RouterError('Este runtime não tem fetch global. Use Node 18.17 ou mais novo, ou informe "fetch".');
    }

    this.#apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? readEnv(BASE_URL_ENV) ?? DEFAULT_BASE_URL);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#headers = { ...options.headers };
    this.#fetch = fetchImpl.bind(globalThis);
  }

  async request(req: HttpRequest): Promise<HttpResult> {
    const options = req.options ?? {};
    const maxRetries = Math.max(0, options.maxRetries ?? this.#maxRetries);
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    const controller = new AbortController();
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal?.aborted) onUserAbort();
    else userSignal?.addEventListener('abort', onUserAbort, { once: true });

    const headers: Record<string, string> = {
      accept: req.stream ? 'text/event-stream' : 'application/json',
      'user-agent': `adalink-router-sdk/${SDK_VERSION}`,
      ...this.#headers,
      ...req.headers,
      ...options.headers,
      authorization: `Bearer ${this.#apiKey}`,
    };
    const hasBody = req.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    const payload = hasBody ? JSON.stringify(req.body) : undefined;
    const url = `${this.baseUrl}${req.path}`;

    try {
      for (let attempt = 0; ; attempt += 1) {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

        let response: Response;
        try {
          response = await this.#fetch(url, { method: req.method, headers, body: payload, signal: controller.signal });
        } catch (cause) {
          if (timedOut) {
            throw new RouterTimeoutError(`O Router não respondeu em ${Math.round(timeoutMs / 1000)} s.`, { cause });
          }
          if (userSignal?.aborted) throw cause;
          throw new RouterConnectionError('Não foi possível conectar ao Router. Verifique a rede e a baseUrl.', {
            cause,
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) return { response, controller };

        const error = apiErrorFromBody(response.status, await readErrorBody(response), {
          requestId: response.headers.get('x-request-id') ?? undefined,
          retryAfterHeader: response.headers.get('retry-after'),
        });

        const waitMs = attempt < maxRetries && shouldRetry(error) ? retryWaitMs(error, attempt) : undefined;
        if (waitMs === undefined) throw error;
        await sleep(waitMs, controller.signal);
      }
    } finally {
      // Em sucesso com stream o listener continua valendo: abortar o sinal de
      // quem chamou precisa derrubar o stream. O `once` evita o vazamento.
      if (!req.stream) userSignal?.removeEventListener('abort', onUserAbort);
    }
  }

  async json<T>(req: Omit<HttpRequest, 'stream'>): Promise<{ data: T; response: Response }> {
    const { response } = await this.request({ ...req, stream: false });
    const text = await response.text();
    try {
      return { data: JSON.parse(text) as T, response };
    } catch (cause) {
      throw new RouterError('O Router devolveu uma resposta que não é JSON.', { cause });
    }
  }
}
