# Additive Soft-MoE with Reflective Multi-Task Adaptation — Results

All numbers: forced-choice MCQ, 30 s audio (Qwen2-Audio native window), identical
`eval_hybrid_moe` / `hybrid_derisk` harness. MMAU = official MMAU-Pro MCQ subset (3336
single-audio rows); MuChoMusic (1187); Clotho-AQA yes/no (620).

## Full ablation table (all models × all three benchmarks)

| # | Model | MMAU  (music / sound / speech) | MuChoMusic | Clotho | vs Qwen (MMAU) |
|---|-------|--------------------------------|-----------|--------|-----|
| 1 | Native Qwen2-Audio-7B            | **43.26** (42.1 / 46.7 / 41.1) | 52.23 | 78.39 | —    |
| 2 | + Additive soft-MoE (frozen LLM) | **45.20** (44.0 / 53.7 / 37.3) | 52.65 | 80.65 | +1.94 |
| 3 | + LLM-LoRA (no focus)            | **46.37** (47.2 / 52.5 / 38.0) | 55.27 | 81.29 | +3.11 |
| 4 | + Focus-augmentation             | **46.61** (47.1 / 52.7 / 38.8) | 55.18 | 83.23 | +3.35 |
| 5 | + Self-assessment (decision)     | **47.81** (49.2 / 52.1 / 40.6) | 58.21 | 82.10 | +4.55 |
| 6 | + Varied focus  **(A+B, final)** | **49.13** (50.9 / 53.0 / 41.9) | 60.32 | 83.06 | +5.87 |

MMAU improves **monotonically** every rung (43.26→45.20→46.37→46.61→47.81→49.13);
MuChoMusic +8.1 and Clotho +4.7 end-to-end. Final model beats Qwen on all three, no
regression vs Qwen anywhere.

## Per-model: what improved and why

**Rung 2 — Additive soft-MoE (frozen LLM).** Feed the LLM BOTH Qwen's native audio tokens
AND 32 soft-blended expert tokens. Gain concentrated on **sound (46.7→53.7, +7.0)** — the
experts' training domain (environmental-sound reasoning). Cost: **speech −3.8** (extra
lossy tokens distract on content-heavy speech). Net +1.94. Mechanism: native floor
guarantees ≥Qwen; experts add where they are competent.

**Rung 3 — LLM-LoRA.** Unfreeze the LLM (r16 q/k/v/o). Re-adapts the frozen LLM to the
injected expert tokens → recovers **music (44.0→47.2)** and **speech (37.3→38.0)**, and
lifts MuChoMusic (+2.6). This is where "unfreezing helps" — but only in the ADDITIVE setting
(LoRA regressed in the earlier replace setting). +1.17.

**Rung 4 — Focus-augmentation.** During training, append random "Focus on X" suffixes to
questions. Small, broad — mainly **speech (+0.8)** and **Clotho (+1.9)**: teaches robust
instruction-following. +0.24 MMAU.

**Rung 5 — Self-assessment (decision task).** Train the LLM to answer "Your answer was (X).
Should you reconsider? Yes/No" (labels = its own correctness). As an **INFERENCE** trigger it
FAILS (AUC 0.43). But as a training **REGULARIZER** it helps the reasoning categories:
**music +2.1, speech +1.8**, MuChoMusic +3.0. +1.20 MMAU.

**Rung 6 — Varied focus vocabulary (final A+B).** Expand focus-aug from 5 expert names to 12
diverse aspects (beginning/ending/background/loudest/counts/…). Broad, uniform lift across
**all three MMAU categories** (music 50.9, sound 53.0, speech 41.9) and MuChoMusic (+2.1).
+1.32 MMAU. Best, most balanced model.

## Explainability experiments

1. **Routing is sensible & taxonomy-respecting** (`inspect_two_pass_routing.py`): counting Qs
   → structure, temporal → relation, source-ID → entity, action/sound → event. Correct
   answers come from correctly-routed questions.
2. **Two-pass routing shift is tiny** (mean L1 0.186/2.0; top expert changes only 9.7%;
   self-boost +0.01..0.05) — mechanistic root of why inference-time look-back cannot work:
   the second pass ≈ the first.
3. **Confidence is anti-calibrated on the cases that matter** (`eval_confidence_calibration`):
   in headroom cases correct attempts have LOWER P(top) (0.480) than incorrect (0.493);
   max-confidence picks the right attempt only 25% (= chance). No selection signal works.

## Saturation (extensions that do NOT beat A+B, MMAU @30s)

A+B continued +2000 steps 49.04 · expanded 20-focus vocab 48.98 · +verify(no content) 48.50
· +verify+content 46.79. → focus variety saturates at ~12; verify neutral; content-generation
objective HARMFUL (overfits in-domain). Effective reflective tasks = focus-aug + self-assessment.

## The through-line (paper thesis)

Reflective look-back objectives (focus-following, self-assessment) **fail as inference
mechanisms** — proven with measured mechanism (routing barely re-routes; confidence
anti-calibrates) — **but consistently improve the single-pass model as training signal.**
Everything is learned end-to-end; the router respects a human-interpretable taxonomy; every
gain is validated on held-out benchmarks.
