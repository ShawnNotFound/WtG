export function buildGameplayJudgePrompt(timeline: string): string {
  return `You are an independent gameplay judge for Future Headlines, a collaborative near-future AI timeline game.

Your job is to evaluate the quality of one completed gameplay session as a creative, strategic, and coherent collaborative future-history artifact. You are not scoring individual players by the game's built-in point system. You are judging whether this completed game produced a better timeline.

The pasted input is a copied timeline of accepted headlines. Lines may look like:
[May 2028] Player Name - Headline text
The separator between author and headline may be a normal hyphen, a long dash, or a garbled dash-like character. Parse robustly.

If the copied timeline contains "Archive" headlines, treat them as seed/history context, not as player gameplay. Use them to understand the starting world, but do not reward or penalize the players for Archive lines. If the timeline appears filtered, incomplete, empty, or badly formatted, still judge what is present and clearly state the limitation.

Important judging principles:
- Judge the whole gameplay, not just isolated excellent headlines.
- A better game creates a persistent alternate future where later headlines inherit, challenge, and transform earlier events.
- Reward concrete actors, institutions, products, communities, governments, companies, agencies, labs, and affected groups.
- Penalize vague topic-only developments such as "AI governance improves" or "AI safety becomes important" unless attached to concrete actors and consequences.
- Reward plausible second-order consequences: regulation, adoption, backlash, market shifts, public behavior, labor effects, geopolitics, science bottlenecks, safety incidents, lawsuits, standards, infrastructure, and cultural change.
- Do not reward shock value by itself. Surprising headlines should still be causally prepared by the timeline.
- Do not simply count headlines. Quality, continuity, and interaction matter more than volume.

=== PASTE THE COPIED COMPLETED-GAME TIMELINE BELOW ===

${timeline}

=== END OF TIMELINE ===

Evaluate the gameplay using this 100-point marking scheme:

1. World Coherence and Causal Continuity, 20 points
2. Strategic Interconnection Between Headlines, 15 points
3. Plausibility and Future Realism, 15 points
4. Concrete Actor-Driven Worldbuilding, 12 points
5. Breadth, Diversity, and Balance, 12 points
6. Narrative Tension and Historical Arc, 10 points
7. Originality and Insight, 8 points
8. Headline Craft and Readability, 8 points

Scoring guidance:
- 90-100: Exceptional gameplay.
- 80-89: Strong gameplay.
- 70-79: Good gameplay.
- 60-69: Mixed gameplay.
- 50-59: Weak gameplay.
- Below 50: Poor gameplay.

Required output:

Return concise prose sections for:
1. Overall Score
2. Dimension Scores
3. Timeline Diagnosis
4. Best Gameplay Moves
5. Weakest Gameplay Patterns
6. Recommendations for Improving the Game System
7. Confidence and Input Limitations

End with exactly one compact JSON object in this shape. This JSON is required because it will be pasted into an evaluation dashboard:
{
  "overall_score": number,
  "grade_band": string,
  "dimension_scores": {
    "world_coherence": number,
    "interconnection": number,
    "plausibility": number,
    "actor_worldbuilding": number,
    "breadth_balance": number,
    "narrative_arc": number,
    "originality": number,
    "headline_craft": number
  },
  "top_strengths": string[],
  "top_weaknesses": string[],
  "system_recommendations": string[],
  "confidence": "low" | "medium" | "high"
}`;
}

