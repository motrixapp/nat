import { NatErrorCode } from '../errors.js'
import { type ParseResult, parseErr, parseOk } from './parse-result.js'
import { trimXmlWhitespace } from './xml-whitespace.js'

export const DEFAULT_XML_MAX_SIZE = 64 * 1024
export const XML_MAX_TAG_NAME_LENGTH = 64
export const XML_MAX_ATTR_NAME_LENGTH = 64
export const XML_MAX_ATTR_VALUE_LENGTH = 256
export const XML_MAX_ATTRS_PER_ELEMENT = 16
export const XML_MAX_TEXT_LENGTH = 1024

export enum XmlTokenType {
  StartTag = 'start',
  EndTag = 'end',
  Text = 'text',
}

export interface XmlStartTag {
  type: XmlTokenType.StartTag
  name: string
  attrs: Array<{ name: string; value: string }>
  selfClosing: boolean
}
export interface XmlEndTag {
  type: XmlTokenType.EndTag
  name: string
}
export interface XmlText {
  type: XmlTokenType.Text
  value: string
}

export type XmlToken = XmlStartTag | XmlEndTag | XmlText

export interface TokenizerOptions {
  maxSize?: number
}

const ALLOWED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

// XML 1.0 Fifth Edition, production [2] (Char).
function isXmlChar(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  )
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_:\-.]/.test(ch)
}

export function tokenizeXml(
  xml: string,
  options: TokenizerOptions = {}
): ParseResult<XmlToken[]> {
  const maxSize = options.maxSize ?? DEFAULT_XML_MAX_SIZE

  // Keep the original byte budget now that one character may span many bytes.
  if (xml.length > maxSize || Buffer.byteLength(xml, 'utf-8') > maxSize) {
    return parseErr(NatErrorCode.SecurityViolation, 'xml exceeds max size')
  }

  for (let i = 0; i < xml.length; i++) {
    // codePointAt combines valid UTF-16 pairs, but leaves lone surrogates
    // in 0xD800..0xDFFF, which the XML Char ranges exclude.
    const code = xml.codePointAt(i) ?? 0
    if (!isXmlChar(code)) {
      return parseErr(
        NatErrorCode.SecurityViolation,
        code < 0x20
          ? 'disallowed control char'
          : code >= 0xd800 && code <= 0xdfff
            ? 'unpaired surrogate'
            : 'invalid XML character'
      )
    }
    // Preserve the existing ban on DEL/C1 controls, even though XML 1.0
    // permits them. Unicode support applies to text and attribute values.
    if (code >= 0x7f && code <= 0x9f) {
      return parseErr(NatErrorCode.SecurityViolation, 'disallowed control char')
    }
    if (code > 0xffff) i++
  }

  const tokens: XmlToken[] = []
  let i = 0

  if (xml.startsWith('<?xml ', i) || xml.startsWith('<?xml\t', i)) {
    const end = xml.indexOf('?>', i)
    if (end < 0) {
      return parseErr(NatErrorCode.ParseError, 'unterminated XML declaration')
    }
    i = end + 2
    while (i < xml.length && /[ \t\r\n]/.test(xml[i] ?? '')) i++
  }

  while (i < xml.length) {
    const ch = xml[i]

    if (ch === '<') {
      if (xml.startsWith('<!--', i)) {
        return parseErr(NatErrorCode.SecurityViolation, 'comments forbidden')
      }
      if (xml.startsWith('<![CDATA[', i)) {
        return parseErr(NatErrorCode.SecurityViolation, 'CDATA forbidden')
      }
      if (xml.startsWith('<!DOCTYPE', i)) {
        return parseErr(NatErrorCode.SecurityViolation, 'DOCTYPE forbidden')
      }
      if (xml.startsWith('<!ENTITY', i)) {
        return parseErr(NatErrorCode.SecurityViolation, 'ENTITY forbidden')
      }
      if (xml.startsWith('<!', i)) {
        return parseErr(NatErrorCode.SecurityViolation, 'declaration forbidden')
      }
      if (xml.startsWith('<?', i)) {
        return parseErr(
          NatErrorCode.SecurityViolation,
          'processing instruction forbidden'
        )
      }

      if (xml[i + 1] === '/') {
        const close = xml.indexOf('>', i + 2)
        if (close < 0) {
          return parseErr(NatErrorCode.ParseError, 'unterminated end tag')
        }
        const name = trimXmlWhitespace(xml.slice(i + 2, close))
        if (!validateName(name)) {
          return parseErr(NatErrorCode.SecurityViolation, 'invalid tag name')
        }
        tokens.push({ type: XmlTokenType.EndTag, name })
        i = close + 1
        continue
      }

      const close = xml.indexOf('>', i)
      if (close < 0) {
        return parseErr(NatErrorCode.ParseError, 'unterminated start tag')
      }
      const inner = xml.slice(i + 1, close)
      const selfClosing = inner.endsWith('/')
      const body = selfClosing ? inner.slice(0, -1) : inner

      const tag = parseStartTag(body)
      if (!tag.ok) return tag
      tokens.push({ ...tag.value, selfClosing })
      i = close + 1
      continue
    }

    const nextLt = xml.indexOf('<', i)
    const textEnd = nextLt < 0 ? xml.length : nextLt
    const rawText = xml.slice(i, textEnd)

    if (rawText.length > XML_MAX_TEXT_LENGTH) {
      return parseErr(NatErrorCode.SecurityViolation, 'text node too long')
    }

    const decoded = decodeEntities(rawText)
    if (!decoded.ok) return decoded
    tokens.push({ type: XmlTokenType.Text, value: decoded.value })
    i = textEnd
  }

  return parseOk(tokens)
}

