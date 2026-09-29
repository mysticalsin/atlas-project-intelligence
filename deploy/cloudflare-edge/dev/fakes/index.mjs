// Extra fake-model branches, one file per track (WOW_SPEC §2.6). dev/fake-model.mjs asks each one first, in this
// order; the first string answer wins. Each is (system, input) => string | null and must match only its own
// policies' unique first sentence.
import * as proof from './proof.mjs';
import * as gaps from './gaps.mjs';
import * as trust from './trust.mjs';
export const EXTRA_FAKES = [proof.fake, gaps.fake, trust.fake];
