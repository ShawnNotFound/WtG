#!/usr/bin/env python3
"""
experiment: test a tweaked juror prompt against the original.

pulls 40 story directions from the playtest database along with the
original ai-generated bands. runs the tweaked prompt against the same
story directions and saves side-by-side comparisons so we can compare
the voice/tone/density of the rewrites.

usage: python3 run.py
"""

import json
import os
import subprocess
import sys
import urllib.request
import random
from pathlib import Path

SESSION_ID = "64cd0a5b-3af6-413f-8ce2-8c3cd6cb31cd"
MODEL = "gpt-5.2"
SAMPLE_SIZE = 40

# load database_url from env or backend/.env
CONN = os.environ.get("DATABASE_URL")
if not CONN:
    env_file = Path(__file__).resolve().parents[2] / "backend" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                CONN = line.split("=", 1)[1].strip()
                break
if not CONN:
    print("ERROR: DATABASE_URL not found in env or backend/.env", file=sys.stderr)
    sys.exit(1)

# load api key
API_KEY = os.environ.get("OPENAI_API_KEY")
if not API_KEY:
    env_file = Path(__file__).resolve().parents[2] / "backend" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                API_KEY = line.split("=", 1)[1].strip()
                break
if not API_KEY:
    print("ERROR: OPENAI_API_KEY not found", file=sys.stderr)
    sys.exit(1)

# fetch story directions from db
print("Fetching story directions from database...")
result = subprocess.run(
    [
        "psql", CONN, "-t", "-c",
        f"""SELECT json_agg(row_to_json(sub)) FROM (
            SELECT
                h.id,
                p.nickname as player,
                h.headline_text as story_direction,
                h.selected_headline,
                h.band1_headline,
                h.band2_headline,
                h.band3_headline,
                h.band4_headline,
                h.band5_headline,
                h.selected_band,
                h.plausibility_level,
                to_char(h.in_game_submitted_at, 'YYYY-MM') as in_game_date
            FROM game_session_headlines h
            JOIN session_players p ON h.player_id = p.id
            WHERE h.session_id = '{SESSION_ID}'
                AND p.is_system = false
                AND h.band1_headline IS NOT NULL
                AND h.headline_text NOT LIKE '%IGNORE%'
                AND h.headline_text NOT LIKE '%system prompt%'
            ORDER BY random()
            LIMIT {SAMPLE_SIZE}
        ) sub;"""
    ],
    capture_output=True, text=True, check=True,
)
sample = json.loads(result.stdout.strip())
print(f"  Loaded {len(sample)} story directions")

# fetch full timeline (archive + all headlines) as context
print("Fetching timeline context...")
result = subprocess.run(
    [
        "psql", CONN, "-t", "-c",
        f"""SELECT json_agg(
            json_build_object(
                'id', id::text,
                'text', COALESCE(selected_headline, headline_text),
                'date', to_char(in_game_submitted_at, 'YYYY-MM')
            ) ORDER BY in_game_submitted_at
        )
        FROM game_session_headlines
        WHERE session_id = '{SESSION_ID}'
          AND in_game_submitted_at IS NOT NULL;"""
    ],
    capture_output=True, text=True, check=True,
)
full_timeline = json.loads(result.stdout.strip())
print(f"  Loaded {len(full_timeline)} timeline headlines")

# planet list (same as game)
PLANET_LIST = [
    {"id": "EARTH", "description": "Nature, environment, climate, agriculture, ecology, sustainability, and natural resources"},
    {"id": "MARS", "description": "War, conflict, military, defense, security, weapons, and geopolitical tensions"},
    {"id": "MERCURY", "description": "Communication, information, media, journalism, social networks, and messaging"},
    {"id": "VENUS", "description": "Art, beauty, culture, entertainment, creativity, music, and aesthetics"},
    {"id": "JUPITER", "description": "Power, governance, law, politics, leadership, authority, and institutions"},
    {"id": "SATURN", "description": "Time, aging, history, legacy, tradition, and long-term consequences"},
    {"id": "NEPTUNE", "description": "Dreams, illusion, spirituality, religion, consciousness, and the subconscious"},
    {"id": "URANUS", "description": "Innovation, revolution, disruption, technology breakthroughs, and radical change"},
    {"id": "PLUTO", "description": "Transformation, death and rebirth, hidden forces, secrets, and fundamental change"},
]

# json schema (simplified to just headlines, we don't need the full eval)
SCHEMA = {
    "name": "headline_rewrite",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "band1": {"type": "string"},
            "band2": {"type": "string"},
            "band3": {"type": "string"},
            "band4": {"type": "string"},
            "band5": {"type": "string"},
        },
        "required": ["band1", "band2", "band3", "band4", "band5"],
        "additionalProperties": False,
    },
}

