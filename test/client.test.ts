import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdalinkRouter,
  RouterApiError,
  RouterConnectionError,
  RouterError,
  RouterTimeoutError,
  createRouter,
  type ChatCompletionChunk,
} from '../src/index.js';
import { GENERATION_ID, json, mockFetch, sse } from './helpers.js';

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'anthropic/claude-sonnet-4-5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Olá' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('configuração', () => {
  it('exige chave de aplicação', () => {
    vi.stubEnv('ADALINK_ROUTER_API_KEY', '');
    expect(() => createRouter({ fetch: mockFetch(() => json({})).fetch })).toThrow(/ADALINK_ROUTER_API_KEY/);
  });

  it('lê chave e endereço das variáveis de ambiente', async () => {
    vi.stubEnv('ADALINK_ROUTER_API_KEY', 'chave-de-exemplo');
    vi.stubEnv('ADALINK_ROUTER_BASE_URL', 'https://gateway.example.com/');
    const { fetch, calls } = mockFetch(() => json({ object: 'list', data: [] }));
    await createRouter({ fetch }).models.list();
    expect(calls[0]?.url).toBe('https://gateway.example.com/v1/router/openai/models');
    expect(calls[0]?.headers['authorization']).toBe('Bearer chave-de-exemplo');
  });

  it('aceita baseUrl que já termina em /v1/router e expõe os endereços dos SDKs oficiais', () => {
    const router = new AdalinkRouter({ apiKey: 'k', baseUrl: 'https://gateway.example.com/v1/router/', fetch: mockFetch(() => json({})).fetch });
    expect(router.baseUrl).toBe('https://gateway.example.com');
    expect(router.baseUrls).toEqual({
      openai: 'https://gateway.example.com/v1/router/openai',
      anthropic: 'https://gateway.example.com/v1/router/anthropic',
    });
  });

  it('recusa baseUrl sem protocolo', () => {
    expect(() => createRouter({ apiKey: 'k', baseUrl: 'gateway.example.com' })).toThrow(RouterError);
  });

  it('não deixa cabeçalho extra sobrepor a autenticação', async () => {
    const { fetch, calls } = mockFetch(() => json({ object: 'list', data: [] }));
    const router = createRouter({ apiKey: 'certa', fetch, headers: { authorization: 'Bearer errada', 'x-app': 'demo' } });
    await router.models.list({ headers: { authorization: 'Bearer outra' } });
    expect(calls[0]?.headers['authorization']).toBe('Bearer certa');
    expect(calls[0]?.headers['x-app']).toBe('demo');
  });
});

describe('chat.completions', () => {
  it('envia o corpo e devolve a resposta com meta fora do JSON', async () => {
    const { fetch, calls } = mockFetch(() =>
      json(completion, {
        headers: {
          'x-request-id': 'req-1',
          'x-adalink-model': 'anthropic/claude-sonnet-4-5',
          'x-adalink-deployment': 'vercel-global',
          'x-adalink-routing': 'auto; layer=heuristic; tier=$$',
        },
      }),
    );
    const router = createRouter({ apiKey: 'k', baseUrl: 'https://gw.example.com', fetch });

    const result = await router.chat.completions.create({
      model: 'adalink/auto',
      messages: [{ role: 'user', content: 'Oi' }],
      adalink: { routing: { preferQuality: true } },
    });

    expect(calls[0]?.url).toBe('https://gw.example.com/v1/router/openai/chat/completions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['accept']).toBe('application/json');
    expect(calls[0]?.body).toEqual({
      model: 'adalink/auto',
      messages: [{ role: 'user', content: 'Oi' }],
      adalink: { routing: { preferQuality: true } },
    });

    expect(result.choices[0]?.message.content).toBe('Olá');
    expect(result.meta).toEqual({
      requestId: 'req-1',
      model: 'anthropic/claude-sonnet-4-5',
      deployment: 'vercel-global',
      routing: { kind: 'auto', layer: 'heuristic', tier: '$$', fallback: undefined, raw: 'auto; layer=heuristic; tier=$$' },
      generationId: undefined,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(completion);
  });

  it('entrega os chunks do stream, inclusive evento cortado entre dois pedaços, e para no [DONE]', async () => {
    const chunk = (content: string): string =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    const first = chunk('Olá');
    const { fetch, calls } = mockFetch(() =>
      sse([first.slice(0, 20), first.slice(20) + chunk(', mundo'), ': ping\n\n', 'data: [DONE]\n\n', chunk('depois do fim')], {
        'x-generation-id': GENERATION_ID,
        'x-request-id': 'req-2',
      }),
    );
    const router = createRouter({ apiKey: 'k', fetch });

    const stream = await router.chat.completions.create({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Oi' }],
      stream: true,
      adalink: { resumable: true },
    });

    expect(calls[0]?.headers['accept']).toBe('text/event-stream');
    expect(stream.generationId).toBe(GENERATION_ID);

    const parts: ChatCompletionChunk[] = [];
    for await (const part of stream) parts.push(part);
    expect(parts.map((p) => p.choices[0]?.delta.content)).toEqual(['Olá', ', mundo']);
  });

  it('transforma o chunk de erro no meio do stream em RouterApiError', async () => {
    const { fetch } = mockFetch(() =>
      sse(['data: {"error":{"message":"Ocorreu um erro ao gerar a resposta.","type":"api_error","code":"upstream_error"}}\n\n'], {
        'x-request-id': 'req-3',
      }),
    );
    const stream = await createRouter({ apiKey: 'k', fetch }).chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'Oi' }],
      stream: true,
    });

    const consume = async (): Promise<void> => {
      for await (const _ of stream) void _;
    };
    await expect(consume()).rejects.toMatchObject({ status: 0, code: 'upstream_error', requestId: 'req-3' });
  });

  it('recusa iterar o mesmo stream duas vezes', async () => {
    const { fetch } = mockFetch(() => sse(['data: [DONE]\n\n']));
    const stream = await createRouter({ apiKey: 'k', fetch }).chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'Oi' }],
      stream: true,
    });
    for await (const _ of stream) void _;
    const again = async (): Promise<void> => {
      for await (const _ of stream) void _;
    };
    await expect(again()).rejects.toThrow(/já foi consumido/);
  });
});

