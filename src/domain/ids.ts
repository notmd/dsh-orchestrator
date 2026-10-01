/**
 * Record identifiers.
 *
 * A ULID-shaped id: 48 bits of millisecond timestamp then 80 bits of randomness,
 * Crockford base32, 26 characters. Two properties matter here and neither is
 * decoration:
 *
 *   - **Lexicographic order is creation order**, so a board sorted by id is also
 *     sorted by age, and a listing needs no second sort key. That holds *within a
 *     millisecond* too: the random half is an incrementing counter while the clock
 *     stands still, which is what ULID monotonicity is for. Without it two records
 *     created in the same millisecond would order arbitrarily — which is how
 *     "highest priority, then oldest first" silently stopped being oldest-first.
 *   - **The alphabet is `[0-9A-HJKMNP-TV-Z]`** — Crockford excludes `I`, `L`, `O`
 *     and `U` precisely because they are mistaken for `1`, `1`, `0` and `V`. That
 *     makes an id safe to read out loud, which is not true of a UUID.
 *
 * The shape is also what makes an id usable as a storage key: alphanumerics and
 * dashes only, which is what the KV layer's `per-record` layout requires
 * (`assertRecordKey`).
 *
 * @module dsho/domain/ids
 */

/** Crockford base32: no I, L, O or U. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 26 characters: 10 of timestamp, 16 of randomness. */
const TIME_CHARS = 10
const RANDOM_CHARS = 16

/** Encodes a non-negative integer as fixed-width base32, most significant first. */
function encode(value: number, width: number): string {
  let remaining = value
  let out = ''
  for (let index = 0; index < width; index += 1) {
    out = ENCODING[remaining % 32]! + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

/** 16 base32 characters of randomness, drawn from a CSPRNG. */
function freshRandom(): string {
  const bytes = new Uint8Array(RANDOM_CHARS)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ENCODING[byte % 32]
  return out
}

/**
 * Increments a base32 string by one, carrying leftwards.
 *
 * Used to keep ids strictly increasing inside a single millisecond: the ULID
 * random half is otherwise *random*, which would make two records created in the
 * same millisecond order arbitrarily.
 */
function incrementBase32(value: string): string {
  const digits = [...value]
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = ENCODING.indexOf(digits[index]!) + 1
    if (next < ENCODING.length) {
      digits[index] = ENCODING[next]!
      return digits.join('')
    }
    digits[index] = ENCODING[0]!
  }
  // Every digit carried: the random space is exhausted for this millisecond.
  // Regenerating would be the only remaining option, and it would cost
  // monotonicity, so the value is left saturated instead. Reaching this needs
  // 32^16 records in one millisecond.
  return digits.join('')
}

/** Process-local monotonic state: the last timestamp issued and its random half. */
let lastTime = 0
let lastRandom = ''

/** A timestamp and random half that never go backwards within this process. */
function nextParts(now: number): { time: number; random: string } {
  if (now > lastTime) {
    lastTime = now
    lastRandom = freshRandom()
    return { time: now, random: lastRandom }
  }
  // Same millisecond, or a clock that stepped backwards: keep the last timestamp
  // and advance the random half, which is exactly what ULID monotonicity means.
  lastRandom = incrementBase32(lastRandom || freshRandom())
  return { time: lastTime, random: lastRandom }
}

/**
 * Builds an id like `iss-01J8ZQ4K7M3N5P6R7S8T9V0WX`.
 *
 * `prefix` is the record kind (`iss`, `wrk`, `repo`) and a dash, exactly the PRD's
 * shapes (§7.1–§7.3). A `now` may be injected so a test can pin the time half.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!/^[a-z]+$/.test(prefix)) {
    throw new Error(`newId: prefix must be lowercase letters, got ${JSON.stringify(prefix)}`)
  }
  const parts = nextParts(now)
  return `${prefix}-${encode(parts.time, TIME_CHARS)}${parts.random}`
}

/** The timestamp half of an id, or `undefined` if it is not one of ours. */
export function timestampOf(id: string): number | undefined {
  const [, encoded] = id.split('-')
  if (!encoded || encoded.length !== TIME_CHARS + RANDOM_CHARS) return undefined
  let value = 0
  for (const char of encoded.slice(0, TIME_CHARS)) {
    const digit = ENCODING.indexOf(char)
    if (digit < 0) return undefined
    value = value * 32 + digit
  }
  return value
}

/** True when an id has our shape, so it is safe as a storage key. */
export function isRecordId(id: string): boolean {
  return /^[a-z]+-[0-9A-HJKMNP-TV-Z]{26}$/.test(id)
}
