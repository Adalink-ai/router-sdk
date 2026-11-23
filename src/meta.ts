/**
 * Metadados de execução que o Router devolve nos cabeçalhos da resposta.
 */

/** Como a chamada foi roteada, a partir do cabeçalho `x-adalink-routing`. */
export type RoutingInfo =
  | {
      /** O `model` pedido era um alias; `scope` diz de quem é o alias. */
      kind: 'alias';
      scope: 'organization' | 'platform';
      raw: string;
    }
  | {
      /** `adalink/auto` decidiu o modelo. */
      kind: 'auto';
      layer?: string;
      tier?: string;
      fallback?: string;
      raw: string;
    }
  | {
      /** Um roteador de decisão (da plataforma ou da organização) escolheu o modelo. */
      kind: 'router';
      slug: string;
      version?: number;
      tier?: string;
      rule?: string;
      probability?: number;
      layer?: string;
      fallback?: string;
      raw: string;
    }
  | {
      /** Formato que esta versão do SDK não conhece. O valor cru continua em `raw`. */
      kind: 'unknown';
      raw: string;
    };

export interface ResponseMeta {
  /** Id de correlação (`x-request-id`). Informe-o ao suporte. */
  requestId?: string;
  /** Modelo que de fato respondeu (`x-adalink-model`), nunca `adalink/auto`. */
  model?: string;
  /** Provisionamento que executou a chamada (`x-adalink-deployment`). */
  deployment?: string;
  /** Como a chamada foi roteada (`x-adalink-routing`). Ausente em chamada direta a um modelo. */
  routing?: RoutingInfo;
  /** Id da geração retomável (`x-generation-id`). Só em stream pedido com retomada. */
  generationId?: string;
}

function parseFields(segments: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    fields.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  return fields;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Interpreta o cabeçalho `x-adalink-routing`. Nunca lança: formato desconhecido vira `kind: 'unknown'`. */
export function parseRouting(header: string | null | undefined): RoutingInfo | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;

  if (raw === 'organization' || raw === 'platform') {
    return { kind: 'alias', scope: raw, raw };
  }

  const segments = raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const [head, ...rest] = segments;
  if (head === undefined) return { kind: 'unknown', raw };

  if (head === 'auto') {
    const f = parseFields(rest);
    return { kind: 'auto', layer: f.get('layer'), tier: f.get('tier'), fallback: f.get('fallback'), raw };
  }

  if (head.startsWith('router=')) {
    const f = parseFields(segments);
    const slug = f.get('router');
    if (!slug) return { kind: 'unknown', raw };
    return {
      kind: 'router',
      slug,
      version: toNumber(f.get('version')),
      tier: f.get('tier'),
      rule: f.get('rule'),
      probability: toNumber(f.get('p')),
      layer: f.get('layer'),
      fallback: f.get('fallback'),
      raw,
    };
  }

  return { kind: 'unknown', raw };
}

/** Lê os metadados de execução dos cabeçalhos de uma resposta. */
export function metaFromHeaders(headers: Headers): ResponseMeta {
  return {
    requestId: headers.get('x-request-id') ?? undefined,
    model: headers.get('x-adalink-model') ?? undefined,
    deployment: headers.get('x-adalink-deployment') ?? undefined,
    routing: parseRouting(headers.get('x-adalink-routing')),
    generationId: headers.get('x-generation-id') ?? undefined,
  };
}

/** Resposta JSON com os metadados de execução em `meta` (fora do `JSON.stringify`). */
export type WithMeta<T> = T & { readonly meta: ResponseMeta };

/**
 * Anexa `meta` como propriedade NÃO enumerável: `JSON.stringify(resposta)` e o
 * spread continuam devolvendo só o corpo que o Router enviou.
 */
export function withMeta<T extends object>(body: T, meta: ResponseMeta): WithMeta<T> {
  Object.defineProperty(body, 'meta', { value: meta, enumerable: false, writable: false, configurable: true });
  return body as WithMeta<T>;
}
