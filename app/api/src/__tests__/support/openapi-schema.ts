/**
 * A dependency-free OpenAPI subset reader and structural response validator.
 *
 * Shared by the broad OpenAPI contract suite (contract-openapi.test.ts) and the R1
 * candidate-route suites, so every suite validates a live response against the
 * documented schema with the SAME rules: required keys, types, enums, uuid and
 * date-time formats, nested objects and arrays, `nullable`, `allOf` flattening and
 * `additionalProperties: false` exactness. Moved here unchanged from
 * contract-openapi.test.ts; it holds no test and touches no network or file.
 */

// ════════════════════════════════════════════════════════════════════
//  Dependency-free YAML subset parser
//
//  Supports exactly the subset used by openapi.yaml: 2-space indentation,
//  block mappings, block sequences, single-line flow sequences, quoted and
//  plain scalars, full-line comments. No anchors/aliases/tags/folded blocks.
// ════════════════════════════════════════════════════════════════════

export type YValue = string | number | boolean | null | YMap | YValue[];
export interface YMap {
  [key: string]: YValue;
}

/** Strip a full-line comment (only lines whose FIRST non-space char is #). */
function stripComment(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('#')) return '';
  return raw;
}

function unquoteKey(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return t;
}

function parseScalar(raw: string): YValue {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && input[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseFlowSequence(raw: string): YValue[] {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(`YAML parse error: expected flow sequence, got "${raw}"`);
  }
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner, ',').map((part) => parseScalar(part.trim()));
}

function findKeySep(text: string): number {
  // Find the first unquoted ": " separator or a trailing ":".
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ':' ) {
      if (i === text.length - 1) return i;
      if (text[i + 1] === ' ' || text[i + 1] === '\t') return i;
    }
  }
  return -1;
}

interface YamlLine {
  indent: number;
  text: string;
  lineNo: number;
}

export function parseYamlDocument(text: string): YMap {
  const lines: YamlLine[] = [];
  for (const [idx, rawLine] of text.split('\n').entries()) {
    const stripped = stripComment(rawLine);
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    lines.push({ indent: rawLine.length - rawLine.trimStart().length, text: trimmed, lineNo: idx + 1 });
  }
  let pos = 0;

  function parseNode(expectIndent: number): YValue {
    if (pos >= lines.length) return {};
    const line = lines[pos];
    if (line.indent < expectIndent) throw new Error(`YAML indentation error at line ${line.lineNo}`);
    if (line.text.startsWith('- ')) return parseSequence(line.indent);
    return parseMapping(line.indent);
  }

  function parseSequence(indent: number): YValue[] {
    const items: YValue[] = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      const rest = line.text.slice(2);
      if (rest === '') {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) {
          items.push(parseNode(lines[pos].indent));
        } else {
          items.push(null);
        }
        continue;
      }
      const sep = findKeySep(rest);
      if (sep !== -1) {
        // Inline first key of an item map: "- key: value"
        const itemMap: YMap = {};
        let key = unquoteKey(rest.slice(0, sep));
        let valueText = rest.slice(sep + 1).trim();
        pos++;
        if (valueText === '') {
          if (pos < lines.length && lines[pos].indent > indent) {
            itemMap[key] = parseNode(lines[pos].indent);
          } else {
            itemMap[key] = null;
          }
        } else if (valueText === '[]') {
          itemMap[key] = [];
        } else if (valueText === '{}') {
          itemMap[key] = {};
        } else if (valueText.startsWith('[') && valueText.endsWith(']')) {
          itemMap[key] = parseFlowSequence(valueText);
        } else {
          itemMap[key] = parseScalar(valueText);
        }
        // Continuation keys of the same item map at indent+2.
        while (pos < lines.length && lines[pos].indent > indent && !lines[pos].text.startsWith('- ')) {
          const cl = lines[pos];
          const csep = findKeySep(cl.text);
          if (csep === -1) throw new Error(`YAML parse error at line ${cl.lineNo}`);
          const ckey = unquoteKey(cl.text.slice(0, csep));
          let cval = cl.text.slice(csep + 1).trim();
          pos++;
          if (cval === '') {
            if (pos < lines.length && lines[pos].indent > cl.indent) {
              itemMap[ckey] = parseNode(lines[pos].indent);
            } else {
              itemMap[ckey] = null;
            }
          } else if (cval === '[]') {
            itemMap[ckey] = [];
          } else if (cval === '{}') {
            itemMap[ckey] = {};
          } else if (cval.startsWith('[') && cval.endsWith(']')) {
            itemMap[ckey] = parseFlowSequence(cval);
          } else {
            itemMap[ckey] = parseScalar(cval);
          }
        }
        items.push(itemMap);
      } else {
        items.push(parseScalar(rest));
        pos++;
      }
    }
    return items;
  }

  function parseMapping(indent: number): YMap {
    const map: YMap = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith('- ')) break;
      const sep = findKeySep(line.text);
      if (sep === -1) throw new Error(`YAML parse error at line ${line.lineNo}: "${line.text}"`);
      const key = unquoteKey(line.text.slice(0, sep));
      let rest = line.text.slice(sep + 1).trim();
      pos++;
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          map[key] = parseNode(lines[pos].indent);
        } else {
          map[key] = null;
        }
      } else if (rest === '[]') {
        map[key] = [];
      } else if (rest === '{}') {
        map[key] = {};
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        map[key] = parseFlowSequence(rest);
      } else {
        map[key] = parseScalar(rest);
      }
    }
    return map;
  }

  if (lines.length === 0) return {};
  const root = parseNode(lines[0].indent);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('YAML root must be a mapping');
  }
  return root as YMap;
}