describe('messages', () => {
  it('manda as extensões Adalink no cabeçalho x-adalink-options, não no corpo', async () => {
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Olá' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    const { fetch, calls } = mockFetch(() => json(message));
    const router = createRouter({ apiKey: 'k', baseUrl: 'https://gw.example.com', fetch });

    const result = await router.messages.create(
      { model: 'anthropic/claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Oi' }] },
      { adalink: { endpoint: 'bedrock-sa-east-1' } },
    );

    expect(calls[0]?.url).toBe('https://gw.example.com/v1/router/anthropic/v1/messages');
    expect(calls[0]?.headers['x-adalink-options']).toBe('{"endpoint":"bedrock-sa-east-1"}');
    expect(calls[0]?.body).toEqual({ model: 'anthropic/claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Oi' }] });
    expect(result.content[0]?.text).toBe('Olá');
  });

  it('entrega os eventos do stream e lança no evento error', async () => {
    const { fetch } = mockFetch(() =>
      sse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Olá"}}\r\n\r\n',
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Ocorreu um erro ao gerar a resposta."}}\n\n',
      ]),
    );
    const stream = await createRouter({ apiKey: 'k', fetch }).messages.create({
      model: 'm',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Oi' }],
      stream: true,
    });

    const types: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const event of stream) types.push(event.type);
    };
    await expect(consume()).rejects.toMatchObject({ code: 'api_error', message: 'Ocorreu um erro ao gerar a resposta.' });
    expect(types).toEqual(['message_start', 'content_block_delta']);
  });
});

describe('embeddings, models e decide', () => {
  it('chama as rotas certas', async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith('/embeddings')) {
        return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'google/gemini-embedding-2', usage: { prompt_tokens: 2, total_tokens: 2 } });
      }
      if (call.url.endsWith('/models')) return json({ object: 'list', data: [{ id: 'adalink/auto', object: 'model' }] });
      return json({ modelId: 'openai/gpt-5-mini', tier: '$', layer: 'heuristic' }, { headers: { 'x-request-id': 'req-9' } });
    });
    const router = createRouter({ apiKey: 'k', baseUrl: 'https://gw.example.com', fetch });

    const embeddings = await router.embeddings.create({ model: 'google/gemini-embedding-2', input: ['a'] });
    const models = await router.models.list();
    const decision = await router.decide({ model: 'adalink/auto', input: { prompt: 'Resuma este contrato' } });

    expect(calls.map((c) => `${c.method} ${c.url.replace('https://gw.example.com', '')}`)).toEqual([
      'POST /v1/router/openai/embeddings',
      'GET /v1/router/openai/models',
      'POST /v1/router/decide',
    ]);
    expect(calls[1]?.headers['content-type']).toBeUndefined();
    expect(embeddings.data[0]?.embedding).toEqual([0.1, 0.2]);
    expect(models.data[0]?.id).toBe('adalink/auto');
    expect(decision.modelId).toBe('openai/gpt-5-mini');
    expect(decision.meta.requestId).toBe('req-9');
  });
});

