#!/usr/bin/env python3
"""
experiment: generate a narrative fictional story-style summary
from the full 20-year timeline of an existing playtest session.

usage: python3 run.py
requires: openai_api_key in environment or in backend/.env
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

SESSION_ID = "64cd0a5b-3af6-413f-8ce2-8c3cd6cb31cd"
MODEL = "gpt-5.2"

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

# fetch timeline from db
print("Fetching timeline from database...")
result = subprocess.run(
    [
        "psql", CONN, "-t", "-c",
        f"""SELECT json_agg(
            json_build_object(
                'date', to_char(in_game_submitted_at, 'YYYY-MM'),
                'headline', COALESCE(selected_headline, headline_text)
            ) ORDER BY in_game_submitted_at
        )
        FROM game_session_headlines
        WHERE session_id = '{SESSION_ID}'
          AND in_game_submitted_at IS NOT NULL;"""
    ],
    capture_output=True, text=True, check=True,
)
timeline = json.loads(result.stdout.strip())
print(f"  Loaded {len(timeline)} headlines")

# build prompt
timeline_text = "\n".join(
    f"[{h['date']}] {h['headline']}" for h in timeline
)

SYSTEM_INSTRUCTIONS = """You are a literary fiction writer crafting a set of short personal accounts set against 20 years of real and imagined AI history. You are given a chronological list of news headlines spanning 2022 to 2046. Your task is NOT to summarise them, report them, or recap them — your task is to write multiple short first-person "experience reports" that together illustrate different facets of what happened in this period.

Each experience report should:
- Be written in first person, past tense
- Follow ONE fictional character (invent them — name, job, era) living through a slice of this period
- Reference specific events from the headlines as background or personal moments in their life
- Show how AI reshaped their life, work, relationships, or beliefs
- Feel grounded and human, not grand or speeches-y
- Avoid game language: never mention headlines, rounds, players, scores, planets, or submissions

Each report should be 500-1000 words. Together they should illuminate different facets of this era: different classes, professions, geographies, eras, emotional stakes, and angles. Do not repeat the same kind of character or viewpoint across reports.

The characters should feel real. Show them noticing specific events, reacting to them, being changed by them. The headlines are their lived reality. Do not simply list events — make them part of lives being lived.

Always output valid JSON matching the required schema."""

USER_PROMPT = f"""Below is the timeline of events from 2022 to 2046 in this alternate history. Use it as the world your characters live in. Do not list or summarise the events — weave them into first-person experience reports.

=== TIMELINE ===
{timeline_text}

=== YOUR TASK ===
Write 3 first-person experience reports, each 500-1000 words, from different characters living through this period. Together they should illustrate multiple facets of what happened (e.g. different jobs, classes, countries, eras, emotional stakes — pick whatever contrasts feel most illuminating). Each character should notice specific events as they happen to them personally. End each report with a brief reflection on how the world changed them."""

SCHEMA = {
    "name": "narrative_summary",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "reports": {
                "type": "array",
                "description": "Three first-person experience reports from different characters",
                "items": {
                    "type": "object",
                    "properties": {
                        "character": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "role": {"type": "string"},
                                "era": {"type": "string"},
                            },
                            "required": ["name", "role", "era"],
                            "additionalProperties": False,
                        },
                        "story": {
                            "type": "string",
                            "description": "500-1000 word first-person experience report",
                        },
                        "themes_touched": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "3-5 phrases naming what this report is really about",
                        },
                    },
                    "required": ["character", "story", "themes_touched"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["reports"],
        "additionalProperties": False,
    },
}

# call openai responses api
print(f"Calling OpenAI Responses API (model={MODEL})...")
request_body = {
    "model": MODEL,
    "instructions": SYSTEM_INSTRUCTIONS,
    "input": USER_PROMPT,
    "text": {
        "format": {
            "type": "json_schema",
            **SCHEMA,
        }
    },
}

req = urllib.request.Request(
    "https://api.openai.com/v1/responses",
    data=json.dumps(request_body).encode(),
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=300) as response:
        result = json.loads(response.read().decode())
except urllib.error.HTTPError as e:
    print(f"HTTP Error {e.code}: {e.read().decode()}", file=sys.stderr)
    sys.exit(1)

# extract text output
output_text = None
for item in result.get("output", []):
    if item.get("type") == "message":
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                output_text = content.get("text")
                break

if not output_text:
    print("ERROR: No output_text in response", file=sys.stderr)
    print(json.dumps(result, indent=2))
    sys.exit(1)

parsed = json.loads(output_text)
reports = parsed["reports"]

# print + save
for i, rep in enumerate(reports):
    print("\n" + "=" * 70)
    print(f"REPORT #{i + 1}")
    print("=" * 70)
    print(f"Name: {rep['character']['name']}")
    print(f"Role: {rep['character']['role']}")
    print(f"Era:  {rep['character']['era']}")
    print()
    print(rep["story"])
    print()
    print("Themes:")
    for theme in rep["themes_touched"]:
        print(f"  - {theme}")

# save output
output_file = Path(__file__).parent / "output-v2.md"
md_parts = [
    f"# Narrative Summary Experiment V2: Multiple Experience Reports",
    "",
    f"**Session:** {SESSION_ID}  ",
    f"**Model:** {MODEL}  ",
    f"**Headlines:** {len(timeline)}  ",
    f"**Reports:** {len(reports)}  ",
    "",
    "---",
    "",
]
for i, rep in enumerate(reports):
    md_parts.extend([
        f"## Report #{i + 1}: {rep['character']['name']}",
        "",
        f"- **Role:** {rep['character']['role']}",
        f"- **Era:** {rep['character']['era']}",
        "",
        "### Story",
        "",
        rep["story"],
        "",
        "### Themes Touched",
        "",
        *[f"- {t}" for t in rep["themes_touched"]],
        "",
        "---",
        "",
    ])

md_parts.extend([
    "## Prompt Used",
    "",
    "### System Instructions",
    "",
    "```",
    SYSTEM_INSTRUCTIONS,
    "```",
    "",
    "### User Prompt (timeline truncated)",
    "",
    "```",
    "Below is the timeline of events from 2022 to 2046 in this alternate history.",
    "Use it as the world your characters live in. Do not list or summarise the",
    "events — weave them into first-person experience reports.",
    "",
    "=== TIMELINE ===",
    *[f"[{h['date']}] {h['headline']}" for h in timeline[:10]],
    f"... ({len(timeline) - 10} more headlines) ...",
    "",
    "=== YOUR TASK ===",
    "Write 3 first-person experience reports, each 500-1000 words, from different",
    "characters living through this period. Together they should illustrate",
    "multiple facets of what happened.",
    "```",
    "",
    "## Stats",
    "",
    f"- Input tokens: {result.get('usage', {}).get('input_tokens', 'N/A')}",
    f"- Output tokens: {result.get('usage', {}).get('output_tokens', 'N/A')}",
])

output_file.write_text("\n".join(md_parts))
print(f"\nSaved to {output_file}")
