/**
 * Erros do SDK.
 *
 * O Router responde recusas em QUATRO envelopes diferentes, conforme quem
 * recusou (contrato público, `GET /v1/docs/router.json`):
 *
 * | Envelope               | Forma                                             | Quem emite                                  |
 * |------------------------|---------------------------------------------------|---------------------------------------------|
 * | OpenAI / AI SDK        | `{ error: { code, message, type?, param?, reason? } }` | entradas OpenAI, `decide`, autenticação |
 * | Anthropic              | `{ type: 'error', error: { type, message } }`     | entrada Anthropic                           |
 * | Plataforma             | `{ statusCode, error: 'Bad Request', code, message }` | rotas de `generations`                  |
 * | Rate limit do gateway  | `{ error: 'rate_limited', message, retryAfter? }` | api-gateway (429)                           |
 *
 * `RouterApiError` normaliza os quatro: quem usa o SDK lê sempre `status`,
 * `code` e `message`, sem precisar saber qual envelope chegou.
 */

/** Códigos estáveis de recusa documentados no contrato. Outros valores podem surgir. */
export type RouterErrorCode =
  | 'unsupported_parameter'
  | 'invalid_request'
  | 'context_length_exceeded'
  | 'content_filtered'
  | 'unsupported_protocol_version'
  | 'permission_denied'
  | 'model_blocked'
  | 'model_not_allowed'
  | 'BYO_KEY_PENDING_MIGRATION'
  | 'dlp_blocked'
  | 'model_not_found'
  | 'insufficient_quota'
  | 'usage_limit_exceeded'
  | 'rate_limited'
  | 'upstream_error'
  | 'policy_unavailable'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'invalid_api_key'
  | 'unavailable'
  | 'delegation_not_allowed'
  | 'delegation_required'
  // Entrada Anthropic: o envelope só tem `type`, que vira o `code`.
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'
  | (string & {});

/** Motivo detalhado de `model_blocked` e `model_not_found`. */
export type RouterErrorReason =
  | 'MODEL_POLICY_BLOCKED'
  | 'MODEL_NOT_GRANTED'
  | 'COST_CENTER_MODEL_BLOCKED'
  | 'MODEL_RESIDENCY_BLOCKED'
  | 'ZDR_REQUIRED'
  | 'MAX_COST_EXCEEDED'
  | 'PROMPT_TRAINING_DISALLOWED'
  | 'DEDICATED_CREDENTIAL_REJECTED'
  | 'BYOK_CREDENTIAL_REJECTED'
  | 'BYOK_PROVIDER_NO_CREDIT'
  | 'BYOK_MODEL_UNAVAILABLE'
  | 'ROUTER_DISABLED_IN_ORGANIZATION'
  | (string & {});

/** Base de todo erro lançado pelo SDK. */
export class RouterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface RouterApiErrorInit {
  status: number;
  code: RouterErrorCode;
  message: string;
  type?: string;
  param?: string | null;
  reason?: RouterErrorReason;
  requestId?: string;
  retryAfterSeconds?: number;
  body?: unknown;
}

/** O Router (ou o api-gateway na frente dele) respondeu com erro. */
export class RouterApiError extends RouterError {
  /** Status HTTP. `0` quando o erro chegou no meio de um stream já aberto. */
  readonly status: number;
  /** Código estável da recusa. */
  readonly code: RouterErrorCode;
  /** Tipo do envelope (`invalid_request_error`, `rate_limit_error`, `api_error`), quando informado. */
  readonly type?: string;
  /** Campo do corpo que causou a recusa, quando o Router aponta um. */
  readonly param?: string | null;
  /** Motivo detalhado, em `model_blocked` e `model_not_found`. */
  readonly reason?: RouterErrorReason;
  /** `x-request-id` da resposta. Informe-o ao suporte. */
  readonly requestId?: string;
  /** Segundos até poder tentar de novo (cabeçalho `Retry-After` ou campo `retryAfter`). */
  readonly retryAfterSeconds?: number;
  /** Corpo cru da resposta, já interpretado quando era JSON. */
  readonly body?: unknown;

  constructor(init: RouterApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.param = init.param;
    this.reason = init.reason;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.body = init.body;
  }

  /** Chave ausente, inválida ou sem o escopo necessário. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'invalid_api_key' || this.code === 'authentication_error';
  }

  /** Rate limit de verdade (vale tentar de novo), e não saldo ou limite de uso. */
  get isRateLimit(): boolean {
    return this.status === 429 && this.code === 'rate_limited';
  }

  /** Saldo de créditos esgotado ou limite de uso atingido: tentar de novo não resolve. */
  get isQuotaExceeded(): boolean {
    return this.code === 'insufficient_quota' || this.code === 'usage_limit_exceeded';
  }

  /** A política da organização ou o DLP recusou a chamada. */
  get isPolicyBlock(): boolean {
    return this.code === 'model_blocked' || this.code === 'model_not_allowed' || this.code === 'dlp_blocked';
  }
}

/** A requisição não chegou a receber resposta (rede, DNS, conexão recusada). */
export class RouterConnectionError extends RouterError {}

/** A requisição passou do `timeoutMs` sem receber os cabeçalhos da resposta. */
export class RouterTimeoutError extends RouterError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const FALLBACK_MESSAGE = 'O Router respondeu com erro.';

/** Lê `Retry-After` em segundos. Aceita só o formato numérico, que é o que o gateway envia. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Monta um `RouterApiError` a partir de qualquer um dos quatro envelopes. */
export function apiErrorFromBody(
  status: number,
  body: unknown,
  context: { requestId?: string; retryAfterHeader?: string | null } = {},
): RouterApiError {
  const base = {
    status,
    requestId: context.requestId,
    retryAfterSeconds: parseRetryAfter(context.retryAfterHeader),
    body,
  };

  if (!isRecord(body)) {
    return new RouterApiError({ ...base, code: defaultCode(status), message: asString(body) ?? FALLBACK_MESSAGE });
  }

  const inner = body['error'];

  // OpenAI, AI SDK e Anthropic: `error` é um objeto.
  if (isRecord(inner)) {
    const type = asString(inner['type']);
    const param = inner['param'];
    return new RouterApiError({
      ...base,
      code: asString(inner['code']) ?? type ?? defaultCode(status),
      message: asString(inner['message']) ?? FALLBACK_MESSAGE,
      type,
      param: typeof param === 'string' || param === null ? param : undefined,
      reason: asString(inner['reason']),
    });
  }

  // Plataforma (`code` no topo) e rate limit do gateway (`error` é a string `rate_limited`).
  const retryAfterBody = body['retryAfter'];
  return new RouterApiError({
    ...base,
    code: asString(body['code']) ?? asString(inner) ?? defaultCode(status),
    message: asString(body['message']) ?? FALLBACK_MESSAGE,
    retryAfterSeconds:
      base.retryAfterSeconds ?? (typeof retryAfterBody === 'number' && retryAfterBody >= 0 ? retryAfterBody : undefined),
  });
}

function defaultCode(status: number): RouterErrorCode {
  if (status === 401) return 'invalid_api_key';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'upstream_timeout';
  if (status === 503) return 'unavailable';
  return 'upstream_error';
}
