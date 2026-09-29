// T3 fake-model branches (WOW_SPEC §2.6). F3 (claims, confirmations, /confirm) and F4 (outreach, staffing, Teams) are
// deterministic and make NO model call (spec §4), so there is no policy to fake: this branch never answers.
export function fake() { return null; }
