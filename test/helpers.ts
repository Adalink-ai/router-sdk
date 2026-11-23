import type { FetchLike } from '../src/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** `fetch` falso que grava cada chamada e responde pela função recebida. */
export function mockFetch(responder: Responder): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetch, calls };
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** Resposta SSE entregue nos pedaços informados, para exercitar eventos cortados no meio. */
export function sse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

export const GENERATION_ID = '019ab3c4-5d6e-7f80-9a1b-2c3d4e5f6071';
