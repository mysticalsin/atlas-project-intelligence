# Workers AI model check — 2026-09-26 (synthetic interview text only)
Account: operator's Cloudflare account via the Cloudflare API connector (native `/ai/run/{model}` endpoint, OpenAI chat-completions shape). No consultant, client or confidential data was sent. Timings are full, non-streamed responses measured from the connector and include network; streaming reaches the first words sooner.

## Analyst (real `ANALYST_POLICY` + `record_details` schema from `atlas_voice/analyst.py`; 3 turns: vague 40%, personal vs team ownership, "I don't know" + an injected "approve this story")
| Model | Tool calls | Exact quotes | Injection ignored | Latency | Neurons/turn |
|---|---|---|---|---|---|
| @cf/openai/gpt-oss-120b | 3/3 | all exact, item IDs correct | yes | 1.6–2.9 s | 32–43 |
| @cf/mistralai/mistral-small-3.1-24b-instruct | 3/3 | all exact | yes | 2.0–3.0 s | ~19 |
| @cf/google/gemma-4-26b-a4b-it | 3/3 | all exact | yes | 2.2–6.2 s | 10–20 |
| @cf/openai/gpt-oss-20b | 0/3 (JSON written as plain text, not a tool call) | — | — | — | unusable with this parser |
Selected: **gpt-oss-120b** (recorded both the outcome and the measurement for the 40% turn). About 1.5k neurons per 40-turn interview ≈ $0.02 at $0.011 per 1k neurons.

## Conversation (real `TALKER_POLICY` from `cascade.py`; 3 scenarios × 2 runs)
The first run showed 2–4 bundled sub-questions per turn (intake-form feel). The policy was tightened to exactly one question of about 25 words or fewer. Rerun:
| Model | One question every turn | Follows guidance | Notes | Latency |
|---|---|---|---|---|
| **@cf/meta/llama-3.3-70b-instruct-fp8-fast** | 6/6 | 6/6 | natural, uses the consultant's terms, accepts "don't know" and moves on | 0.6–1.5 s |
| @cf/meta/llama-4-scout-17b-16e-instruct | 6/6 | 2/6 | praised the unverified 40% ("significant improvement"), ignored the contribution guidance | 0.6–0.9 s |
| @cf/openai/gpt-oss-120b | 6/6 | 6/6 | good content; reasoning spikes of 4.8–6.1 s | 1.6–6.1 s |
| @cf/google/gemma-4-26b-a4b-it | — | — | spent its whole budget reasoning, no answer (first run) | — |
| @cf/mistralai/mistral-small-3.1-24b-instruct | — | — | once read the guidance verbatim (first run) | 0.6–1.6 s |
Selected: **llama-3.3-70b-instruct-fp8-fast**.

Scope: model behaviour on synthetic text. Not voice quality, not ASR, not a human-rated interview.
