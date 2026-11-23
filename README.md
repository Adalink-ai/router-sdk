# @adaflow/router-sdk

SDK Node/TypeScript do **Adalink AI Router**: um endereço e uma chave para chamar
modelos de vários provedores, com a política, o DLP, o saldo e a trilha de
auditoria da sua organização aplicados a cada chamada.

Sem dependências de runtime. Funciona em Node 18.17 ou mais novo e em qualquer
ambiente com `fetch` global.

## O que o SDK cobre

As rotas de **uso** do Router, autenticadas pela chave de aplicação:

| Recurso | Método | Rota |
|---|---|---|
| Chat (formato OpenAI) | `router.chat.completions.create()` | `POST /v1/router/openai/chat/completions` |
| Mensagens (formato Anthropic) | `router.messages.create()` | `POST /v1/router/anthropic/v1/messages` |
| Embeddings | `router.embeddings.create()` | `POST /v1/router/openai/embeddings` |
| Modelos disponíveis | `router.models.list()` | `GET /v1/router/openai/models` |
| Decisão de roteador | `router.decide()` | `POST /v1/router/decide` |
| Retomar geração | `router.generations.stream()` | `GET /v1/router/generations/{id}/stream` |
| Cancelar geração | `router.generations.cancel()` | `POST /v1/router/generations/{id}/cancel` |

Fica de fora, de propósito, tudo o que é gestão: criar aplicação, gerar ou
revogar chave, política de modelos, orçamento, roteadores e chaves de provedor.
Isso é feito no console do Router por quem administra a organização.

O provider do AI SDK da Vercel (`createAdalinkRouter`) também não está aqui
ainda; virá como um pacote ou entrada separada.

## Instalação

```bash
pnpm add @adaflow/router-sdk
```

## Primeiros passos

A chave de aplicação é criada no console do Router. Ela é diferente do token de
sessão do Adaflow, que o Router recusa nestas rotas.

```ts
import { createRouter } from '@adaflow/router-sdk';

const router = createRouter({
  apiKey: process.env.ADALINK_ROUTER_API_KEY,
});

const resposta = await router.chat.completions.create({
  model: 'adalink/auto',
  messages: [{ role: 'user', content: 'Resuma o contrato em três tópicos.' }],
});

console.log(resposta.choices[0]?.message.content);
console.log(resposta.meta.model);   // modelo que de fato respondeu
console.log(resposta.meta.routing); // como o Router decidiu
```

Sem argumentos, `createRouter()` lê `ADALINK_ROUTER_API_KEY` e
`ADALINK_ROUTER_BASE_URL`. Sem endereço, usa o gateway de produção
(`https://zeus.adalink.app`).

### O campo `model`

| Valor | O que acontece |
|---|---|
| `anthropic/claude-sonnet-4-5` | Chama esse modelo do catálogo |
| `anthropic/claude-sonnet-4-5@<endpoint>` | Chama o modelo fixando o provisionamento |
| `adalink/auto` | O Router escolhe o modelo pela complexidade do pedido |
| `adalink/<slug>` ou o slug de um roteador da organização | Um roteador de decisão escolhe o modelo |
| um alias | O alias aponta para o modelo definido pela organização ou pela plataforma |

`router.models.list()` devolve o que a sua chave pode chamar.

## Streaming

```ts
const stream = await router.chat.completions.create({
  model: 'adalink/auto',
  messages: [{ role: 'user', content: 'Escreva um haicai sobre o cerrado.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
```

`stream.meta` já está disponível antes da iteração. `stream.abort()` solta a
conexão.

### Geração retomável

Com `adalink.resumable: true`, a geração continua no Router mesmo que a conexão
caia, e pode ser retomada do ponto em que parou.

```ts
const stream = await router.chat.completions.create({
  model: 'adalink/auto',
  messages,
  stream: true,
  adalink: { resumable: true },
});

const generationId = stream.generationId;

try {
  for await (const chunk of stream) render(chunk);
} catch {
  // A conexão caiu: continua do último evento recebido.
  const retomada = await router.generations.stream(generationId!, {
    lastEventId: stream.lastEventId,
  });
  for await (const event of retomada) {
    if (event.data === '[DONE]') break;
    render(JSON.parse(event.data));
  }
}

// Para interromper a geração de vez:
await router.generations.cancel(generationId!);
```

