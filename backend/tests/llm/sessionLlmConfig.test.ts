import { normalizeModuleLlmConfig } from '../../src/llm/sessionLlmConfig';
import {
  DEFAULT_DEEPSEEK_MODEL,
  getJsonProviderConfig,
  normalizeJsonModelSelection,
} from '../../src/llm/jsonModelClient';

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

  it('forces every DeepSeek model selection to V4 Flash', () => {
    expect(DEFAULT_DEEPSEEK_MODEL).toBe('deepseek-v4-flash');

    expect(normalizeJsonModelSelection({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    }).model).toBe(DEFAULT_DEEPSEEK_MODEL);

    expect(getJsonProviderConfig('LLM', {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    }).model).toBe(DEFAULT_DEEPSEEK_MODEL);
  });
});
