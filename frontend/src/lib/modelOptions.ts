export type AiProvider = 'openai' | 'deepseek';

export interface ModelOption {
  label: string;
  value: string;
}

export const MODEL_OPTIONS: Record<AiProvider, ModelOption[]> = {
  deepseek: [
    { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
  ],
  openai: [
    { label: 'GPT-5.5', value: 'gpt-5.5' },
    { label: 'GPT-5.5 Pro', value: 'gpt-5.5-pro' },
    { label: 'GPT-5.4', value: 'gpt-5.4' },
    { label: 'GPT-5.4 Pro', value: 'gpt-5.4-pro' },
    { label: 'GPT-5.4 Mini', value: 'gpt-5.4-mini' },
    { label: 'GPT-5.4 Nano', value: 'gpt-5.4-nano' },
    { label: 'GPT-5.2', value: 'gpt-5.2' },
    { label: 'GPT-5.2 Pro', value: 'gpt-5.2-pro' },
    { label: 'GPT-5.2 Chat Latest', value: 'gpt-5.2-chat-latest' },
    { label: 'GPT-5.1', value: 'gpt-5.1' },
    { label: 'GPT-5.1 Chat Latest', value: 'gpt-5.1-chat-latest' },
    { label: 'GPT-5.1 Mini', value: 'gpt-5.1-mini' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-5 Mini', value: 'gpt-5-mini' },
    { label: 'GPT-5 Nano', value: 'gpt-5-nano' },
  ],
};

export function defaultModelForProvider(provider: AiProvider): string {
  return MODEL_OPTIONS[provider][0].value;
}

export function modelOptionsForProvider(provider: AiProvider): ModelOption[] {
  return MODEL_OPTIONS[provider];
}

export function modelOptionsForValue(provider: AiProvider, value: string): ModelOption[] {
  const options = modelOptionsForProvider(provider);
  if (provider === 'deepseek') {
    return options;
  }
  if (!value || options.some((option) => option.value === value)) {
    return options;
  }
  return [{ label: `${value} (current)`, value }, ...options];
}

export function baseUrlForProvider(provider: AiProvider): string {
  return provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com';
}
