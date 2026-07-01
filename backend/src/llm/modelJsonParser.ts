export interface ParsedModelJson<T> {
  output: T;
  jsonText: string;
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

function escapeControlCharactersInsideStrings(text: string): string {
  let result = '';
  let inString = false;
  let escaping = false;

  for (const char of text) {
    if (inString) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }

      if (char === '\\') {
        result += char;
        escaping = true;
        continue;
      }

      if (char === '"') {
        result += char;
        inString = false;
        continue;
      }

      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char < ' ') {
        result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }

      result += char;
      continue;
    }

    result += char;
    if (char === '"') {
      inString = true;
    }
  }

  return result;
}

export function parseModelJson<T>(rawText: string): ParsedModelJson<T> {
  const stripped = stripJsonCodeFence(rawText);
  const candidates = [
    stripped,
    extractFirstJsonObject(stripped),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  let lastError: unknown = null;

  for (const candidate of candidates) {
    for (const jsonText of [candidate, escapeControlCharactersInsideStrings(candidate)]) {
      if (seen.has(jsonText)) continue;
      seen.add(jsonText);

      try {
        return {
          output: JSON.parse(jsonText) as T,
          jsonText,
        };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Model output is not valid JSON');
}
