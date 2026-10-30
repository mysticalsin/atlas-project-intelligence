# ATLAS v2.0 — Agent Brain & Product Blueprint
Claude-ready implementation handoff | 30 October 2026

## What Atlas is
Atlas is Mantu's Project Intelligence and Evidence Platform and a conversational agent: a warm, curious, professionally intelligent colleague who helps consultants explain their work, managers review evidence and actions, and the organisation reuse validated project knowledge safely.

**Promise: Capture once. Understand deeply. Validate with people. Reuse responsibly.**

## Read in this order
1. `01_Product_and_Architecture/ATLAS_Master_Product_Blueprint.md`
2. `02_Agent_Brain/AGENT.md`
3. `02_Agent_Brain/ATLAS_Cognitive_Architecture.md`
4. `03_Conversation_Design/ATLAS_Personality_and_Conversation_Design.md`
5. `03_Conversation_Design/ATLAS_Interview_Playbook.md`
6. `04_Workflows/ATLAS_End_to_End_Workflows.md`
7. `04_Workflows/MAAP_Review_Specification.md`
8. `04_Workflows/Project_Review_Specification.md`\n9. `04_Workflows/Spotlight_Success_Story_Workflow.md`\n10. `03_Conversation_Design/ATLAS_Success_Story_Interview_and_Output_Mapping.md`
9. `05_Data_and_Integrations/ATLAS_Domain_Model_and_Schema.md`
10. `05_Data_and_Integrations/ATLAS_Integration_Contracts.md`
11. `06_Governance_and_Safety/ATLAS_Governance_Privacy_and_Approvals.md`
12. `07_Evaluation_and_QA/ATLAS_Evaluation_Framework.md`
13. `08_Implementation/IMPLEMENTATION_PLAN.md`
14. `08_Implementation/CLAUDE_BUILD_PROMPT.md`

## Decisions deliberately left open
- MiChat is used here for conversational capture; MeChat remains the downstream CV destination as described in prior architecture. Confirm whether these are distinct systems or a rename.
- MAAP official expansion, process owner, rubric, rating model, cadence, participants, country variants and retention policy remain unconfirmed. Do not invent them.
- Spotlight is the success-story publication destination. CMS/API and approval owners require confirmation.
- DNA skills writeback, MeChat, IMP availability/matching and Spotlight publishing are proposed until verified with an acknowledged live round trip.
- JEV relevance matching is separate from factual validation and publication approval.

## Evidence labels
Existing-source review: prior architecture described interview/evidence capture, evidence ledger/review/audit, DNA inbound prefill and bid proof matching. Review pinned to commit `efb4948` dated 2 October 2026; not proof of current production status.
Interview-derived: delivery pain points from the supplied delivery interview recap.
Proposed: target-state design.
To confirm: requires an accountable process/system owner.

The canonical workflow image and Spanish success-story template supplied on 30 October 2026 are included in `10_Source_References/`. Machine-readable workflow and template field/visibility configuration are in `11_Plug_and_Play_Config/`. A starter DOCX population helper is included in `08_Implementation/`. This is a design and implementation handoff, not a claim that every adapter or production capability exists.
