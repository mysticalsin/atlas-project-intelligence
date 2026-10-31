# Information pack for employee representatives: draft

Status: **DRAFT for Mantu legal and HR to adapt.** It describes what ATLAS does and does not do to the people who use it, in plain words, so a works council or employee representative body can be informed and consulted. Whether consultation or co-determination is required, in which country and on what terms, is for Mantu's legal team to assess (France and Germany at least; other countries not assessed). Nothing here is a legal opinion or a statement that ATLAS meets any national requirement.

## What ATLAS is

A voice-first (or typed) interview in which a consultant describes a past project. The result is a private draft that only that consultant can see. When they click Submit for review, a reviewer and their N+1 check it; approved references can be reused internally for meetings, bids and presentations.

## What it does not do

- It does not evaluate, rank, compare or score **people**. The write-up gets a completeness score; the policy gate denies rating, ranking or comparing consultants, and any promotion or termination use, for every role.
- It does not infer mood, sentiment, personality or skill from a person's voice or words. It does not identify a person by voice and stores no audio.
- It does not make a decision about a person by automated means.
- It does not track working time, location or activity. The interview takes about 20 minutes (30 at most, only if the person agrees to continue) and is started by the person.
- It does not send anything by itself: invitations and outreach are drafts that a person approves.

## What is kept, who sees it, for how long

| What | Who sees it | When | How long (proposal, DPO to confirm) |
|---|---|---|---|
| The interview as a draft | Only the consultant | Until they click Submit for review | Deleted after 90 days if never submitted |
| The submitted reference and its quality score | The consultant, their resolved N+1, reviewers; administrators only to operate the service; every read of someone else's record is logged | After Submit for review | With the reference; withdrawn references 90 days |
| An interrupted interview | The consultant | Only if they allow it | 24 hours, then deleted automatically |
| A short private memory of project facts | The consultant | Only if they turn it on (off by default) | Erased on request; pruned after 365 days |
| Consent choices | The DPO and administrators | Always | 6 years after the last one |

## Employee rights and how to use them

Download everything held about you; delete it (approved material used in a bid is kept for the DPO to review rather than silently deleted); withdraw any optional choice at any time; restrict or object to rating, matching and memory; complain to the supervisory authority. All of this is in the profile (Your data and your choices) and in the privacy notice at `/privacy`.

## Items for the consultation (to be assessed by legal and HR, not concluded here)

1. Whether the quality score, the "ready" threshold, review outcomes and per-story win rates, being visible to managers, are a performance-evaluation tool for the purposes of national employee-representation law.
2. Whether the system is a technical device capable of monitoring employees' behaviour or performance in the sense of national co-determination rules (Germany, Betriebsverfassungsgesetz section 87) or an information and consultation matter (France, CSE).
3. Whether the N+1 should see scores and win rates at all (an owner decision recorded in the DPIA draft).
4. Whether participation can be voluntary in practice, and how to show that declining has no consequence.
5. How long administrators may keep audit records about employees (proposal: pseudonymised after two years).
6. The controls employees have, and whether they are sufficient.

## Controls implemented in code (offline-tested; not live-verified)

Private until Submit; separate, receipted consent choices; memory off by default and facts only; a guard that offers "keep this private" for sensitive lines; download and delete; restriction and objection; a retention sweep; audit of reads of others' records; no inference about people. The tests and the DPIA draft (`DPIA_DRAFT.md`) say where each lives.

## Contacts

Controller and DPO: [to be completed by Mantu]. Employee representatives: [to be completed by HR].
