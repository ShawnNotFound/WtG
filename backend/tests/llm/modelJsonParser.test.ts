import { parseModelJson } from '../../src/llm/modelJsonParser';

describe('modelJsonParser', () => {
  it('parses valid JSON directly', () => {
    const parsed = parseModelJson<{ ok: boolean }>('{"ok":true}');

    expect(parsed.output).toEqual({ ok: true });
    expect(parsed.jsonText).toBe('{"ok":true}');
  });

  it('extracts a JSON object from markdown or surrounding text', () => {
    const parsed = parseModelJson<{ ok: boolean }>('Here is the result:\n```json\n{"ok":true}\n```');

    expect(parsed.output).toEqual({ ok: true });
  });

  it('repairs raw line breaks inside JSON strings', () => {
    const raw = '{\n"narrative":"First paragraph.\n\nSecond paragraph.",\n"themes":["AI"]\n}';
    const parsed = parseModelJson<{ narrative: string; themes: string[] }>(raw);

    expect(parsed.output).toEqual({
      narrative: 'First paragraph.\n\nSecond paragraph.',
      themes: ['AI'],
    });
    expect(parsed.jsonText).toContain('\\n\\n');
  });

  it('throws when the model output does not contain JSON', () => {
    expect(() => parseModelJson('This is not JSON')).toThrow();
  });
});