function validateName(name: string): boolean {
  if (name.length === 0 || name.length > XML_MAX_TAG_NAME_LENGTH) return false
  if (!isNameStart(name[0] ?? '')) return false
  for (let i = 1; i < name.length; i++) {
    if (!isNameChar(name[i] ?? '')) return false
  }
  return true
}

function parseStartTag(
  body: string
): ParseResult<Omit<XmlStartTag, 'selfClosing'>> {
  // XML S is only space, tab, CR and LF; JS \s/trim also accept Unicode
  // characters that must not become tag or attribute separators.
  const trimmed = trimXmlWhitespace(body)
  let p = 0
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_:\-.]*)/.exec(trimmed.slice(p))
  if (!nameMatch) return parseErr(NatErrorCode.ParseError, 'missing tag name')
  const name = nameMatch[1] ?? ''
  if (!validateName(name)) {
    return parseErr(NatErrorCode.SecurityViolation, 'invalid tag name')
  }
  p += name.length

  const attrs: Array<{ name: string; value: string }> = []
  while (p < trimmed.length) {
    while (p < trimmed.length && /[ \t\r\n]/.test(trimmed[p] ?? '')) p++
    if (p >= trimmed.length) break

    const attrNameMatch = /^([A-Za-z_][A-Za-z0-9_:\-.]*)/.exec(trimmed.slice(p))
    if (!attrNameMatch) {
      return parseErr(NatErrorCode.ParseError, 'invalid attribute name')
    }
    const attrName = attrNameMatch[1] ?? ''
    if (attrName.length > XML_MAX_ATTR_NAME_LENGTH) {
      return parseErr(NatErrorCode.SecurityViolation, 'attribute name too long')
    }
    p += attrName.length

    while (p < trimmed.length && /[ \t\r\n]/.test(trimmed[p] ?? '')) p++
    if (trimmed[p] !== '=') {
      return parseErr(
        NatErrorCode.ParseError,
        'expected = after attribute name'
      )
    }
    p++
    while (p < trimmed.length && /[ \t\r\n]/.test(trimmed[p] ?? '')) p++
    if (trimmed[p] !== '"') {
      return parseErr(
        NatErrorCode.SecurityViolation,
        'attribute values must use double quotes'
      )
    }
    p++
    const endQuote = trimmed.indexOf('"', p)
    if (endQuote < 0) {
      return parseErr(NatErrorCode.ParseError, 'unterminated attribute value')
    }
    const rawValue = trimmed.slice(p, endQuote)
    if (rawValue.length > XML_MAX_ATTR_VALUE_LENGTH) {
      return parseErr(
        NatErrorCode.SecurityViolation,
        'attribute value too long'
      )
    }
    const decoded = decodeEntities(rawValue)
    if (!decoded.ok) return decoded
    attrs.push({ name: attrName, value: decoded.value })
    p = endQuote + 1

    if (attrs.length > XML_MAX_ATTRS_PER_ELEMENT) {
      return parseErr(NatErrorCode.SecurityViolation, 'too many attributes')
    }
  }

  return parseOk({ type: XmlTokenType.StartTag, name, attrs })
}

function decodeEntities(s: string): ParseResult<string> {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch !== '&') {
      out += ch
      i++
      continue
    }
    if (s[i + 1] === '#') {
      return parseErr(
        NatErrorCode.SecurityViolation,
        'numeric character references forbidden'
      )
    }
    const semi = s.indexOf(';', i + 1)
    if (semi < 0 || semi - i > 10) {
      return parseErr(
        NatErrorCode.SecurityViolation,
        'unterminated entity reference'
      )
    }
    const name = s.slice(i + 1, semi)
    const replacement = ALLOWED_ENTITIES[name]
    if (replacement === undefined) {
      return parseErr(
        NatErrorCode.SecurityViolation,
        `unknown entity: &${name};`
      )
    }
    out += replacement
    i = semi + 1
  }
  return parseOk(out)
}
