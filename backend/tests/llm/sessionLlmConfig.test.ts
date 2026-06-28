import { normalizeModuleLlmConfig } from '../../src/llm/sessionLlmConfig';

describe('normalizeModuleLlmConfig', () => {
  it('normalizes supported module overrides and ignores unknown keys', () => {
    const result = normalizeModuleLlmConfig({
      helper: {
        provider: 'openai',
        model: 'gpt-5.5',
        baseUrl: 'https://api.openai.com/',
      },
      world: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      },
      unsupported: {
        provider: 'openai',
        model: 'ignored',
      },
    });

    expect(result.helper).toEqual({
      provider: 'openai',
      model: 'gpt-5.5',
      baseUrl: 'https://api.openai.com',
    });
    expect(result.world).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    });
    expect((result as Record<string, unknown>).unsupported).toBeUndefined();
  });
});
