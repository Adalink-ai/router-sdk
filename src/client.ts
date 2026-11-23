/**
 * Cliente do Adalink AI Router.
 *
 * Cobre as rotas de USO do contrato público, autenticadas pela chave de
 * aplicação: chat, mensagens, embeddings, modelos, decisão de roteador e
 * gerações retomáveis. Rotas de gestão (aplicações, chaves, políticas,
 * orçamento, cofre de credenciais) ficam fora de propósito: pertencem ao
 * console do Router.
 */
import { RouterApiError, RouterError, apiErrorFromBody } from './errors.js';
import { HttpClient, type RequestOptions, type RouterClientOptions } from './http.js';
import { metaFromHeaders, withMeta, type WithMeta } from './meta.js';
import { RouterStream, STREAM_DONE, type SseEvent, type StreamDecoder } from './sse.js';
import type {
  AdalinkExtensions,
  AnthropicMessage,
  AnthropicStreamEvent,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  DecideRequest,
  DecideResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  GenerationCancelResponse,
  MessagesRequest,
  ModelList,
} from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch (cause) {
    throw new RouterError('O Router enviou um evento de stream que não é JSON.', { cause });
  }
}

function isErrorPayload(value: unknown): value is { error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value && !('choices' in value);
}

/** Erro que chega com o stream já aberto: status HTTP já foi 200, por isso `status: 0`. */
function streamError(payload: unknown, requestId: string | undefined): RouterApiError {
  return apiErrorFromBody(0, payload, { requestId });
}

function openStream<T>(
  response: Response,
  controller: AbortController,
  decode: (event: SseEvent, requestId: string | undefined) => T | typeof STREAM_DONE | undefined,
  lastEventId?: string,
): RouterStream<T> {
  if (!response.body) {
    throw new RouterError('O Router respondeu ao stream sem corpo.');
  }
  const meta = metaFromHeaders(response.headers);
  const bound: StreamDecoder<T> = (event) => decode(event, meta.requestId);
  return new RouterStream<T>(response.body, meta, bound, controller, lastEventId);
}

const decodeChatChunk = (event: SseEvent, requestId: string | undefined): ChatCompletionChunk | typeof STREAM_DONE | undefined => {
  if (event.data === '') return undefined;
  if (event.data === '[DONE]') return STREAM_DONE;
  const payload = parseJson(event.data);
  if (isErrorPayload(payload)) throw streamError(payload, requestId);
  return payload as ChatCompletionChunk;
};

const decodeAnthropicEvent = (event: SseEvent, requestId: string | undefined): AnthropicStreamEvent | undefined => {
  if (event.data === '') return undefined;
  const payload = parseJson(event.data);
  const type = typeof payload === 'object' && payload !== null ? (payload as { type?: unknown }).type : undefined;
  if (event.event === 'error' || type === 'error') {
    throw streamError(payload, requestId);
  }
  return payload as AnthropicStreamEvent;
};

class ChatCompletions {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Executa um modelo pelo formato Chat Completions da OpenAI. Com `stream: true`, devolve um stream de chunks. */
  create(body: ChatCompletionRequest & { stream: true }, options?: RequestOptions): Promise<RouterStream<ChatCompletionChunk>>;
  create(body: ChatCompletionRequest & { stream?: false }, options?: RequestOptions): Promise<WithMeta<ChatCompletion>>;
  create(
    body: ChatCompletionRequest,
    options?: RequestOptions,
  ): Promise<WithMeta<ChatCompletion> | RouterStream<ChatCompletionChunk>>;
  async create(
    body: ChatCompletionRequest,
    options?: RequestOptions,
  ): Promise<WithMeta<ChatCompletion> | RouterStream<ChatCompletionChunk>> {
    const path = '/v1/router/openai/chat/completions';
    if (body.stream === true) {
      const { response, controller } = await this.#http.request({ method: 'POST', path, body, stream: true, options });
      return openStream(response, controller, decodeChatChunk);
    }
    const { data, response } = await this.#http.json<ChatCompletion>({ method: 'POST', path, body, options });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

class Chat {
  readonly completions: ChatCompletions;
  constructor(http: HttpClient) {
    this.completions = new ChatCompletions(http);
  }
}

/** Opções de `messages.create`, além das comuns. */
export interface MessagesCreateOptions extends RequestOptions {
  /**
   * Extensões Adalink. Nesta entrada elas viajam no cabeçalho `x-adalink-options`
   * e só `endpoint` e `resumable` têm efeito; `routing` e `metadata` são ignorados.
   */
  adalink?: Pick<AdalinkExtensions, 'endpoint' | 'resumable'>;
}

class Messages {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Executa um modelo pelo formato Messages da Anthropic. Com `stream: true`, devolve um stream de eventos. */
  create(body: MessagesRequest & { stream: true }, options?: MessagesCreateOptions): Promise<RouterStream<AnthropicStreamEvent>>;
  create(body: MessagesRequest & { stream?: false }, options?: MessagesCreateOptions): Promise<WithMeta<AnthropicMessage>>;
  create(
    body: MessagesRequest,
    options?: MessagesCreateOptions,
  ): Promise<WithMeta<AnthropicMessage> | RouterStream<AnthropicStreamEvent>>;
  async create(
    body: MessagesRequest,
    options: MessagesCreateOptions = {},
  ): Promise<WithMeta<AnthropicMessage> | RouterStream<AnthropicStreamEvent>> {
    const path = '/v1/router/anthropic/v1/messages';
    const { adalink, ...requestOptions } = options;
    const headers: Record<string, string> = {};
    if (adalink && Object.keys(adalink).length > 0) headers['x-adalink-options'] = JSON.stringify(adalink);

    if (body.stream === true) {
      const { response, controller } = await this.#http.request({
        method: 'POST',
        path,
        body,
        headers,
        stream: true,
        options: requestOptions,
      });
      return openStream(response, controller, decodeAnthropicEvent);
    }
    const { data, response } = await this.#http.json<AnthropicMessage>({
      method: 'POST',
      path,
      body,
      headers,
      options: requestOptions,
    });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

