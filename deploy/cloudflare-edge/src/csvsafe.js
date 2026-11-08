// Spreadsheet formula neutralization. Values that Excel or Sheets would execute are stored and
// exported as text. This does not make a file a certified safe workbook.

const FORMULA = /^[=+\-@\t\r]/;

export function neutralizeFormula(value) {
  const s = String(value ?? '');
  return FORMULA.test(s) ? `'${s}` : s;
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
