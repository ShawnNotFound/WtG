import { execFileSync } from 'node:child_process';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const WINDOWS_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let cachedProxyUrl: string | null | undefined;
let cachedFetch: typeof fetch | null = null;
let cachedFetchProxyUrl: string | null = null;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && value.trim().length > 0);
}

function normalizeProxyUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }

  return `http://${value}`;
}

function parseWindowsProxyServer(proxyServer: string | undefined): string | null {
  if (!proxyServer) return null;

  if (!proxyServer.includes('=')) {
    return normalizeProxyUrl(proxyServer);
  }

  const entries = proxyServer
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [scheme, ...rest] = entry.split('=');
      return [scheme.toLowerCase(), rest.join('=')] as const;
    });

  const httpsProxy = entries.find(([scheme]) => scheme === 'https')?.[1];
  const httpProxy = entries.find(([scheme]) => scheme === 'http')?.[1];

  return normalizeProxyUrl(httpsProxy || httpProxy);
}

function queryWindowsRegistryValue(valueName: string): string | undefined {
  try {
    const output = execFileSync(
      'reg',
      ['query', WINDOWS_INTERNET_SETTINGS, '/v', valueName],
      { encoding: 'utf8', windowsHide: true }
    );
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.includes(valueName));
    return line?.trim().split(/\s{2,}/).at(-1);
  } catch {
    return undefined;
  }
}

function windowsProxyUrl(): string | null {
  if (process.platform !== 'win32') return null;
  if (process.env.LLM_USE_WINDOWS_PROXY === 'false') return null;

  const enabled = queryWindowsRegistryValue('ProxyEnable');
  if (!enabled || enabled === '0x0') return null;

  return parseWindowsProxyServer(queryWindowsRegistryValue('ProxyServer'));
}

export function getLlmProxyUrl(): string | null {
  if (cachedProxyUrl !== undefined) {
    return cachedProxyUrl;
  }

  cachedProxyUrl = normalizeProxyUrl(
    firstNonEmpty(
      process.env.LLM_HTTPS_PROXY,
      process.env.LLM_HTTP_PROXY,
      process.env.HTTPS_PROXY,
      process.env.https_proxy,
      process.env.HTTP_PROXY,
      process.env.http_proxy,
      process.env.ALL_PROXY,
      process.env.all_proxy
    )
  ) ?? windowsProxyUrl();

  if (cachedProxyUrl) {
    console.log(`[LLM] Using HTTP proxy for model API calls: ${cachedProxyUrl}`);
  }

  return cachedProxyUrl;
}

export function getDefaultFetch(): typeof fetch {
  const proxyUrl = getLlmProxyUrl();
  if (!proxyUrl) {
    return fetch;
  }

  if (cachedFetch && cachedFetchProxyUrl === proxyUrl) {
    return cachedFetch;
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  cachedFetchProxyUrl = proxyUrl;
  cachedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never) as unknown as ReturnType<typeof fetch>) as typeof fetch;

  return cachedFetch;
}
