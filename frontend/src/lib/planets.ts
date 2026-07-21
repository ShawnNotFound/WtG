/**
 * shared planet metadata for the frontend: keyword tags and colour classes.
 * the colour class strings are written out in full so Tailwind's content
 * scanner keeps them in the build.
 */

export const PLANET_TAGS: Record<string, string[]> = {
  EARTH:   ['Nature', 'Environment', 'Climate', 'Humanity', 'Justice'],
  MARS:    ['War', 'Conflict', 'Military', 'Defense', 'Security'],
  MERCURY: ['Communication', 'Media', 'Journalism', 'Networks', 'Information'],
  VENUS:   ['Art', 'Beauty', 'Culture', 'Entertainment', 'Creativity'],
  JUPITER: ['Power', 'Governance', 'Politics', 'Leadership', 'Institutions'],
  SATURN:  ['Time', 'Aging', 'Legacy', 'Tradition', 'History'],
  NEPTUNE: ['Dreams', 'Spirituality', 'Consciousness', 'Illusion', 'Religion'],
  URANUS:  ['Innovation', 'Revolution', 'Disruption', 'Technology', 'Breakthroughs'],
  PLUTO:   ['Transformation', 'Hidden forces', 'Secrets', 'Rebirth', 'Upheaval'],
};

export interface PlanetColor {
  /** left-border colour (for the headline feed) */
  borderL: string;
  /** light background tint */
  bg: string;
  /** text colour */
  text: string;
  /** solid dot / chip colour */
  dot: string;
}

export const PLANET_COLORS: Record<string, PlanetColor> = {
  EARTH:   { borderL: 'border-l-green-400',  bg: 'bg-green-50',  text: 'text-green-700',  dot: 'bg-green-400' },
  MARS:    { borderL: 'border-l-red-400',    bg: 'bg-red-50',    text: 'text-red-700',    dot: 'bg-red-400' },
  MERCURY: { borderL: 'border-l-cyan-400',   bg: 'bg-cyan-50',   text: 'text-cyan-700',   dot: 'bg-cyan-400' },
  VENUS:   { borderL: 'border-l-pink-400',   bg: 'bg-pink-50',   text: 'text-pink-700',   dot: 'bg-pink-400' },
  JUPITER: { borderL: 'border-l-orange-400', bg: 'bg-orange-50', text: 'text-orange-700', dot: 'bg-orange-400' },
  SATURN:  { borderL: 'border-l-yellow-400', bg: 'bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-400' },
  NEPTUNE: { borderL: 'border-l-blue-400',   bg: 'bg-blue-50',   text: 'text-blue-700',   dot: 'bg-blue-400' },
  URANUS:  { borderL: 'border-l-teal-400',   bg: 'bg-teal-50',   text: 'text-teal-700',   dot: 'bg-teal-400' },
  PLUTO:   { borderL: 'border-l-purple-400', bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-400' },
};

export function planetColor(id: string | undefined | null): PlanetColor | null {
  if (!id) return null;
  return PLANET_COLORS[id] ?? null;
}