// ════════════════════════════════════════════════════════════════════
//  OpenAPI schema validator (small, structural)
// ════════════════════════════════════════════════════════════════════

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: YValue[];
  additionalProperties?: boolean;
  nullable?: boolean;
  const?: YValue;
  $ref?: string;
  format?: string;
  allOf?: SchemaNode[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveRef(ref: string, spec: YMap): SchemaNode {
  if (!ref.startsWith('#/components/schemas/')) {
    throw new Error(`Unsupported $ref "${ref}" — only components/schemas refs are allowed`);
  }
  const name = ref.slice('#/components/schemas/'.length);
  const schemas = (spec.components as YMap)?.schemas as YMap | undefined;
  if (!schemas || typeof schemas[name] !== 'object' || schemas[name] === null || Array.isArray(schemas[name])) {
    throw new Error(`Unknown component schema "${name}" referenced by spec`);
  }
  return schemas[name] as unknown as SchemaNode;
}

/**
 * Resolve `$ref` chains AND flatten `allOf`.
 *
 * The `allOf` half is not decoration. OpenAPI 3.0.x ignores every sibling of
 * a `$ref`, so the only way to say "this property is that schema, and it may
 * also be null" is `nullable: true` next to `allOf: [ { $ref } ]`. If this
 * validator did not understand `allOf`, every schema written that way would
 * flatten to a typeless node and validateValue would accept ANYTHING for it —
 * the spec fix would silently switch off the contract check it was meant to
 * make honest. Flattening keeps `type`, `required`, `properties` and
 * `additionalProperties: false` in force through the wrapper.
 */
function deref(schema: SchemaNode | undefined, spec: YMap, seen: Set<string> = new Set<string>()): SchemaNode | undefined {
  let s = schema;
  while (s && s.$ref) {
    if (seen.has(s.$ref)) throw new Error(`Cyclic $ref "${s.$ref}"`);
    seen.add(s.$ref);
    s = resolveRef(s.$ref, spec);
  }
  if (!s || !s.allOf) return s;

  const merged: SchemaNode = {};
  const props: Record<string, SchemaNode> = {};
  const required: string[] = [];
  const own: SchemaNode = { ...s };
  delete own.allOf;
  // Members first, the wrapper's own keys last, so a wrapper key (typically
  // `nullable`/`description`) wins over the member it is qualifying.
  for (const member of [...s.allOf, own]) {
    const m = deref(member, spec, new Set(seen));
    if (!m) continue;
    for (const [key, value] of Object.entries(m)) {
      if (key === 'allOf') continue;
      if (key === 'properties') {
        Object.assign(props, value as Record<string, SchemaNode>);
        continue;
      }
      if (key === 'required') {
        required.push(...(value as string[]));
        continue;
      }
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.length > 0) merged.required = [...new Set(required)];
  return merged;
}

function validateValue(value: unknown, schema: SchemaNode | undefined, spec: YMap, path: string, errors: string[]): void {
  const wrapper = schema;
  const s = deref(schema, spec);
  if (!s) return;

  if (value === null) {
    const nullable = wrapper?.nullable === true || s.nullable === true;
    if (!nullable) errors.push(`${path}: expected a value, got null`);
    return;
  }

  if (wrapper?.const !== undefined && value !== wrapper.const) {
    errors.push(`${path}: const mismatch (expected ${JSON.stringify(wrapper.const)}, got ${JSON.stringify(value)})`);
    return;
  }
  if (s.const !== undefined && value !== s.const) {
    errors.push(`${path}: const mismatch (expected ${JSON.stringify(s.const)}, got ${JSON.stringify(value)})`);
    return;
  }
  if (s.enum && !s.enum.includes(value as YValue)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${s.enum.join(', ')}]`);
    return;
  }

  switch (s.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string, got ${typeof value}`);
        return;
      }
      if (s.format === 'uuid' && !UUID_RE.test(value)) errors.push(`${path}: expected uuid format, got "${value}"`);
      if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: expected date-time format, got "${value}"`);
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: expected finite number, got ${JSON.stringify(value)}`);
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`);
        return;
      }
      if (s.items) value.forEach((v, i) => validateValue(v, s.items, spec, `${path}[${i}]`, errors));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const props = s.properties ?? {};
      if (s.required) {
        for (const req of s.required) {
          if (!(req in (value as Record<string, unknown>))) errors.push(`${path}.${req}: missing required property`);
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!(key in props)) errors.push(`${path}.${key}: undocumented property (handler returns a field the spec does not document)`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in (value as Record<string, unknown>)) {
          validateValue((value as Record<string, unknown>)[key], sub, spec, `${path}.${key}`, errors);
        }
      }
      return;
    }
    case undefined: {
      // No declared type. An empty schema ({}) accepts anything; a schema
      // with only properties behaves like an object schema.
      if (!s.properties) return;
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const props = s.properties;
      if (s.required) {
        for (const req of s.required) {
          if (!(req in (value as Record<string, unknown>))) errors.push(`${path}.${req}: missing required property`);
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!(key in props)) errors.push(`${path}.${key}: undocumented property`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in (value as Record<string, unknown>)) {
          validateValue((value as Record<string, unknown>)[key], sub, spec, `${path}.${key}`, errors);
        }
      }
      return;
    }
    default:
      return;
  }
}

export function validateResponseBody(body: unknown, schemaRef: string, spec: YMap): string[] {
  if (!schemaRef.startsWith('#/components/schemas/')) {
    schemaRef = `#/components/schemas/${schemaRef}`;
  }
  const schema = resolveRef(schemaRef, spec);
  const errors: string[] = [];
  validateValue(body, schema, spec, '$', errors);
  return errors;
}

/** Validate a value against a named component schema, returning the errors. */
export function validateNamed(value: unknown, schemaName: string, spec: YMap): string[] {
  const errors: string[] = [];
  validateValue(value, resolveRef(`#/components/schemas/${schemaName}`, spec), spec, '$', errors);
  return errors;
}

/**
 * Validate a value against a schema NODE (an inline response schema, not only a named
 * component), returning the errors. `$ref`s inside it resolve against `spec`.
 */
export function validateSchema(value: unknown, schema: unknown, spec: YMap): string[] {
  const errors: string[] = [];
  validateValue(value, schema as SchemaNode, spec, '$', errors);
  return errors;
}