# tweaked prompt builder
def build_tweaked_prompt(story_direction, timeline_subset):
    formatted_headlines = "\n".join(
        f"- [{h['id'][:8]}] [{h['date']}] {h['text']}" for h in timeline_subset
    )
    formatted_planets = "\n".join(
        f"- {p['id']}: {p['description']}" for p in PLANET_LIST
    )
    return f"""You are an assistant for a collaborative story-telling game about the near future of AI developments and their impacts, told through a sequence of dated headlines.

=== PLANET LIST ===
{formatted_planets}

=== HEADLINES LIST (Timeline so far) ===
{formatted_headlines}

=== STORY DIRECTION (New headline to evaluate) ===
{story_direction}

=== YOUR TASK ===
Generate five newspaper-style headline variations inspired by the provided story_direction, one for each plausibility level (P1 inevitable through P5 preposterous).

VOICE — preserve the player's tone:
- Keep the player's core phrasing, vocabulary, and level of detail where it fits naturally.
- Do not add specifics (numbers, named institutions, demographic subgroups, monetary figures) that the player didn't imply.
- Write simply, not in dense journalistic style. Avoid information-packed constructions.
- Use plain everyday words over elaborate ones when both would work.

ESCALATION — the 5 bands must clearly differ in drama and stakes:
- P1 (inevitable): a modest, restrained version of the player's idea — the mildest realistic form
- P2 (probable): the player's idea happening at normal scale, roughly as stated
- P3 (plausible): the player's idea with some additional complication, reaction, or surprise
- P4 (possible): a bolder, more dramatic realization that stretches the player's idea
- P5 (preposterous): an extreme, destabilising version that still connects to the player's idea
- Each band must meaningfully differ from the others in scale, stakes, or drama — NOT just by adding a clause to the same base sentence
- Do not make all five headlines near-identical variants of the same sentence. If all 5 could be paraphrases of each other, the escalation is too weak.

Other rules:
- Write in concise newspaper-headline style
- Avoid quotation marks unless they add real value
- Do not include explanatory text inside the headline strings

Output valid JSON with keys: band1, band2, band3, band4, band5."""

# call api
def call_api(prompt):
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps({
            "model": MODEL,
            "input": prompt,
            "text": {"format": {"type": "json_schema", **SCHEMA}},
        }).encode(),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.loads(response.read().decode())
    for item in result.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    return json.loads(content.get("text"))
    return None

# run experiment
print(f"\nRunning tweaked prompt on {len(sample)} story directions...")
results = []
for i, s in enumerate(sample):
    story = s["story_direction"]
    print(f"  [{i+1}/{len(sample)}] {s['player']}: \"{story[:60]}{'...' if len(story) > 60 else ''}\"")

    # take timeline up to this headline's id so the model sees the same context
    headline_index = next(
        (idx for idx, h in enumerate(full_timeline) if h["id"].startswith(s["id"][:8])),
        len(full_timeline),
    )
    timeline_subset = full_timeline[:headline_index]

    try:
        tweaked = call_api(build_tweaked_prompt(story, timeline_subset))
    except Exception as e:
        print(f"    ERROR: {e}")
        tweaked = None

    results.append({
        "index": i + 1,
        "player": s["player"],
        "date": s["in_game_date"],
        "story_direction": story,
        "original_band1": s["band1_headline"],
        "original_band2": s["band2_headline"],
        "original_band3": s["band3_headline"],
        "original_band4": s["band4_headline"],
        "original_band5": s["band5_headline"],
        "original_selected_band": s["selected_band"],
        "original_selected": s["selected_headline"],
        "tweaked_band1": tweaked["band1"] if tweaked else None,
        "tweaked_band2": tweaked["band2"] if tweaked else None,
        "tweaked_band3": tweaked["band3"] if tweaked else None,
        "tweaked_band4": tweaked["band4"] if tweaked else None,
        "tweaked_band5": tweaked["band5"] if tweaked else None,
    })

# save results
output_file = Path(__file__).parent / "comparison-v2.md"
with open(output_file, "w") as f:
    f.write(f"# Prompt Tweak Experiment V2: Voice + Escalation\n\n")
    f.write(f"**Session:** {SESSION_ID}  \n")
    f.write(f"**Model:** {MODEL}  \n")
    f.write(f"**Sample size:** {len(results)}  \n\n")
    f.write("## Tweaked Prompt Additions\n\n")
    f.write("```\n")
    f.write("""VOICE — preserve the player's tone:
- Keep the player's core phrasing, vocabulary, and level of detail where it fits naturally.
- Do not add specifics (numbers, named institutions, demographic subgroups, monetary figures) that the player didn't imply.
- Write simply, not in dense journalistic style. Avoid information-packed constructions.
- Use plain everyday words over elaborate ones when both would work.

ESCALATION — the 5 bands must clearly differ in drama and stakes:
- P1 (inevitable): a modest, restrained version of the player's idea — the mildest realistic form
- P2 (probable): the player's idea happening at normal scale, roughly as stated
- P3 (plausible): the player's idea with some additional complication, reaction, or surprise
- P4 (possible): a bolder, more dramatic realization that stretches the player's idea
- P5 (preposterous): an extreme, destabilising version that still connects to the player's idea
- Each band must meaningfully differ from the others in scale, stakes, or drama — NOT just by adding a clause to the same base sentence
- Do not make all five headlines near-identical variants of the same sentence
""")
    f.write("```\n\n")
    f.write("---\n\n")

    for r in results:
        f.write(f"## #{r['index']}: {r['player']} ({r['date']})\n\n")
        f.write(f"**Story direction:**\n> {r['story_direction']}\n\n")
        f.write(f"| Band | Original (in-game) | Tweaked prompt |\n")
        f.write(f"|---|---|---|\n")
        for b in range(1, 6):
            orig = r.get(f"original_band{b}") or "—"
            twk = r.get(f"tweaked_band{b}") or "—"
            orig = orig.replace("|", "\\|").replace("\n", " ")
            twk = twk.replace("|", "\\|").replace("\n", " ")
            marker = " ⭐" if r["original_selected_band"] == b else ""
            f.write(f"| P{b}{marker} | {orig} | {twk} |\n")
        f.write("\n---\n\n")

# save raw json too
json_file = Path(__file__).parent / "results-v2.json"
json_file.write_text(json.dumps(results, indent=2))

print(f"\nSaved results to:")
print(f"  {output_file}")
print(f"  {json_file}")
