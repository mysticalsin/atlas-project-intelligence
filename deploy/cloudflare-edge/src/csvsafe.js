// Spreadsheet formula neutralization. Values that Excel or Sheets would execute are stored and
// exported as text. This does not make a file a certified safe workbook.
// Space and line feed are not starters. They are skipped only to decide, because a cell
// can begin with them and still be read as = + - @ tab or carriage return. The stored
// characters stay. One leading apostrophe makes the cell text.

const FORMULA = /^[=+\-@\t\r]/;

function formulaAfterLead(text) {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\n')) i++;
  return i > 0 && FORMULA.test(text.slice(i));
}

export function neutralizeFormula(value) {
  const s = String(value ?? '');
  return FORMULA.test(s) || formulaAfterLead(s) ? `'${s}` : s;
}

export function csvCell(value) {
  let s = neutralizeFormula(value);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const head = headers.map(csvCell).join(',');
  const body = rows.map(row => headers.map(h => csvCell(row[h] ?? '')).join(','));
  return [head, ...body].join('\r\n');
}
