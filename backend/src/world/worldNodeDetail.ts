export interface WorldNodeDetail {
  description: string;
  changes: {
    recent: string;
    mediumTerm: string;
    longTerm: string;
  };
}

const EMPTY_DETAIL: WorldNodeDetail = {
  description: '',
  changes: {
    recent: '',
    mediumTerm: '',
    longTerm: '',
  },
};

function cleanBlock(value: unknown, maxLength = 1200): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function extractSection(text: string, start: RegExp, end?: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch || startMatch.index === undefined) return '';
  const startIndex = startMatch.index + startMatch[0].length;
  const tail = text.slice(startIndex);
  if (!end) return cleanBlock(tail);
  const endMatch = end.exec(tail);
  return cleanBlock(endMatch && endMatch.index !== undefined ? tail.slice(0, endMatch.index) : tail);
}

export function parseWorldNodeSummary(summary: unknown): WorldNodeDetail {
  const text = cleanBlock(summary, 5000);
  if (!text) return { ...EMPTY_DETAIL, changes: { ...EMPTY_DETAIL.changes } };

  const description = extractSection(
    text,
    /^(?:#+\s*)?Description\s*:?\s*$/im,
    /^(?:#+\s*)?(Changes|Recent Changes|Medium[- ]Term Changes|Long[- ]Term Changes)\s*:?\s*$/im
  );

  if (!description) {
    return {
      description: text,
      changes: { recent: '', mediumTerm: '', longTerm: '' },
    };
  }

  return {
    description,
    changes: {
      recent: extractSection(
        text,
        /^(?:#+\s*)?Recent Changes\s*:?\s*$/im,
        /^(?:#+\s*)?(Medium[- ]Term Changes|Long[- ]Term Changes)\s*:?\s*$/im
      ),
      mediumTerm: extractSection(
        text,
        /^(?:#+\s*)?Medium[- ]Term Changes\s*:?\s*$/im,
        /^(?:#+\s*)?Long[- ]Term Changes\s*:?\s*$/im
      ),
      longTerm: extractSection(text, /^(?:#+\s*)?Long[- ]Term Changes\s*:?\s*$/im),
    },
  };
}

export function formatWorldNodeSummary(detail: WorldNodeDetail): string {
  const description = cleanBlock(detail.description, 1200);
  const recent = cleanBlock(detail.changes.recent, 1200);
  const mediumTerm = cleanBlock(detail.changes.mediumTerm, 1200);
  const longTerm = cleanBlock(detail.changes.longTerm, 1200);

  return [
    'Description',
    description || 'No durable description recorded yet.',
    '',
    'Changes',
    'Recent Changes',
    recent || 'None recorded.',
    '',
    'Medium-Term Changes',
    mediumTerm || 'None recorded.',
    '',
    'Long-Term Changes',
    longTerm || 'None recorded.',
  ].join('\n');
}

export function normalizeWorldNodeSummary(summary: unknown, fallbackDescription = ''): string {
  const parsed = parseWorldNodeSummary(summary);
  return formatWorldNodeSummary({
    description: parsed.description || cleanBlock(fallbackDescription, 300),
    changes: parsed.changes,
  });
}

export function mergeWorldNodeSummary(existing: unknown, incoming: unknown, fallbackDescription = ''): string {
  const current = parseWorldNodeSummary(existing);
  const next = parseWorldNodeSummary(incoming);
  const incomingText = cleanBlock(incoming, 5000);
  const incomingStructured = /^(?:#+\s*)?Description\s*:?\s*$/im.test(incomingText);

  if (!incomingText) {
    return normalizeWorldNodeSummary(existing, fallbackDescription);
  }

  if (!incomingStructured && current.description) {
    return formatWorldNodeSummary({
      description: current.description,
      changes: {
        recent: next.description || current.changes.recent,
        mediumTerm: current.changes.mediumTerm,
        longTerm: current.changes.longTerm,
      },
    });
  }

  return formatWorldNodeSummary({
    description: current.description || next.description || cleanBlock(fallbackDescription, 300),
    changes: {
      recent: next.changes.recent || current.changes.recent,
      mediumTerm: next.changes.mediumTerm || current.changes.mediumTerm,
      longTerm: next.changes.longTerm || current.changes.longTerm,
    },
  });
}
