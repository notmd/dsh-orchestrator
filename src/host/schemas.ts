/**
 * The zod schemas that validate each table's records at the durable boundary.
 *
 * This is the **only** module that imports zod, and it exists because
 * `DomainTableSpec.valueSchema` is a `ZodType`: the native storage path requires
 * one, and this plugin's earlier attempt to avoid zod is what made the storage
 * adapter wrong (see `./store.ts`).
 *
 * ## Why the record schemas are permissive
 *
 * Each schema asserts only what the boundary can usefully assert: that a record is
 * a **JSON object**. It does not enumerate fields, for two reasons.
 *
 *   1. **The ported normalizers are the real validators.** `prFacts()`,
 *      `sessionFacts()` and `reviewRunFacts()` fill Go's zero values on every read,
 *      which is exactly how a record that predates a field is supposed to behave —
 *      and it is the behaviour AO's own tests pin. A strict schema here would
 *      *reject* an old record that the reducer is perfectly able to read.
 *   2. A strict schema makes every future field addition a migration. The reference
 *      stores snapshots that gain fields constantly; a schema that has to be bumped
 *      alongside each one would fail `open` on the user's existing data.
 *
 * What the object check does buy is real: a truncated or corrupted document is a
 * JSON *scalar* or *array* far more often than it is a plausible object, and
 * `z.custom` rejects those at the durable boundary rather than letting them reach a
 * normalizer that would silently fabricate an empty record.
 *
 * @module dsho/host/schemas
 */

import { z } from 'zod'

import { FACT_TABLE_NAMES } from './store.ts'

/** A JSON object: not null, not an array, not a scalar. */
export const recordSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  { message: 'a stored record must be a JSON object' },
)

/** One schema per declared table. */
export const FACT_SCHEMAS: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(FACT_TABLE_NAMES.map((table) => [table, recordSchema])),
)
