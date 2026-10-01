import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('XML whitespace processing budget', () => {
  it('handles long interior whitespace without blocking on quadratic trimming', () => {
    // A subprocess timeout can interrupt a synchronous parser regression.
    // Vitest's in-process timeout cannot interrupt a blocked event loop.
    const parserUrl = new URL('./xml-parser.ts', import.meta.url).href
    const tokenizerUrl = new URL('./xml-tokenizer.ts', import.meta.url).href
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict'
          import { parseXml } from ${JSON.stringify(parserUrl)}
          import { tokenizeXml } from ${JSON.stringify(tokenizerUrl)}
          const gap = ' '.repeat(60000)
          const tag = '<a' + gap + 'x="v"/>'
          const text = '<a>x' + (' '.repeat(1000) + '<b/>').repeat(60) + 'x</a>'
          for (let i = 0; i < 10; i++) {
            assert.equal(tokenizeXml(tag).ok, true)
            const parsed = parseXml(text)
            assert.equal(parsed.ok, true)
            assert.equal(parsed.value.text, 'x' + gap + 'x')
          }
        `,
      ],
      { encoding: 'utf-8', timeout: 5000 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  }, 10_000)
})
