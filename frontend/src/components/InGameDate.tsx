import { Card, SectionTitle } from './ui';

interface InGameDateProps {
  inGameNow: string | null;
}

export function InGameDate({ inGameNow }: InGameDateProps) {
  if (!inGameNow) return null;

  const date = new Date(inGameNow);
  const formatted = date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <Card padding="sm">
      <SectionTitle>Current Date</SectionTitle>
      <div style={{ containerType: 'inline-size' }}>
        <div
          className="font-bold text-gray-800 leading-tight tracking-tight whitespace-nowrap text-center"
          style={{ fontSize: 'clamp(1rem, 13cqw, 3rem)' }}
        >
          {formatted}
        </div>
      </div>
    </Card>
  );
}
