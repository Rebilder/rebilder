/**
 * validate.ts — a JSON Schema validator small enough to read, covering exactly
 * the keywords `src/schema.ts` uses: type (including nullable unions and
 * "integer"), const, enum, properties, required, items.
 *
 * A dependency would be the obvious move and the wrong one: this package ships
 * with zero runtime dependencies and its test suite has no business pulling a
 * validator into the workspace to check five hand-written schemas. Unsupported
 * keywords are ignored, which is safe here because the point of the test is
 * "does a real ArsResult satisfy what we published", not "is our schema a
 * complete formal specification".
 */

import type { JsonObject, JsonValue } from '../src/json'

export interface Violation {
  readonly path: string
  readonly message: string
}

function typeOf(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value: JsonValue, expected: string): boolean {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

export function validate(value: JsonValue, schema: JsonObject, path = '$'): Violation[] {
  const violations: Violation[] = []

  const expectedType = schema['type']
  if (typeof expectedType === 'string' && !matchesType(value, expectedType)) {
    violations.push({ path, message: `expected ${expectedType}, got ${typeOf(value)}` })
    return violations
  }
  if (Array.isArray(expectedType)) {
    const allowed = expectedType.filter((entry): entry is string => typeof entry === 'string')
    if (!allowed.some((entry) => matchesType(value, entry))) {
      violations.push({
        path,
        message: `expected one of ${allowed.join('|')}, got ${typeOf(value)}`,
      })
      return violations
    }
  }

  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) {
    violations.push({ path, message: `expected const ${JSON.stringify(schema['const'])}` })
  }

  const enumeration = schema['enum']
  if (Array.isArray(enumeration)) {
    const serialised = JSON.stringify(value)
    if (!enumeration.some((entry) => JSON.stringify(entry) === serialised)) {
      violations.push({ path, message: `${serialised} is not in the declared enum` })
    }
  }

  const required = schema['required']
  if (Array.isArray(required) && typeOf(value) === 'object') {
    const object = value as JsonObject
    for (const key of required) {
      if (typeof key === 'string' && !(key in object)) {
        violations.push({ path: `${path}.${key}`, message: 'required property is missing' })
      }
    }
  }

  const properties = schema['properties']
  if (
    properties !== undefined &&
    !Array.isArray(properties) &&
    typeof properties === 'object' &&
    properties !== null &&
    typeOf(value) === 'object'
  ) {
    const object = value as JsonObject
    for (const [key, child] of Object.entries(properties as JsonObject)) {
      const present = object[key]
      if (present === undefined) continue
      if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
      violations.push(...validate(present, child, `${path}.${key}`))
    }
  }

  const items = schema['items']
  if (items !== undefined && Array.isArray(value)) {
    if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
      value.forEach((entry, index) => {
        violations.push(...validate(entry, items, `${path}[${index}]`))
      })
    }
  }

  return violations
}

/** Keys present on the value but absent from the schema's `properties`. */
export function undeclaredKeys(value: JsonObject, schema: JsonObject): string[] {
  const properties = schema['properties']
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return Object.keys(value)
  }
  const declared = new Set(Object.keys(properties as JsonObject))
  return Object.keys(value).filter((key) => !declared.has(key))
}
