Use the attached ATLAS_Project_Intelligence ZIP as the source repository. Extract it and work inside its single top-level folder.

Read `00_START_HERE.md`, `CLAUDE.md`, `handoff/CURRENT_STATUS.md`, `handoff/BUILD_PLAN.md`, and `handoff/CONFIGURATION.md` before editing. Then use `handoff/CODE_MAP.md` and `docs/PRD_v12.md` for the relevant implementation details. Do not require the previous ChatGPT conversation.

This is not a request for another PRD, scaffold or static mockup. Continue the existing implementation and make the configured path work. Keep the dark Mantu-branded HTML, its speech-reactive orb, and the project/evidence/story workflow. No outward wave animation; the orb's body must react to audio actually played.

The critical outcome is a high-quality voice interviewer: it asks concrete follow-ups, challenges vague claims, distinguishes personal contribution from the team's work, accepts “I don't know,” preserves corrections and confidentiality, and captures enough evidence and customer context for a defensible story. It is not a narrated intake form.

Use one explicitly selected conversational voice provider. Hosted Realtime is selected in the example configuration; preserve the NVIDIA PersonaPlex route without claiming feature parity. Use my pinned `mysticalsin/hindsight` fork for private per-Entra-user continuity. Store source-linked success stories as immutable Markdown with current access/review authority. Keep the native wiki graph and the optional authorized Graphify export. Use the JEV adapter for customer-specific story relevance, with caveats and no-strong-match behavior.

First verify the handoff integrity and run the full baseline tests. Then follow the ordered build plan, making the smallest justified changes and adding regression tests. Keep `handoff/BUILD_STATUS.md` updated so work can resume across sessions. Do not rebuild the app in a different stack or add unnecessary infrastructure.

For real API calls or deployment, use only approved services, an authorized budget, and server-side secrets configured in my environment. Do not print secrets, send confidential examples, push remotely or deploy publicly without authorization. Missing API access is a specific external blocker—not permission to fake a connection or stop all independent work.

Finish with the updated source and compiled HTML, exact run commands, a truthful test report, an external-setup checklist, and a clear separation between locally tested behavior and live-provider verification. If the environment cannot execute a step, mark it explicitly and continue the work it can perform.
