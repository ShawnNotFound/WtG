# Future-Wikipedia World Model Implementation

## Outcome

The world model now behaves as a dated encyclopedia of the fictional future while preserving the existing actor graph as a compatibility and retrieval layer.

Each actor/entity has:

- one materialized current page in `world_state_nodes`;
- immutable, effective-dated full-page revisions;
- canonical aliases for deduplication;
- consultation, change-velocity, and update-priority metadata;
- directed graph connections used for retrieval and dependency pressure.

Missing concrete entities requested by a human player are resolved before the World Helper builds its final answer. The same operation service is exposed through an admin-only REST route for explicit `CREATE`, `UPDATE`, `ANSWER`, and `INCORPORATE` work.

## What was designed

1. A page and revision representation that supports browsing the world at a selected date.
2. Entity resolution through canonical names and aliases.
3. A bounded, prioritized queue for proposed new pages.
4. An explicit planner for the four professor operations.
5. Automatic helper-question coverage and gap filling.
6. Deterministic update and creation priority formulas.
7. Provenance, confidence, concurrency, and idempotency guardrails.
8. Routes for manual operations, revision history, and as-of page reconstruction.
9. Regression, route, formula, migration, and live LLM tests.

## How the professor's advice shaped the boundary

The implementation deliberately does not add a general action resolver, conflict nodes, separate causal/resistive masses, or a universal shock calculus. Those mechanisms were exactly where the original design became difficult to bound. Instead:

- a page is the unit of current world knowledge;
- a revision is the auditable record of change over simulated time;
- the graph expresses directed relevance/dependency and helps decide what deserves attention, but is not a physics engine;
- `UPDATE` and `INCORPORATE` revise established history;
- `CREATE` uses a bounded candidate queue rather than unconstrained entity growth;
- `ANSWER` may fill a genuinely missing concrete entity, then answers from the refreshed encyclopedia.

This keeps the useful idea behind “attention economy” scheduling—spend computation on stale, connected, fast-changing, or frequently consulted pages—without requiring every possible real-world interaction to fit one causal equation.

## Runtime flow

```text
Player question
    -> gameplay-policy check
    -> world coverage planner
       -> REUSE sufficient established page without player-driven edits
       -> CREATE missing concrete page
       -> IGNORE abstract/ambiguous proposal
    -> transactional page/revision/alias/connection update
    -> reload helper context
    -> generate answer that can cite the newly filled page
```

The player's question identifies an information need but is not treated as proof that its premise is true. Accepted headlines and explicit `INCORPORATE` steers are established history. When the fictional world needs background that was never stated, the planner may create a missing concrete page with conservative inferred context, records it as such in revision evidence, and uses confidence below the level expected for accepted history.

Inference from a player question cannot rewrite an established page. In `ANSWER` mode, all existing-page proposals become a read-only `REUSE`, regardless of what evidence the planner claims. Accepted headlines update pages through the headline-ingestion path, whose prompt does not include the player's query; explicit `UPDATE` and `INCORPORATE` remain admin-controlled. `ANSWER` also cannot alter a relationship between two established pages; it may only add relationships involving a page created to fill that question.

Broad AI-player helper briefings pass `allowWorldMutation: false` so automated players do not create large numbers of shared pages. Prohibited requests for a move, high-scoring headline, or strategy are rejected before mutation.

## Persistence model

Migrations `024` and `025` add:

- `world_state_page_revisions`: immutable full snapshots with operation, source, effective game-world time, real recorded time, before/after summary, delta, rationale, evidence, confidence, change magnitude, model, and token usage.
- `world_state_node_aliases`: one normalized alias owner per session, preventing acronym/case/punctuation duplicates.
- `world_state_page_consultations`: records which helper turn consulted which page.
- `world_state_creation_candidates`: a maximum working queue of 50 queued candidates per session. Repeated mentions merge into one candidate and raise demand.
- Page metadata: `revision_no`, `last_content_update_at`, `last_consulted_at`, `consultations_since_update`, `change_velocity`, `last_change_magnitude`, and `update_priority`.
- Helper/job links: helper messages store their world-update result, and helper edit jobs store the operation and source message.

Existing pages receive a revision-1 baseline. Migration `025` makes revisions complete enough for as-of reconstruction and safely repairs timestamps written by an early development version of migration `024`.

Headline processing now records `CREATE`/`INCORPORATE` revisions too. It resolves normalized canonical names and aliases before inserting, retains the existing canonical name on an alias match, and revision-records new aliases instead of producing acronym/case/punctuation duplicates. Connection proposals and direct events can no longer create empty pages implicitly; their endpoints must already have been explicitly created.

## Operations

| Operation | Meaning | Write behavior |
|---|---|---|
| `CREATE` | Explicitly evaluate a proposed entity page | Reuse aliases first; otherwise candidate + gated page creation |
| `UPDATE` | Revise materially incomplete current pages | Writes only when content/metadata materially changes |
| `ANSWER` | Prepare the model for a player fact/entity question | Creates necessary missing concrete pages, keeps all established pages read-only, then reloads context |
| `INCORPORATE` | Apply an accepted external steer/headline | Treats the steer as game-world history and writes dated revisions |

Planner actions are `CREATE`, `UPDATE`, `REUSE`, and `IGNORE`. Abstract topics such as “AI governance,” “privacy,” or “misinformation” are not page entities; they remain pressures or facts on concrete actor pages.

## Parameters and formulas

All component values are clamped to `[0, 1]`; display priorities are `[0, 100]`.

### Text change magnitude

Let `J` be token-set Jaccard distance and `L` be relative token-count change:

```text
magnitude = 0.80 * J + 0.20 * L
```

