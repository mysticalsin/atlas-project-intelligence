// A small JSON-Schema validator for the connection contracts (atlas_voice/config/contracts/<id>/*.schema.json). Pure, no dependencies.
// It supports exactly SUPPORTED and refuses to run on a schema that uses anything else, so a constraint is never silently ignored.
// Annotations (title, description, format, $schema, x-*) are ignored. atlas_voice/connections_config.py enforces the same keyword list.
export const SUPPORTED = ['type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'oneOf', 'anyOf', '$ref', '$defs'];
const ANNOTATIONS = ['$schema', '$id', 'title', 'description', 'format', 'default', 'examples'];

const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : Number.isInteger(v) ? 'integer' : typeof v; // 'integer' also satisfies 'number'
const isType = (v, t) => t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : kindOf(v) === t;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function unsupported(schema, path = '#') {
  const out = [];
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    for (const [k, v] of Object.entries(schema)) {
      if (!SUPPORTED.includes(k) && !ANNOTATIONS.includes(k) && !k.startsWith('x-')) out.push(`${path}/${k}`);
      if (k === 'properties' || k === '$defs') for (const [n, sub] of Object.entries(v || {})) out.push(...unsupported(sub, `${path}/${k}/${n}`));
      else if (k === 'items' || k === 'additionalProperties') out.push(...unsupported(v, `${path}/${k}`));
      else if (k === 'oneOf' || k === 'anyOf') (v || []).forEach((sub, i) => out.push(...unsupported(sub, `${path}/${k}/${i}`)));
    }
  }
  return out;
}

// -> { valid, errors: [{ path, code }] }. Error codes carry no instance values (a sample may hold personal data).
export function validate(schema, value) {
  const bad = unsupported(schema);
  if (bad.length) throw new Error(`Unsupported schema keyword at ${bad.join(', ')}`);
  const errors = [], root = schema;
  const resolve = ref => { const m = /^#\/\$defs\/([\w-]+)$/.exec(String(ref)); const r = m && root.$defs?.[m[1]]; if (!r) throw new Error(`Unresolvable $ref ${ref}`); return r; };
  const walk = (s, v, path) => {
    if (s.$ref) return walk(resolve(s.$ref), v, path);
    const err = code => errors.push({ path, code });
    if (s.type !== undefined) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.some(t => isType(v, t))) return err(`TYPE:${ts.join('|')}`); }
    if (s.const !== undefined && !same(s.const, v)) err('CONST');
    if (s.enum && !s.enum.some(e => same(e, v))) err('ENUM');
    if (typeof v === 'string') {
      if (s.minLength !== undefined && [...v].length < s.minLength) err('MIN_LENGTH');
      if (s.maxLength !== undefined && [...v].length > s.maxLength) err('MAX_LENGTH');
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) err('PATTERN');
    }
    if (typeof v === 'number') { if (s.minimum !== undefined && v < s.minimum) err('MINIMUM'); if (s.maximum !== undefined && v > s.maximum) err('MAXIMUM'); }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) err('MIN_ITEMS');
      if (s.maxItems !== undefined && v.length > s.maxItems) err('MAX_ITEMS');
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${path}/${i}`));
    }
    if (kindOf(v) === 'object') {
      for (const k of s.required || []) if (!Object.hasOwn(v, k)) errors.push({ path: `${path}/${k}`, code: 'REQUIRED' });
      const props = s.properties || {};
      for (const [k, x] of Object.entries(v)) {
        if (Object.hasOwn(props, k)) walk(props[k], x, `${path}/${k}`);
        else if (s.additionalProperties === false) errors.push({ path: `${path}/${k}`, code: 'ADDITIONAL_PROPERTY' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, x, `${path}/${k}`);
      }
    }
    if (s.anyOf && !s.anyOf.some(sub => validate1(sub, v))) err('ANY_OF');
    if (s.oneOf && s.oneOf.filter(sub => validate1(sub, v)).length !== 1) err('ONE_OF');
  };
  const validate1 = (s, v) => { const keep = errors.length; walk(s, v, '#'); const ok = errors.length === keep; errors.length = keep; return ok; };
  walk(schema, value, '#');
  return { valid: errors.length === 0, errors };
}
