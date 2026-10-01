import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { NatErrorCode } from '../errors.js'
import { tokenizeXml, XmlTokenType } from './xml-tokenizer.js'

describe('xml-tokenizer character safety', () => {
  it('rejects input exceeding max size', () => {
    const xml = `<a>${'x'.repeat(64 * 1024)}</a>`
    const r = tokenizeXml(xml, { maxSize: 1024 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('enforces the UTF-8 byte budget for Unicode input', () => {
    const xml = '<a>华为📡</a>'
    const byteLength = Buffer.byteLength(xml, 'utf-8')
    expect(byteLength).toBeGreaterThan(xml.length)
    expect(tokenizeXml(xml, { maxSize: byteLength }).ok).toBe(true)
    expect(tokenizeXml(xml, { maxSize: byteLength - 1 })).toEqual({
      ok: false,
      error: NatErrorCode.SecurityViolation,
      detail: 'xml exceeds max size',
    })
  })

  it.each([
    '华为路由AX3',
    'Café e\u0301 日本語 العربية',
    ...[
      0x20, 0x7e, 0xa0, 0xd7ff, 0xe000, 0xfdd0, 0xfffd, 0x10000, 0x1f4e1,
      0x1fffe, 0x20000, 0x10ffff,
    ].map((code) => String.fromCodePoint(code)),
  ])('preserves valid Unicode %j in text and attribute values', (value) => {
    const r = tokenizeXml(`<a name="${value}">${value}</a>`)
    expect(r).toEqual({
      ok: true,
      value: [
        {
          type: XmlTokenType.StartTag,
          name: 'a',
          attrs: [{ name: 'name', value }],
          selfClosing: false,
        },
        { type: XmlTokenType.Text, value },
        { type: XmlTokenType.EndTag, name: 'a' },
      ],
    })
  })

  it.each([
    ...Array.from({ length: 0x20 }, (_, code) => code).filter(
      (code) => code !== 0x09 && code !== 0x0a && code !== 0x0d
    ),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ])('rejects control code point %i in text and attributes', (code) => {
    const value = String.fromCharCode(code)
    for (const xml of [`<a>${value}</a>`, `<a name="${value}"/>`]) {
      expect(tokenizeXml(xml)).toEqual({
        ok: false,
        error: NatErrorCode.SecurityViolation,
        detail: 'disallowed control char',
      })
    }
  })

  it.each([0xfffe, 0xffff])('rejects invalid XML code point %i', (code) => {
    const value = String.fromCharCode(code)
    for (const xml of [`<a>${value}</a>`, `<a name="${value}"/>`]) {
      expect(tokenizeXml(xml)).toEqual({
        ok: false,
        error: NatErrorCode.SecurityViolation,
        detail: 'invalid XML character',
      })
    }
  })

  it.each([
    '\ud800',
    '\udbff',
    '\udc00',
    '\udfff',
    '\ud800x',
    '\ud800\ud800',
    '\udc00\ud800',
    '\udc00\udc00',
    '\ud800\udc00\udc00',
  ])('rejects unpaired or malformed surrogates %j', (value) => {
    // Include end-of-input so a high surrogate cannot read past the string.
    for (const xml of [
      `<a>${value}</a>`,
      `<a name="${value}"/>`,
      `<a/>${value}`,
    ]) {
      expect(tokenizeXml(xml)).toEqual({
        ok: false,
        error: NatErrorCode.SecurityViolation,
        detail: 'unpaired surrogate',
      })
    }
  })

  it.each([
    '<华为/>',
    '<a华为/>',
    '<a></华为>',
    '<a></a华为>',
    '<a 名称="value"/>',
    '<a name华为="value"/>',
    '<a\u0301/>',
    '<a \u{10000}="value"/>',
  ])('keeps element and attribute names ASCII-only: %s', (xml) => {
    expect(tokenizeXml(xml).ok).toBe(false)
  })

  it.each([
    '\u00a0',
    '\u1680',
    '\u2003',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u3000',
    '\ufeff',
  ])('rejects non-XML whitespace %j in markup', (space) => {
    for (const xml of [
      `<${space}a/>`,
      `<a${space}/>`,
      `<a${space}name="x"/>`,
      `<a name${space}="x"/>`,
      `<a name=${space}"x"/>`,
      `<a></a${space}>`,
      `<a></${space}a>`,
    ]) {
      expect(tokenizeXml(xml).ok).toBe(false)
    }
  })

  it.each([
    '<!DOCTYPE a><a>华为</a>',
    '<!ENTITY x "华为"><a/>',
    '<a><![CDATA[华为]]></a>',
    '<a><!--华为--></a>',
    '<?vendor 华为?><a/>',
    '<a>华为&#21326;</a>',
    '<a>华为&#x534E;</a>',
    '<a name="华为&#x1F4E1;"/>',
  ])('keeps unsafe constructs forbidden with Unicode: %s', (xml) => {
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('decodes only standard entities alongside Unicode', () => {
    const r = tokenizeXml(
      '<a name="华为&amp;📡">华为&lt;&gt;&amp;&quot;&apos;📡</a>'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]).toMatchObject({
        attrs: [{ name: 'name', value: '华为&📡' }],
      })
      expect(r.value[1]).toEqual({
        type: XmlTokenType.Text,
        value: `华为<>&"'📡`,
      })
    }
  })

  it('accepts \\t \\n \\r', () => {
    const xml = '<a>hello\tworld\nfoo\r</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects DOCTYPE', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE a><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects ENTITY declarations', () => {
    const xml = '<!ENTITY x "y"><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects CDATA sections', () => {
    const xml = '<a><![CDATA[ hello ]]></a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects XML comments', () => {
    const xml = '<a><!-- comment --></a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects processing instructions other than XML declaration', () => {
    const xml = '<?xml-stylesheet?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts optional XML declaration', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects numeric character references', () => {
    const xml = '<a>&#60;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects hex character references', () => {
    const xml = '<a>&#x3C;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unknown entity references', () => {
    const xml = '<a>&xxe;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts the 5 standard entities', () => {
    const xml = '<a>&lt;&gt;&amp;&quot;&apos;</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const textToken = r.value.find((t) => t.type === XmlTokenType.Text)
      expect(textToken?.value).toBe(`<>&"'`)
    }
  })

  it('rejects single-quoted attributes', () => {
    const xml = `<a name='value'/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts double-quoted attributes', () => {
    const xml = '<a name="value"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })
})

describe('xml-tokenizer happy path', () => {
  it('tokenizes simple element', () => {
    const r = tokenizeXml('<root/>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual([
        {
          type: XmlTokenType.StartTag,
          name: 'root',
          attrs: [],
          selfClosing: true,
        },
      ])
    }
  })

  it('tokenizes nested elements', () => {
    const r = tokenizeXml('<a><b>text</b></a>')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((t) => t.type)).toEqual([
        XmlTokenType.StartTag,
        XmlTokenType.StartTag,
        XmlTokenType.Text,
        XmlTokenType.EndTag,
        XmlTokenType.EndTag,
      ])
    }
  })
})

test.prop([fc.uint8Array({ maxLength: 1024 })])(
  'tokenizeXml never throws on random bytes',
  (bytes) => {
    const xml = Buffer.from(bytes).toString('utf-8')
    const r = tokenizeXml(xml)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('xml-tokenizer additional branches', () => {
  it('rejects other <! declarations (not DOCTYPE/ENTITY/CDATA/comment)', () => {
    // e.g. <!NOTATION ...> or <!ELEMENT ...>
    const xml = '<!ELEMENT root ANY><root/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects attribute name exceeding max length', () => {
    const longName = 'a'.repeat(65)
    const xml = `<a ${longName}="value"/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute missing = sign', () => {
    const xml = '<a name/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated end tag', () => {
    const xml = '<a></a'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated start tag', () => {
    const xml = '<a'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid end tag name', () => {
    const xml = '<a></1invalid>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects entity with no semicolon within 10 chars', () => {
    const xml = '<a>&toolongentityname</a>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects unterminated attribute value (no closing quote)', () => {
    const xml = '<a name="value/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects XML declaration without ?> terminator', () => {
    const xml = '<?xml version="1.0"'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('accepts XML declaration with tab separator', () => {
    const xml = '<?xml\tversion="1.0"?><a/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(true)
  })

  it('rejects text node exceeding XML_MAX_TEXT_LENGTH (1024)', () => {
    const xml = `<a>${'x'.repeat(1025)}</a>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects tag with name exceeding XML_MAX_TAG_NAME_LENGTH', () => {
    const name = 'a'.repeat(65)
    const xml = `<${name}/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute name starting with non-letter/underscore', () => {
    // After the tag name, the body has something that does not match attrNameMatch
    // Force an attribute name that starts with a digit
    const xml = '<a 1bad="val"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects attribute value exceeding XML_MAX_ATTR_VALUE_LENGTH (256)', () => {
    const longVal = 'x'.repeat(257)
    const xml = `<a name="${longVal}"/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects more than XML_MAX_ATTRS_PER_ELEMENT (16) attributes', () => {
    const attrs = Array.from({ length: 17 }, (_, i) => `a${i}="v"`).join(' ')
    const xml = `<el ${attrs}/>`
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid entity in attribute value', () => {
    // Triggers the decodeEntities error branch inside parseStartTag
    const xml = '<a name="&bad;"/>'
    const r = tokenizeXml(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })
})
