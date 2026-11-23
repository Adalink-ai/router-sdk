export { AdalinkRouter, createRouter } from './client.js';
export type { GenerationStreamOptions, MessagesCreateOptions } from './client.js';

export { API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL } from './http.js';
export type { FetchLike, RequestOptions, RouterClientOptions } from './http.js';

export {
  RouterApiError,
  RouterConnectionError,
  RouterError,
  RouterTimeoutError,
} from './errors.js';
export type { RouterErrorCode, RouterErrorReason } from './errors.js';

export { parseRouting } from './meta.js';
export type { ResponseMeta, RoutingInfo, WithMeta } from './meta.js';

export { RouterStream } from './sse.js';
export type { SseEvent } from './sse.js';

export type {
  AdalinkExtensions,
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicStreamEvent,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatUsage,
  DecideRequest,
  DecideResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  GenerationCancelResponse,
  MessagesRequest,
  ModelList,
  RouterModel,
} from './types.js';
