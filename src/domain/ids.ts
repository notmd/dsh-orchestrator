/**
 * Record identifiers.
 *
 * A ULID-shaped id: 48 bits of millisecond timestamp then 80 bits of randomness,
 * Crockford base32, 26 characters. Two properties matter here and neither is
 * decoration:
 *
 *   - **Lexicographic order is creation order**, so a board sorted by id is also
 *     sorted by age, and a listing needs no second sort key.
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
function randomPart(): string {
  const bytes = new Uint8Array(RANDOM_CHARS)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ENCODING[byte % 32]
  return out
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
  const time = encode(now, TIME_CHARS)
  return `${prefix}-${time}${randomPart()}`
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
