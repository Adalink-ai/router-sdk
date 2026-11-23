/**
 * Tipos do contrato público do Adalink AI Router (`GET /v1/docs/router.json`).
 *
 * Os corpos de chat e de mensagens seguem os formatos da OpenAI e da Anthropic.
 * Onde o contrato do Router deixa o item em aberto (mensagens, ferramentas,
 * blocos de conteúdo), o tipo aqui também fica aberto, com os campos comuns
 * nomeados.
 */

/** Extensões Adalink de uma chamada. */
export interface AdalinkExtensions {
  /** Fixa o provisionamento desta chamada, dentro da política. Equivale a `model` na forma `gatewayId@endpoint`. */
  endpoint?: string;
  /**
   * Pede geração retomável. Só vale em stream. A resposta traz `generationId`,
   * usado em `router.generations.stream()` e `router.generations.cancel()`.
   */
  resumable?: boolean;
  /** Dicas de roteamento, lidas quando `model` é um roteador (`adalink/auto`, `adalink/<slug>`). */
  routing?: {
    /** Pede a faixa de maior qualidade do pool. */
    preferQuality?: boolean;
    taskTypeHint?: string;
    specialistActive?: boolean;
    specialistHint?: { name?: string; description?: string };
  };
  /** Até 16 pares de texto. Reservado. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Chat (formato OpenAI)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [key: string]: unknown;
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
  [key: string]: unknown;
}

/**
 * Corpo de `POST /v1/router/openai/chat/completions`.
 *
 * A lista de campos é FECHADA no Router: campo fora dela é recusado com 400
 * `unsupported_parameter` (por exemplo `presence_penalty`, `frequency_penalty`,
 * `seed`, `logit_bias` e `parallel_tool_calls`).
 */
export interface ChatCompletionRequest {
  /** Id do modelo no catálogo, `gatewayId@endpoint` para fixar provisionamento, ou um roteador como `adalink/auto`. */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | Record<string, unknown>;
  response_format?: Record<string, unknown>;
  reasoning_effort?: 'low' | 'medium' | 'high';
  n?: 1;
  user?: string;
  adalink?: AdalinkExtensions;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  /** Modelo que de fato respondeu. */
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage?: ChatUsage;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  /** Presente no último chunk quando `stream_options.include_usage` é `true`. */
  usage?: ChatUsage | null;
}

// ---------------------------------------------------------------------------
// Embeddings (formato OpenAI)
// ---------------------------------------------------------------------------

/** Corpo de `POST /v1/router/openai/embeddings`. Lista de campos FECHADA. */
export interface EmbeddingsRequest {
  /** Id do modelo de embedding do catálogo, por exemplo `google/gemini-embedding-2`. */
  model: string;
  /** Um texto ou uma lista de textos, nenhum vazio. O teto por chamada depende do modelo (até 2.048). */
  input: string | string[];
  /** Dimensão do vetor, quando o modelo aceita reduzir. */
  dimensions?: number;
  /** Padrão `float`. Com `base64`, cada vetor volta como float32 little-endian em base64. */
  encoding_format?: 'float' | 'base64';
  user?: string;
}

export interface EmbeddingsResponse {
  object: 'list';
  /** Um item por texto, na ordem do pedido. */
  data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

export interface RouterModel {
  id: string;
  object: 'model';
  created?: number;
  owned_by?: string;
  /** Escopo do alias, quando a entrada é um alias. */
  scope?: 'organization' | 'platform';
  /** Presente quando um alias da organização encobre um alias da plataforma de mesmo nome. */
  shadows?: 'platform';
}

export interface ModelList {
  object: 'list';
  /** `adalink/auto` é sempre a primeira entrada. */
  data: RouterModel[];
}

// ---------------------------------------------------------------------------
// Mensagens (formato Anthropic)
// ---------------------------------------------------------------------------

export interface AnthropicInputMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/** Corpo de `POST /v1/router/anthropic/v1/messages`. Lista de campos FECHADA. */
export interface MessagesRequest {
  /** Id do modelo, `gatewayId@endpoint` ou `adalink/auto`. */
  model: string;
  messages: AnthropicInputMessage[];
  /** Obrigatório na API Messages. */
  max_tokens: number;
  system?: string | Array<Record<string, unknown>>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  metadata?: { user_id?: string };
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  /** Modelo que de fato respondeu. */
  model: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** Evento de stream da API Messages (`message_start`, `content_block_delta`, `message_stop` etc.). */
export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Decisão de roteador
// ---------------------------------------------------------------------------

/** Corpo de `POST /v1/router/decide`. Lista de campos FECHADA. */
export interface DecideRequest {
  /** Roteador a decidir: `adalink/auto`, `adalink/<slug>` ou o slug de um roteador da organização. */
  model: string;
  input: {
    prompt?: string;
    conversationHistory?: Array<Record<string, unknown>>;
    specialistHint?: Record<string, unknown>;
    routingHints?: Record<string, unknown>;
  };
  /** O turno tem imagem. */
  hasImages?: boolean;
}

/** Decisão de um roteador. Não executa o modelo nem gera cobrança. */
export interface DecideResponse {
  /** Modelo que o roteador escolheria. */
  modelId: string;
  /** Faixa escolhida (`$`, `$$`, `$$$` no Auto, ou o nome da faixa do roteador). */
  tier?: string;
  /** Camada que decidiu (`rule_based`, `heuristic`, `llm_classifier`, `fallback`, `threshold`, `rules`). */
  layer?: string;
  /** Slug do roteador que decidiu. */
  slug?: string;
  /** Versão ativa da definição do roteador. */
  version?: number;
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Gerações retomáveis
// ---------------------------------------------------------------------------

export interface GenerationCancelResponse {
  generation_id: string;
  /** `cancelling` enquanto a geração roda; o estado atual quando ela já encerrou. */
  status: string;
}
