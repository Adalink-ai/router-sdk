/**
 * Leitura de Server-Sent Events e o stream que o SDK devolve.
 */
import { RouterError } from './errors.js';
import type { ResponseMeta } from './meta.js';

/** Um evento SSE cru. */
export interface SseEvent {
  /** Campo `event:`. Ausente nos streams da entrada OpenAI. */
  event?: string;
  /** Campo `data:` (linhas múltiplas unidas por `\n`). */
  data: string;
  /** Campo `id:`. É o valor a enviar em `Last-Event-ID` para retomar. */
  id?: string;
}

function parseBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (data.length === 0 && event === undefined && id === undefined) return undefined;
  return { event, data: data.join('\n'), id };
}

/** Converte o corpo de uma resposta `text/event-stream` em eventos. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    const tail = parseBlock(buffer.replace(/\r\n?/g, '\n'));
    if (tail) yield tail;
  } finally {
    // Quem sai do `for await` antes do fim (break, erro) solta a conexão.
    await reader.cancel().catch(() => undefined);
  }
}

/** Sinal devolvido por um decodificador para encerrar o stream (ex.: `[DONE]`). */
export const STREAM_DONE: unique symbol = Symbol('adalink.router.stream.done');

/** Transforma um evento SSE no item entregue ao consumidor, encerra ou descarta (`undefined`). */
export type StreamDecoder<T> = (event: SseEvent) => T | typeof STREAM_DONE | undefined;

/**
 * Stream de uma resposta do Router. Itere com `for await`.
 *
 * Só pode ser consumido uma vez. `meta` já está disponível antes da iteração,
 * porque vem dos cabeçalhos da resposta.
 */
export class RouterStream<T> implements AsyncIterable<T> {
  /** Metadados de execução lidos dos cabeçalhos da resposta. */
  readonly meta: ResponseMeta;

  #body: ReadableStream<Uint8Array>;
  #decode: StreamDecoder<T>;
  #controller: AbortController;
  #lastEventId: string | undefined;
  #consumed = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    meta: ResponseMeta,
    decode: StreamDecoder<T>,
    controller: AbortController,
    lastEventId?: string,
  ) {
    this.#body = body;
    this.meta = meta;
    this.#decode = decode;
    this.#controller = controller;
    this.#lastEventId = lastEventId;
  }

  /** Id da geração retomável, quando a chamada pediu retomada. */
  get generationId(): string | undefined {
    return this.meta.generationId;
  }

  /**
   * Id do último evento recebido. Se a conexão cair, passe-o em
   * `generations.stream(id, { lastEventId })` para continuar de onde parou.
   */
  get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  /** Encerra o stream e solta a conexão. Não cancela a geração no Router. */
  abort(): void {
    this.#controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    if (this.#consumed) {
      throw new RouterError('Este stream já foi consumido. Faça a chamada de novo para iterar outra vez.');
    }
    this.#consumed = true;

    for await (const event of readSse(this.#body)) {
      if (event.id !== undefined && event.id !== '') this.#lastEventId = event.id;
      const item = this.#decode(event);
      if (item === STREAM_DONE) return;
      if (item !== undefined) yield item;
    }
  }
}
