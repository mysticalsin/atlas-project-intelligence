# DRAFT for review: notice copy for early processing (not shown in the product)

**Status:** draft wording only, for Tony's and legal review. It is not wired into the page, the consent prompt or any consent record, and no consent ledger was enabled. It makes no legal-compliance or zero-data-retention claim. It does not assume that the existing microphone and transcription consent already covers early processing; that is a review question.

Provider identity reflects the current edge configuration (`wrangler.jsonc` defaults). Verify it again before any use.

---

## Short line (next to the transcription consent, if approved)
> To answer faster, ATLAS may start transcribing and drafting a reply while you pause mid-answer. If you keep talking, that early work is thrown away and nothing from it is shown, said or saved.

## Details (expandable)
**What happens.** When you pause for about 0.7 seconds, ATLAS may send what you have said so far to speech recognition before you have finished. It may also draft its reply as text. If you carry on talking, it sends your whole answer again when you finish. The same words can therefore be processed more than once.

**Who processes it.** Speech recognition and drafting run on Cloudflare Workers AI. The current models are Deepgram Nova-3 for speech recognition and Meta Llama 3.3 70B for drafting, the same services ATLAS already uses for this interview. No other provider receives this audio or text.

**What is kept.** ATLAS does not show, speak or save an early transcript or draft unless you have actually finished and your answer is unchanged. Thrown-away early results are not written to your interview notes, the evidence ledger, your report or your private memory. Timings and counts, never words, may appear in service logs. What the provider does with requests is governed by its own terms; this notice does not describe or guarantee provider retention.

**Your choice.** Early processing is optional and off unless enabled for this deployment. *[Open for review: whether a per-person switch is required, where it lives, and whether turning it off needs to be offered before each interview.]* Turning it off does not change how ATLAS interviews you. It may only answer slightly later.

---

## Open questions for reviewers
- Does the existing transcription consent cover repeated and early processing of the same utterance, or is a separate choice needed?
- Is a per-person control required before any live evaluation, and is a default of off required?
- Do the provider terms for Workers AI support the retention statement above, for both discarded and adopted requests?
- Wording and translation for the seven interview languages, reviewed by native speakers.