Identical normalized text is `0`; empty-to-content is `1`. This is deterministic and inexpensive enough to run inside every page transaction.

### Change velocity

Old change momentum decays over 30 days, then incorporates the newest magnitude with EWMA alpha `0.35`:

```text
decayed_previous = previous_velocity * exp(-elapsed_days / 30)
velocity = 0.65 * decayed_previous + 0.35 * magnitude
```

### Update priority

```text
staleness    = 1 - exp(-days_since_update / 30)
dependency   = 1 - exp(-dependency_shock)
consultation = 1 - exp(-consultations_since_update / 3)

base = 100 * (
    0.30 * staleness
  + 0.30 * dependency
  + 0.20 * change_velocity
  + 0.20 * consultation
)

priority = clamp(base + 15 * explicit_boost, 0, 100)
```

Dependency shock uses incoming directed connections from pages revised since the target was last updated:

```text
dependency_shock = sum(
  connection_strength
  * source_change_magnitude
  * exp(-source_revision_age_days / 14)
)
```

When a source changes, connected dependents receive an immediate lower-bound priority increase. A full recalculation occurs whenever a page is consulted or touched.

### Creation-candidate priority

```text
demand = 1 - exp(-mention_count)

creation_priority = 100 * (
    0.35 * demand
  + 0.30 * confidence
  + 0.20 * novelty
  + 0.15 * connection_potential
)
```

The queue holds at most 50 unresolved candidates and drops only the lowest-priority queued rows. `ANSWER` and explicit `CREATE` requests may fill an immediately needed page without waiting for the queue score, but still require all deterministic gates:

- confidence at least `0.65`;
- novelty at least `0.50`;
- a non-empty complete structured page;
- at least one valid provenance/inference item;
- a concrete actor-like name and type, not an abstract topic.

Other creation paths require priority at least `60` as well. Repeated requests merge by normalized name and raise demand instead of creating duplicates.

### Operational bounds

- page catalog sent to the planner: 120 pages, summaries truncated to 1,800 characters;
- accepted timeline context: latest 50 entries in chronological order;
- planner output: at most 6 entity decisions and 16 connection changes;
- queued creation candidates: 50 per session;
- planner temperature: `0.15`;
- session mutation lock: PostgreSQL 64-bit transaction advisory lock.

## Concurrency and failure behavior

- The LLM plan is generated without holding a database lock, then all page/alias/connection writes run in one transaction under a session-scoped 64-bit advisory lock. Initial builds, headline intake, propagation reactions, helper operations, admin edits, and rebuild deletion all share that lock, preventing cross-path alias races.
- Each update carries `expectedRevisionNo`. If another operation has already advanced the page, stale generated content is not written.
- A planner-supplied node UUID is only a lookup hint: its planned name must match that page's canonical name or a persisted alias. A mismatched UUID falls back to name/alias resolution and cannot target another page.
- `REUSE` performs no alias or content write. Alias additions require a revisioned update.
- Player `ANSWER` operations never edit established pages; accepted-headline ingestion and explicit admin operations are the only existing-page writers.
- Effective dates are monotonic per page; a late worker cannot insert an older full snapshot after a newer one and corrupt as-of reconstruction.
- Page name and normalized alias uniqueness plus a second lookup inside the lock make repeated/concurrent creation idempotent.
- Node, alias, candidate, connection, consultation, and revision writes roll back together.
- A gap-fill failure is stored on its helper job/message but does not prevent the helper from answering from existing context.
- Synchronous helper jobs left queued/running by a terminated process are marked abandoned on the next backend start.

## API and UI

Automatic player behavior continues to use the existing `world_helper:ask` Socket.IO event. No extra player action is required.

Admin REST endpoints:

```text
POST /api/admin/sessions/:joinCode/world-state/helper-update
     { operation, query, effectiveAt? }

GET  /api/admin/sessions/:joinCode/world-state/pages/:nodeId/revisions

GET  /api/admin/sessions/:joinCode/world-state/pages-as-of?at=<ISO-8601>
```

The explicit mutation endpoint is intentionally admin-only. The repository currently treats possession of a player UUID as identity, which is not strong enough authorization for a general shared-world mutation API.

Completed helper messages include `worldUpdate` metadata. The drawer shows when a missing page was created to fill the question. Its default score-optimization suggestion was also replaced with a neutral rules question so it no longer prompts a guaranteed policy refusal.

## Verification completed

- Backend TypeScript production build: passed.
- Frontend TypeScript/Vite production build: passed.
- Backend Jest suite: 25 suites, 310 tests passed.
- New focused tests: scoring boundaries/monotonicity, concrete-vs-abstract guardrails, established-page immutability for player answers, UUID/name matching, normalized headline alias resolution, shared mutation locking, helper mutation policy, and admin route authorization/validation/error mapping.
- Fresh PostgreSQL migration test: all 25 migrations passed; revision snapshot columns and helper job constraint verified.
- Live model test with configured provider:
  - explicit `CREATE` created one page;
  - repeated create reused the same page and produced no duplicate;
  - `INCORPORATE` advanced its revision;
  - as-of requests returned revision 2 before a 2032 event and revision 3 after it;
  - a real Socket.IO question about an absent entity created the page before answering, and the answer cited the new node;
  - the temporary session and data were deleted afterward.

## Deliberate scope choices

The existing dense connection table and cyclic headline propagation remain for compatibility. Pages/revisions are now the primary historical representation, but connection history itself is not yet effective-dated. Low-confidence queued candidates are not blindly materialized by a background timer; they are reconsidered when demand recurs or an admin explicitly requests creation. This prevents unattended speculative growth while preserving the professor's bounded priority queue.
