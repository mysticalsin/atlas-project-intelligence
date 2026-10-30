# Atlas Question Selection & Evidence Reasoning Engine

## 1. Objective
Atlas should ask the next question that most improves the quality and usefulness of the record while respecting the user's time, privacy and conversational flow.

## 2. Claim decomposition
Convert each answer into candidate atomic claims:
- who/what the claim concerns;
- what happened or changed;
- who performed the action;
- when and in what project context;
- evidence source;
- outcome and attribution;
- uncertainty or contradiction;
- allowed use.

Do not convert a sentence into a validated fact simply because it is grammatically clear.

## 3. Question selection
For each possible follow-up, estimate:
- **Decision value:** would the answer change a downstream decision or the quality of the record?
- **Information gain:** does it resolve an unknown or ambiguity?
- **Relevance:** does it fit the current project and workflow?
- **Effort:** how much work is required from the user?
- **Sensitivity:** does it involve restricted or personal information?
- **Redundancy:** has the answer already been supplied by a trusted source?

A conceptual priority score:
`priority = (decision_value × information_gain × relevance) - (effort × effort_weight) - (sensitivity × sensitivity_weight) - redundancy_penalty`

This is a question-ordering aid, not a user score. Do not expose numerical scores. Select one question with high value and low burden. If a question is sensitive or not necessary, skip it or route to an authorized reviewer.

## 4. Follow-up ladder
1. **Open exploration:** “Can you walk me through how this started?”
2. **Specific example:** “Which process or deliverable are you thinking of?”
3. **Personal ownership:** “What part did you personally take responsibility for?”
4. **Decision/approach:** “How did you decide to do it that way?”
5. **Evidence:** “What would help us verify that?”
6. **Impact:** “What changed for the customer or team?”
7. **Measurement:** “How was that measured, and over what period?”
8. **Attribution:** “Which part of the result can fairly be linked to your contribution?”
Stop when the record is sufficiently clear; do not climb every rung mechanically.

## 5. Evidence reasoning
For each claim, store:
- exact or normalized statement;
- claimant and subject;
- source type and source reference;
- attribution type;
- measurement details if applicable;
- review status;
- contradictions and resolution;
- revision and downstream derivatives.

Never assign evidence status based on LLM confidence alone. Model confidence can determine whether to ask a clarification, but cannot replace a source or human reviewer.

## 6. Metric quality
A numeric result is incomplete without context. Ask for:
- baseline and after-state;
- unit;
- measurement period;
- measurement method;
- source;
- sample/population where relevant;
- whether it is measured, estimated or anecdotal;
- who/what contributed.

Example: “Reduced processing time by 80%” is not ready for external use until baseline, after-state, period, method and attribution are established.

## 7. Contradiction handling
When sources disagree:
- show the conflict neutrally;
- preserve both source references;
- ask the appropriate owner to resolve;
- do not select the more impressive or more recent statement automatically;
- record adjudicator, rationale and revision.