class Embeddings {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Gera o vetor de cada texto. A chamada é cobrada pela entrada e passa pelo DLP da organização. */
  async create(body: EmbeddingsRequest, options?: RequestOptions): Promise<WithMeta<EmbeddingsResponse>> {
    const { data, response } = await this.#http.json<EmbeddingsResponse>({
      method: 'POST',
      path: '/v1/router/openai/embeddings',
      body,
      options,
    });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

class Models {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Lista os modelos, aliases e roteadores que esta chave pode chamar. `adalink/auto` vem primeiro. */
  async list(options?: RequestOptions): Promise<WithMeta<ModelList>> {
    const { data, response } = await this.#http.json<ModelList>({
      method: 'GET',
      path: '/v1/router/openai/models',
      options,
    });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

/** Opções de `generations.stream`. */
export interface GenerationStreamOptions extends RequestOptions {
  /** Id do último evento já recebido. Sem ele, a reentrega começa do início. */
  lastEventId?: string;
}

class Generations {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  #path(id: string, action: 'stream' | 'cancel'): string {
    if (!UUID_RE.test(id)) {
      throw new RouterError(`Id de geração inválido: "${id}". Use o generationId devolvido pela chamada original.`);
    }
    return `/v1/router/generations/${id}/${action}`;
  }

  /**
   * Retoma o stream de uma geração retomável.
   *
   * Os eventos chegam CRUS, no mesmo formato da chamada que originou a geração
   * (OpenAI ou Anthropic): interprete `event.data` com `JSON.parse`, lembrando
   * que na entrada OpenAI o último evento é `[DONE]`.
   */
  async stream(id: string, options: GenerationStreamOptions = {}): Promise<RouterStream<SseEvent>> {
    const { lastEventId, ...requestOptions } = options;
    const headers: Record<string, string> = {};
    if (lastEventId) headers['last-event-id'] = lastEventId;
    const { response, controller } = await this.#http.request({
      method: 'GET',
      path: this.#path(id, 'stream'),
      headers,
      stream: true,
      options: requestOptions,
    });
    return openStream<SseEvent>(response, controller, (event) => event, lastEventId);
  }

  /** Pede o cancelamento de uma geração retomável. Só a aplicação que a criou consegue cancelar. */
  async cancel(id: string, options?: RequestOptions): Promise<WithMeta<GenerationCancelResponse>> {
    const { data, response } = await this.#http.json<GenerationCancelResponse>({
      method: 'POST',
      path: this.#path(id, 'cancel'),
      options,
    });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

export class AdalinkRouter {
  /** Chat no formato da OpenAI: `router.chat.completions.create(...)`. */
  readonly chat: Chat;
  /** Mensagens no formato da Anthropic: `router.messages.create(...)`. */
  readonly messages: Messages;
  /** Embeddings no formato da OpenAI. */
  readonly embeddings: Embeddings;
  /** Modelos, aliases e roteadores disponíveis para a chave. */
  readonly models: Models;
  /** Retomada e cancelamento de gerações retomáveis. */
  readonly generations: Generations;

  readonly #http: HttpClient;

  constructor(options: RouterClientOptions = {}) {
    this.#http = new HttpClient(options);
    this.chat = new Chat(this.#http);
    this.messages = new Messages(this.#http);
    this.embeddings = new Embeddings(this.#http);
    this.models = new Models(this.#http);
    this.generations = new Generations(this.#http);
  }

  /** Endereço do api-gateway em uso. */
  get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /**
   * Endereços para quem prefere os SDKs oficiais: passe `openai` como `baseURL`
   * do SDK da OpenAI e `anthropic` como `baseURL` do SDK da Anthropic, com a
   * chave de aplicação do Router no lugar da chave do provedor.
   */
  get baseUrls(): { openai: string; anthropic: string } {
    return { openai: `${this.baseUrl}/v1/router/openai`, anthropic: `${this.baseUrl}/v1/router/anthropic` };
  }

  /**
   * Pergunta a um roteador qual modelo ele escolheria para a entrada, sem
   * executar o modelo e sem gerar cobrança.
   */
  async decide(body: DecideRequest, options?: RequestOptions): Promise<WithMeta<DecideResponse>> {
    const { data, response } = await this.#http.json<DecideResponse>({
      method: 'POST',
      path: '/v1/router/decide',
      body,
      options,
    });
    return withMeta(data, metaFromHeaders(response.headers));
  }
}

/** Cria um cliente do Router. Equivale a `new AdalinkRouter(options)`. */
export function createRouter(options: RouterClientOptions = {}): AdalinkRouter {
  return new AdalinkRouter(options);
}
