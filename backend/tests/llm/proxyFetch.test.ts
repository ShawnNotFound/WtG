import { getLlmProxyUrl, resetLlmProxyCacheForTests } from '../../src/llm/proxyFetch';

describe('LLM proxy selection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_USE_PROXY;
    delete process.env.LLM_USE_WINDOWS_PROXY;
    delete process.env.LLM_HTTPS_PROXY;
    delete process.env.LLM_HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    delete process.env.all_proxy;
    resetLlmProxyCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetLlmProxyCacheForTests();
  });

  it('ignores generic Node proxy env vars unless proxy use is explicitly enabled', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    expect(getLlmProxyUrl()).toBeNull();
  });

  it('uses explicit LLM proxy env vars without requiring generic proxy opt-in', () => {
    process.env.LLM_HTTPS_PROXY = '127.0.0.1:7890';
    expect(getLlmProxyUrl()).toBe('http://127.0.0.1:7890');
  });

  it('uses generic proxy env vars when LLM_USE_PROXY=true', () => {
    process.env.LLM_USE_PROXY = 'true';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    expect(getLlmProxyUrl()).toBe('http://127.0.0.1:7890');
  });
});
