import type { NatErrorCode } from '../errors.js'

// Discriminated union for codec results. Codecs NEVER throw — they return ParseErr.
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NatErrorCode; detail?: string }

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value }
}

export function parseErr<T = never>(
  error: NatErrorCode,
  detail?: string
): ParseResult<T> {
  return detail === undefined
    ? { ok: false, error }
    : { ok: false, error, detail }
}
