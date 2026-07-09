/**
 * planet definitions for the future headlines game.
 * planets represent thematic categories for headlines, themed around greek/roman gods.
 */

import { PlanetEntry } from '../prompts/jurorPrompt.js';

/**
 * default planet list for the game.
 * each planet represents a different aspect or domain of ai development and impact.
 */
export const DEFAULT_PLANETS: PlanetEntry[] = [
  {
    id: 'EARTH',
    description:
      'Nature, environment, climate, humanity, justice, agriculture, and natural resources. Headlines about AI impact on the natural world and humane/just outcomes for people.',
  },
  {
    id: 'MARS',
    description:
      'War, conflict, military, defense, security, weapons, and geopolitical tensions. Headlines about AI in warfare and defense.',
  },
  {
    id: 'MERCURY',
    description:
      'Communication, information, media, journalism, social networks, and messaging. Headlines about AI in information and communication.',
  },
  {
    id: 'VENUS',
    description:
      'Art, beauty, culture, entertainment, creativity, music, and aesthetics. Headlines about AI in creative and cultural domains.',
  },
  {
    id: 'JUPITER',
    description:
      'Power, governance, law, politics, leadership, authority, and institutions. Headlines about AI in government and institutional power.',
  },
  {
    id: 'SATURN',
    description:
      'Time, aging, history, legacy, tradition, and long-term consequences. Headlines about AI effects on society over time.',
  },
  {
    id: 'NEPTUNE',
    description:
      'Dreams, illusion, spirituality, religion, consciousness, and the subconscious. Headlines about AI and human consciousness or spirituality.',
  },
  {
    id: 'URANUS',
    description:
      'Innovation, revolution, disruption, technology breakthroughs, and radical change. Headlines about revolutionary AI developments.',
  },
  {
    id: 'PLUTO',
    description:
      'Transformation, death and rebirth, hidden forces, secrets, and fundamental change. Headlines about AI causing profound societal transformation.',
  },
];

/**
 * get the default planet list.
 */
export function getDefaultPlanets(): PlanetEntry[] {
  return DEFAULT_PLANETS;
}

/**
 * get a planet by id.
 */
export function getPlanetById(id: string): PlanetEntry | undefined {
  return DEFAULT_PLANETS.find((p) => p.id === id);
}

/**
 * get planet ids only.
 */
export function getPlanetIds(): string[] {
  return DEFAULT_PLANETS.map((p) => p.id);
}
