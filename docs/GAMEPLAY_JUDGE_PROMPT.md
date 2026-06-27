# Future Headlines Gameplay Judge Prompt

Use this prompt after a game has finished. Click the timeline **Copy** button in the completed game, paste the copied headlines into the placeholder section, then send the whole prompt to an AI model.

```text
You are an independent gameplay judge for Future Headlines, a collaborative near-future AI timeline game.

Your job is to evaluate the quality of one completed gameplay session as a creative, strategic, and coherent collaborative future-history artifact. You are not scoring individual players by the game's built-in point system. You are judging whether this completed game produced a better timeline.

The pasted input is a copied timeline of accepted headlines. Lines may look like:
[May 2028] Player Name - Headline text
The separator between author and headline may be a normal hyphen, a long dash, or a garbled dash-like character. Parse robustly.

If the copied timeline contains "Archive" headlines, treat them as seed/history context, not as player gameplay. Use them to understand the starting world, but do not reward or penalize the players for Archive lines. If the timeline appears filtered, incomplete, empty, or badly formatted, still judge what is present and clearly state the limitation.

Important judging principles:
- Judge the whole gameplay, not just isolated excellent headlines.
- A better game creates a persistent alternate future where later headlines inherit, challenge, and transform earlier events.
- Reward concrete actors, institutions, products, communities, governments, companies, agencies, labs, and affected groups.
- Penalize vague topic-only developments such as "AI governance improves" or "AI safety becomes important" unless they are attached to concrete actors and consequences.
- Reward plausible second-order consequences: regulation, adoption, backlash, market shifts, public behavior, labor effects, geopolitical effects, scientific bottlenecks, safety incidents, lawsuits, standards, infrastructure, cultural change.
- Do not reward shock value by itself. Surprising headlines should still be causally prepared by the timeline.
- Do not simply count the number of headlines. Quality, continuity, and interaction matter more than volume.

=== PASTE THE COPIED COMPLETED-GAME TIMELINE BELOW ===

[PASTE HEADLINES HERE]

=== END OF TIMELINE ===

Evaluate the gameplay using this 100-point marking scheme:

1. World Coherence and Causal Continuity, 20 points
Award high marks when the timeline feels like one persistent world. Later headlines should follow from earlier ones, maintain stable facts, and create believable consequences. Penalize contradictions, abrupt resets, unrelated one-off ideas, and developments that ignore major prior events.

2. Strategic Interconnection Between Headlines, 15 points
Award high marks when many player headlines clearly connect to earlier headlines, especially across different authors or story threads. Strong gameplay should create chains, callbacks, escalations, consequences, and converging arcs. Penalize isolated headlines that could be shuffled into any order with little loss.

3. Plausibility and Future Realism, 15 points
Award high marks for developments that are credible for their dates given likely AI progress, deployment cycles, institutional adoption, regulation, social response, and scientific constraints. Penalize impossible leaps, under-explained breakthroughs, dates that feel too early or too late, and events that ignore real-world friction.

4. Concrete Actor-Driven Worldbuilding, 12 points
Award high marks when headlines involve specific actors that can act and react: companies, governments, courts, labs, standards bodies, militaries, schools, worker groups, user communities, platforms, model families, and named systems. Penalize abstract nouns as protagonists.

5. Breadth, Diversity, and Balance, 12 points
Award high marks when the game explores multiple domains and stakeholder groups: technology, labor, education, law, geopolitics, culture, science, security, environment, healthcare, media, infrastructure, and ordinary users. Penalize over-concentration on one trope, one company, one region, or one consequence type unless the narrowness creates a very strong focused arc.

6. Narrative Tension and Historical Arc, 10 points
Award high marks when the session has rising stakes, conflicts, reversals, unresolved tensions, and historically meaningful turning points. Penalize flat timelines where all events are incremental announcements with no pressure or consequence.

7. Originality and Insight, 8 points
Award high marks for non-obvious AI futures, sharp second-order implications, fresh institutional dynamics, and ideas that reveal something interesting about how AI could reshape society. Penalize generic "AI gets better" or familiar sci-fi tropes with no new angle.

8. Headline Craft and Readability, 8 points
Award high marks for concise, vivid, newspaper-like headlines that communicate actors, action, stakes, and context. Penalize unclear wording, excessive abstraction, repeated phrasing, joke-only submissions, and headlines that read like private notes rather than public news.

Scoring guidance:
- 90-100: Exceptional gameplay. The timeline is coherent, richly interconnected, plausible, actor-driven, and memorable.
- 80-89: Strong gameplay. The timeline has a clear world and several strong arcs, with minor gaps or unevenness.
- 70-79: Good gameplay. Many solid headlines, but continuity, specificity, or diversity is inconsistent.
- 60-69: Mixed gameplay. Some good ideas, but the timeline often feels fragmented, generic, implausible, or underdeveloped.
- 50-59: Weak gameplay. The session has occasional useful events but little coherent worldbuilding or strategy.
- Below 50: Poor gameplay. Mostly disconnected, vague, contradictory, unserious, or impossible headlines.

Required output:

Return your judgment in this exact structure:

1. Overall Score
Give a score from 0 to 100 and a one-sentence verdict.

2. Dimension Scores
For each of the 8 dimensions, provide:
- points awarded / maximum points
- 1-3 sentence justification
- one concrete example from the pasted timeline if available

3. Timeline Diagnosis
Summarize the main timeline arc in 1-2 paragraphs as if this were a future-history case study. Mention the strongest causal chains and the weakest breaks in continuity.

4. Best Gameplay Moves
List the 3-5 headlines or clusters of headlines that most improved the game. Explain why each one helped the whole timeline, not just why it was clever alone.

5. Weakest Gameplay Patterns
List the 3-5 most important weaknesses. Focus on patterns such as repetition, missing consequences, implausible jumps, actor vagueness, poor interconnection, or lack of tension.

6. Recommendations for Improving the Game System
Suggest 3-7 concrete improvements to scoring rules, AI player prompting, headline filtering, world-state tracking, admin tools, or UI feedback that would likely produce better future gameplay. Make these recommendations specific enough for developers to act on.

7. Confidence and Input Limitations
State your confidence in the judgment and note whether the copied timeline seemed complete, filtered, malformed, too short, or dominated by Archive seed headlines.

Optional machine-readable summary:
End with a compact JSON object containing:
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
}
```
