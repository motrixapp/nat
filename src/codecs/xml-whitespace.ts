function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** Trim XML S in linear time, preserving every other Unicode character. */
export function trimXmlWhitespace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isXmlWhitespace(value.charCodeAt(start))) start++
  while (end > start && isXmlWhitespace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}
