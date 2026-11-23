import { describe, expect, it } from 'vitest';
import { parseRouting } from '../src/index.js';

describe('parseRouting', () => {
  it('devolve undefined sem cabeçalho', () => {
    expect(parseRouting(null)).toBeUndefined();
    expect(parseRouting('  ')).toBeUndefined();
  });

  it('lê o escopo de alias', () => {
    expect(parseRouting('organization')).toEqual({ kind: 'alias', scope: 'organization', raw: 'organization' });
    expect(parseRouting('platform')).toMatchObject({ kind: 'alias', scope: 'platform' });
  });

  it('lê a decisão do Auto, com e sem fallback', () => {
    expect(parseRouting('auto; layer=llm_classifier; tier=$$$')).toMatchObject({ kind: 'auto', layer: 'llm_classifier', tier: '$$$' });
    expect(parseRouting('auto; layer=fallback; tier=$; fallback=classifier_timeout')).toMatchObject({
      kind: 'auto',
      fallback: 'classifier_timeout',
    });
  });

  it('lê roteador de decisão por regra e por probabilidade', () => {
    expect(parseRouting('router=suporte; version=3; tier=rapido; rule=curta; layer=rules')).toEqual({
      kind: 'router',
      slug: 'suporte',
      version: 3,
      tier: 'rapido',
      rule: 'curta',
      probability: undefined,
      layer: 'rules',
      fallback: undefined,
      raw: 'router=suporte; version=3; tier=rapido; rule=curta; layer=rules',
    });
    expect(parseRouting('router=adalink/cheap; version=1; tier=$; p=0.82; layer=threshold')).toMatchObject({
      kind: 'router',
      slug: 'adalink/cheap',
      probability: 0.82,
    });
  });

  it('preserva o valor cru em formato desconhecido', () => {
    expect(parseRouting('algo-novo; x=1')).toEqual({ kind: 'unknown', raw: 'algo-novo; x=1' });
  });
});
