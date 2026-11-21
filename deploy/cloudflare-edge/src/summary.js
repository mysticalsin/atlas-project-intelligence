// Confirmation read-back. Built only from the ledger's own details. Nothing is
// paraphrased. Withheld and superseded details stay off the card. The card
// lists every remaining detail up to the ledger cap. It does not stop at 40.
import { FIELDS } from './policy.generated.js';

export const MAX_ITEMS = 100;
const QUOTE_CHARS = 1800;
const ORDER = Object.keys(FIELDS);

export function buildSummary(ledger) {
  const details = Array.isArray(ledger) ? ledger : Array.isArray(ledger?.details) ? ledger.details : [];
  const hidden = ledger && ledger.withheldItems instanceof Set ? ledger.withheldItems : new Set();
  const shown = details.filter(d => d && d.active !== false && d.withheld !== true && !hidden.has(d.item_id) && typeof d.quote === 'string' && Object.hasOwn(FIELDS, d.field));
  return shown.map((d, i) => ({ d, i }))
    .sort((a, b) => (ORDER.indexOf(a.d.field) < 0 ? ORDER.length : ORDER.indexOf(a.d.field)) - (ORDER.indexOf(b.d.field) < 0 ? ORDER.length : ORDER.indexOf(b.d.field)) || a.i - b.i)
    .slice(0, MAX_ITEMS)
    .map(({ d }) => ({
      detail_id: String(d.id),
      field: d.field,
      label: FIELDS[d.field][0],
      quote: String(d.quote).slice(0, QUOTE_CHARS),
    }));
}
