# Deployment checks still required

These are acceptance requirements, not results already achieved by local automated tests.

| Gate | Pass condition |
|---|---|
| Voice starts first | On the configured GPU, the model introduces itself as AI and asks one relevant question audibly. |
| Real audio | Test microphone, speakers/headphones, mute, device loss, interruption and end on each supported browser. |
| Context | The interviewer distinguishes individual contribution, stage, measurement scope, evidence and customer fit. It does not invent missing details. |
| Identity | Entra tenant and application roles are validated; unauthorized accounts cannot start voice or access another subject's preferences. |
| Memory | Hindsight retain and bounded recall are verified with real identities; no client-selected bank or cross-user leakage. |
| Notes | Consent controls microphone buffering and Riva transcription; agent captions never become consultant claims; candidate text is reviewed. |
| Records | Production project permissions and actual review authority are enforced server-side before shared use. Local authoring is not this enforcement. |
| Infrastructure | Reviewed/pinned worker, one-session pilot limit, private worker, HTTPS gateway, minimal logs and documented retention. |
| Brand | Mantu brand owner reviews the app adaptation and intended customer exports. |

Run only the current test commands in README.md. The protocol and browser adapters are synthetic fixtures and are not deployed voice providers.