Na retomada os eventos chegam crus (`{ event, data, id }`), no mesmo formato da
chamada que originou a geração.

## Formato Anthropic

```ts
const mensagem = await router.messages.create(
  {
    model: 'anthropic/claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Olá!' }],
  },
  { adalink: { resumable: false } },
);
```

Nesta entrada as extensões Adalink viajam em cabeçalho, por isso ficam no
segundo argumento, e só `endpoint` e `resumable` têm efeito.

## Embeddings

```ts
const { data } = await router.embeddings.create({
  model: 'google/gemini-embedding-2',
  input: ['primeiro texto', 'segundo texto'],
});
```

## Decisão sem execução

Pergunta a um roteador qual modelo ele escolheria, sem executar o modelo e sem
gerar cobrança.

```ts
const decisao = await router.decide({
  model: 'adalink/auto',
  input: { prompt: 'Analise este balanço e aponte riscos.' },
});
// { modelId: 'openai/gpt-5', tier: '$$$', layer: 'llm_classifier' }
```

## Metadados da resposta

Toda resposta traz `meta`, lido dos cabeçalhos:

| Campo | Significado |
|---|---|
| `requestId` | Id de correlação. Informe-o ao suporte |
| `model` | Modelo que de fato respondeu |
| `deployment` | Provisionamento que executou a chamada |
| `routing` | Como a chamada foi roteada: `alias`, `auto` ou `router`, com faixa, camada e motivo de fallback |
| `generationId` | Id da geração retomável, quando pedida |

`meta` não aparece em `JSON.stringify(resposta)`: o corpo serializado é
exatamente o que o Router enviou.

## Erros

Toda recusa do Router vira `RouterApiError`, com os mesmos campos seja qual for
a rota:

```ts
import { RouterApiError } from '@adaflow/router-sdk';

try {
  await router.chat.completions.create({ model, messages });
} catch (error) {
  if (error instanceof RouterApiError) {
    if (error.isQuotaExceeded) avisar('Sua organização está sem saldo de créditos.');
    else if (error.isPolicyBlock) avisar(error.message);
    else registrar(error.code, error.requestId);
  }
}
```

| Campo | Significado |
|---|---|
| `status` | Status HTTP. `0` quando o erro chegou com o stream já aberto |
| `code` | Código estável: `model_blocked`, `dlp_blocked`, `insufficient_quota`, `rate_limited`, `invalid_api_key` etc. |
| `message` | Mensagem em português, pronta para mostrar a quem usa |
| `reason` | Motivo do bloqueio, quando há: `ZDR_REQUIRED`, `MODEL_RESIDENCY_BLOCKED`, `MAX_COST_EXCEEDED` etc. |
| `param` | Campo do corpo que causou a recusa |
| `requestId` | Id de correlação |
| `retryAfterSeconds` | Segundos até poder tentar de novo, em rate limit |

Falha de rede vira `RouterConnectionError` e estouro de tempo vira
`RouterTimeoutError`. Todas herdam de `RouterError`.

### Novas tentativas

O SDK tenta de novo, até 2 vezes, só em rate limit (429 `rate_limited`,
respeitando `Retry-After`) e em 503. Saldo esgotado, limite de uso e erro do
provedor nunca são repetidos, para não gerar cobrança em dobro. Ajuste com
`maxRetries`, no cliente ou por chamada.

## Usando os SDKs oficiais

O Router fala os protocolos da OpenAI e da Anthropic. Se o seu código já usa
esses SDKs, basta trocar o endereço e a chave:

```ts
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: router.baseUrls.openai, // https://<gateway>/v1/router/openai
  apiKey: process.env.ADALINK_ROUTER_API_KEY,
});
```

O que este SDK acrescenta é a leitura dos metadados de roteamento, os erros
normalizados, a retomada de geração e a decisão de roteador.

## Desenvolvimento

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Publicação

A publicação no npm é feita pela esteira, com [changesets](https://github.com/changesets/changesets):

1. Na PR da mudança, rode `pnpm changeset` e descreva o que mudou.
2. Ao chegar na `main`, a esteira abre (ou atualiza) a PR **Version Packages**.
3. O merge dessa PR publica a nova versão no npm.

O contrato de referência é o documento OpenAPI público do Router, servido pelo
gateway em `GET /v1/docs/router.json`.

## Licença

MIT