describe('generations', () => {
  it('retoma com Last-Event-ID e acompanha o id do último evento', async () => {
    const { fetch, calls } = mockFetch(() => sse(['id: 8\ndata: {"a":1}\n\n', 'id: 9\ndata: [DONE]\n\n'], { 'x-generation-id': GENERATION_ID }));
    const router = createRouter({ apiKey: 'k', baseUrl: 'https://gw.example.com', fetch });

    const stream = await router.generations.stream(GENERATION_ID, { lastEventId: '7' });
    expect(calls[0]?.url).toBe(`https://gw.example.com/v1/router/generations/${GENERATION_ID}/stream`);
    expect(calls[0]?.headers['last-event-id']).toBe('7');
    expect(stream.lastEventId).toBe('7');

    const data: string[] = [];
    for await (const event of stream) data.push(event.data);
    expect(data).toEqual(['{"a":1}', '[DONE]']);
    expect(stream.lastEventId).toBe('9');
  });

  it('cancela a geração', async () => {
    const { fetch, calls } = mockFetch(() => json({ generation_id: GENERATION_ID, status: 'cancelling' }, { status: 202 }));
    const result = await createRouter({ apiKey: 'k', fetch }).generations.cancel(GENERATION_ID);
    expect(calls[0]?.method).toBe('POST');
    expect(result.status).toBe('cancelling');
  });

  it('recusa id fora do formato antes de chamar a rede', async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await expect(createRouter({ apiKey: 'k', fetch }).generations.cancel('../admin')).rejects.toThrow(/inválido/);
    expect(calls).toHaveLength(0);
  });
});

describe('erros', () => {
  const call = (router: AdalinkRouter): Promise<unknown> =>
    router.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'Oi' }] });

  it('normaliza o envelope da OpenAI', async () => {
    const { fetch } = mockFetch(() =>
      json(
        { error: { message: 'O modelo está bloqueado pela política.', type: 'invalid_request_error', code: 'model_blocked', param: 'model', reason: 'ZDR_REQUIRED' } },
        { status: 403, headers: { 'x-request-id': 'req-e1' } },
      ),
    );
    const error = await call(createRouter({ apiKey: 'k', fetch })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouterApiError);
    expect(error).toMatchObject({ status: 403, code: 'model_blocked', param: 'model', reason: 'ZDR_REQUIRED', requestId: 'req-e1', isPolicyBlock: true });
  });

  it('normaliza o envelope da Anthropic usando o type como código', async () => {
    const { fetch } = mockFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: 'Chave inválida.' } }, { status: 401 }));
    const error = await call(createRouter({ apiKey: 'k', fetch })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: 'authentication_error', message: 'Chave inválida.', isAuthError: true });
  });

  it('normaliza o envelope da plataforma, em que error é a razão HTTP', async () => {
    const { fetch } = mockFetch(() => json({ statusCode: 404, error: 'Not Found', code: 'NOT_FOUND', message: 'Geração não encontrada.' }, { status: 404 }));
    const error = await createRouter({ apiKey: 'k', fetch }).generations.cancel(GENERATION_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Geração não encontrada.' });
  });

  it('não repete saldo esgotado', async () => {
    const { fetch, calls } = mockFetch(() => json({ error: { message: 'Saldo esgotado.', type: 'rate_limit_error', code: 'insufficient_quota' } }, { status: 429 }));
    const error = await call(createRouter({ apiKey: 'k', fetch })).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ code: 'insufficient_quota', isQuotaExceeded: true, isRateLimit: false });
  });

  it('repete o rate limit do gateway respeitando Retry-After e depois responde', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch((_, index) =>
      index === 0
        ? json({ statusCode: 429, error: 'rate_limited', message: 'Muitas requisições.', retryAfter: 2 }, { status: 429, headers: { 'retry-after': '2' } })
        : json(completion),
    );
    const pending = call(createRouter({ apiKey: 'k', fetch }));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ id: 'chatcmpl-1' });
    expect(calls).toHaveLength(2);
  });

  it('devolve o erro quando as tentativas acabam ou quando maxRetries é 0', async () => {
    const { fetch, calls } = mockFetch(() => json({ error: 'rate_limited', message: 'Muitas requisições.' }, { status: 429, headers: { 'retry-after': '0' } }));
    const router = createRouter({ apiKey: 'k', fetch, maxRetries: 1 });
    await expect(call(router)).rejects.toMatchObject({ status: 429, code: 'rate_limited', isRateLimit: true, retryAfterSeconds: 0 });
    expect(calls).toHaveLength(2);

    await expect(router.models.list({ maxRetries: 0 })).rejects.toBeInstanceOf(RouterApiError);
    expect(calls).toHaveLength(3);
  });

  it('não espera um Retry-After longo demais', async () => {
    const { fetch, calls } = mockFetch(() => json({ error: 'rate_limited', message: 'Muitas requisições.' }, { status: 429, headers: { 'retry-after': '120' } }));
    await expect(call(createRouter({ apiKey: 'k', fetch }))).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(calls).toHaveLength(1);
  });

  it('traduz falha de rede e timeout', async () => {
    const offline = createRouter({ apiKey: 'k', fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(call(offline)).rejects.toBeInstanceOf(RouterConnectionError);

    const slow = createRouter({
      apiKey: 'k',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    await expect(call(slow)).rejects.toBeInstanceOf(RouterTimeoutError);
  });

  it('repassa o cancelamento de quem chamou', async () => {
    const controller = new AbortController();
    const router = createRouter({
      apiKey: 'k',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const pending = router.models.list({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
