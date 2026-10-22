/**
 * Strict argument guards for model-provided tool arguments.
 *
 * `z.object` strips unknown keys silently; the model-facing JSON Schema declares
 * `additionalProperties: false`, so the runtime must reject unknown keys (at any
 * nesting level) instead of quietly dropping them. This walker interprets the
 * small JSON-Schema subset produced by `z.toJSONSchema` (definitions/$ref,
 * oneOf/anyOf/allOf, object properties, additionalProperties, array items).
 *
 * It also blocks prototype-polluting keys and pathological structures before any
 * schema parsing or tool execution happens.
 */
import type { JsonObject, JsonValue } from '@ca/contracts';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ARGUMENT_DEPTH = 64;
const MAX_ARGUMENT_NODES = 20_000;

export interface StructureCheckLimits {
  maxDepth?: number;
  maxNodes?: number;
  forbiddenKeys?: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a parsed JSON value and reject forbidden keys, excessive depth or size.
 * Returns a human-readable error or null when the structure is acceptable.
 */
export function checkArgumentStructure(root: unknown, limits: StructureCheckLimits = {}): string | null {
  const maxDepth = limits.maxDepth ?? MAX_ARGUMENT_DEPTH;
  const maxNodes = limits.maxNodes ?? MAX_ARGUMENT_NODES;
  const forbidden = limits.forbiddenKeys ?? FORBIDDEN_KEYS;

  interface Frame {
    value: unknown;
    depth: number;
    path: string;
  }
  let nodes = 0;
  const stack: Frame[] = [{ value: root, depth: 0, path: '$' }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) return `arguments contain more than ${maxNodes} JSON nodes`;
    const value = frame.value;
    if (value === null || typeof value !== 'object') continue;
    if (frame.depth + 1 > maxDepth) return `arguments exceed the maximum nesting depth of ${maxDepth}`;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: frame.depth + 1, path: `${frame.path}[${index}]` });
      }
      continue;
    }
    for (const key of Object.keys(value)) {
      if (forbidden.has(key)) {
        return `forbidden property "${key}" at ${frame.path}`;
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: frame.depth + 1, path: `${frame.path}.${key}` });
    }
  }
  return null;
}

type SchemaObject = Record<string, unknown>;

function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(root: SchemaObject, ref: string): SchemaObject | null {
  if (!ref.startsWith('#/')) return null;
  const tokens = ref.slice(2).split('/').map(decodePointerToken);
  let current: unknown = root;
  for (const token of tokens) {
    if (!isSchemaObject(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return null;
    current = current[token];
  }
  return isSchemaObject(current) ? current : null;
}

function resolveNode(root: SchemaObject, node: SchemaObject): SchemaObject {
  let current = node;
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    const resolved = resolveRef(root, current.$ref);
    if (!resolved) return {};
    current = resolved;
  }
  return current;
}

function schemaVariants(node: SchemaObject): SchemaObject[] {
  const oneOf = node.oneOf;
  const anyOf = node.anyOf;
  const variants = Array.isArray(oneOf) ? oneOf : Array.isArray(anyOf) ? anyOf : null;
  if (!variants) return [];
  return variants.filter(isSchemaObject);
}

/** True when a variant's constant discriminator property matches the value. */
function discriminatorMatches(root: SchemaObject, variant: SchemaObject, value: unknown): boolean {
  const resolved = resolveNode(root, variant);
  const properties = resolved.properties;
  if (!isSchemaObject(properties) || !isPlainObject(value)) return false;
  let sawDiscriminator = false;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isSchemaObject(propertySchema)) continue;
    const propertyNode = resolveNode(root, propertySchema);
    if ('const' in propertyNode) {
      sawDiscriminator = true;
      if ((value as Record<string, unknown>)[key] !== propertyNode.const) return false;
      continue;
    }
    const enumValues = propertyNode.enum;
    if (Array.isArray(enumValues) && enumValues.length === 1) {
      sawDiscriminator = true;
      if ((value as Record<string, unknown>)[key] !== enumValues[0]) return false;
    }
  }
  return sawDiscriminator;
}

function visit(root: SchemaObject, value: unknown, node: SchemaObject, path: string): string | null {
  const resolved = resolveNode(root, node);

  const allOf = resolved.allOf;
  if (Array.isArray(allOf)) {
    for (const sub of allOf) {
      if (!isSchemaObject(sub)) continue;
      const error = visit(root, value, sub, path);
      if (error) return error;
    }
    return null;
  }

  const variants = schemaVariants(resolved);
  if (variants.length > 0) {
    const candidates = variants.filter((variant) => discriminatorMatches(root, variant, value));
    const toCheck = candidates.length > 0 ? candidates : [];
    if (toCheck.length === 1) return visit(root, value, toCheck[0]!, path);
    let firstError: string | null = null;
    for (const candidate of toCheck) {
      const error = visit(root, value, candidate, path);
      if (!error) return null;
      firstError ??= error;
    }
    return firstError;
  }

  const type = resolved.type;
  const properties = resolved.properties;
  if (type === 'object' || isSchemaObject(properties)) {
    if (!isPlainObject(value)) return null; // type errors are reported by zod
    const propertySchemas = isSchemaObject(properties) ? properties : {};
    const additional = resolved.additionalProperties;
    for (const key of Object.keys(value)) {
      const childSchema = Object.prototype.hasOwnProperty.call(propertySchemas, key)
        ? propertySchemas[key]
        : undefined;
      if (childSchema === undefined) {
        if (additional === false) {
          const allowed = Object.keys(propertySchemas);
          return `unknown property "${key}" at ${path}${allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : ''}`;
        }
        if (isSchemaObject(additional)) {
          const error = visit(root, value[key], additional, `${path}.${key}`);
          if (error) return error;
        }
        continue;
      }
      if (isSchemaObject(childSchema)) {
        const error = visit(root, value[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
    }
    return null;
  }

  const items = resolved.items;
  if (type === 'array' || isSchemaObject(items)) {
    if (!Array.isArray(value)) return null;
    const itemSchema = isSchemaObject(items) ? items : null;
    if (itemSchema) {
      for (let index = 0; index < value.length; index += 1) {
        const error = visit(root, value[index], itemSchema, `${path}[${index}]`);
        if (error) return error;
      }
    }
    return null;
  }

  return null;
}

/**
 * Verify that a parsed argument object contains no keys outside the generated
 * JSON Schema. Returns a human-readable error or null.
 */
export function checkUnknownArgumentKeys(value: JsonValue, parameterSchema: JsonObject): string | null {
  return visit(parameterSchema as SchemaObject, value, parameterSchema as SchemaObject, '$');
}
