import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NatErrorCode } from '../errors.js'

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}))

vi.mock('node:http', () => ({
  default: { request: requestMock },
}))

import { HTTP_MAX_RESPONSE_SIZE, NodeHttpClient } from './http-client.js'

class FakeRequest extends EventEmitter {
  destroyed = false
  endedWith: string | undefined
  timeoutMs: number | undefined
  timeoutHandler: (() => void) | undefined

  setTimeout(timeoutMs: number, handler: () => void): this {
    this.timeoutMs = timeoutMs
    this.timeoutHandler = handler
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  end(body?: string): void {
    this.endedWith = body
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false

  constructor(
    public statusCode: number,
    public headers: Record<string, string | string[] | undefined> = {}
  ) {
    super()
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

function primeRequest() {
  const request = new FakeRequest()
  let options: Record<string, unknown> | undefined
  let responseHandler: ((response: FakeResponse) => void) | undefined

  requestMock.mockImplementationOnce(
    (
      nextOptions: Record<string, unknown>,
      handler: (response: FakeResponse) => void
    ) => {
      options = nextOptions
      responseHandler = handler
      return request
    }
  )

  return {
    request,
    get options() {
      return options
    },
    respond(response: FakeResponse) {
      responseHandler?.(response)
    },
  }
}

describe('NodeHttpClient', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it.each([
    ['router.local', 'host must be literal IPv4'],
    ['8.8.8.8', 'host must be private or link-local IPv4'],
  ])('rejects unsafe host %s before opening a socket', async (host, detail) => {
    const result = await new NodeHttpClient().request({
      method: 'GET',
      host,
      port: 80,
      path: '/',
    })

    expect(result).toEqual({
      ok: false,
      error: NatErrorCode.SecurityViolation,
      detail,
    })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('sends a bounded private-IP request and normalizes the response', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'POST',
      host: '192.168.1.1',
      port: 49152,
      path: '/control',
      headers: { 'Content-Type': 'text/xml' },
      body: '<soap/>',
      timeoutMs: 1234,
    })

    expect(pendingRequest.options).toEqual({
      method: 'POST',
      host: '192.168.1.1',
      port: 49152,
      path: '/control',
      headers: { 'Content-Type': 'text/xml' },
      family: 4,
    })
    expect(pendingRequest.request.timeoutMs).toBe(1234)
    expect(pendingRequest.request.endedWith).toBe('<soap/>')

    const response = new FakeResponse(200, {
      'x-router': 'gateway',
      'set-cookie': ['a=1', 'b=2'],
      empty: undefined,
    })
    pendingRequest.respond(response)
    response.emit('data', Buffer.from('hello '))
    response.emit('data', Buffer.from('world'))
    response.emit('end')

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: {
        statusCode: 200,
        headers: {
          'x-router': 'gateway',
          'set-cookie': 'a=1,b=2',
          empty: '',
        },
        body: 'hello world',
      },
    })
  })

  it('returns a parse error when creating the HTTP request throws', async () => {
    requestMock.mockImplementationOnce(() => {
      throw new TypeError('Request path contains unescaped characters')
    })

    await expect(
      new NodeHttpClient().request({
        method: 'GET',
        host: '192.168.1.1',
        port: 80,
        path: '/invalid path',
      })
    ).resolves.toEqual({
      ok: false,
      error: NatErrorCode.ParseError,
      detail: 'Request path contains unescaped characters',
    })
  })

  it('preserves UTF-8 device text split across HTTP chunks', async () => {
    const pendingRequest = primeRequest()
    const pending = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.3.1',
      port: 37215,
      path: '/upnpdev.xml',
    })
    const response = new FakeResponse(200, {
      'content-type': 'text/xml; charset="utf-8"',
    })
    pendingRequest.respond(response)
    const body = '<friendlyName>华为路由AX3📡</friendlyName>'
    // Splitting at every byte covers boundaries within multibyte characters.
    for (const byte of Buffer.from(body, 'utf-8'))
      response.emit('data', Buffer.from([byte]))
    response.emit('end')

    await expect(pending).resolves.toMatchObject({ ok: true, value: { body } })
  })

  it('preserves a legitimately encoded Unicode replacement character', async () => {
    const pendingRequest = primeRequest()
    const pending = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.3.1',
      port: 37215,
      path: '/upnpdev.xml',
    })
    const response = new FakeResponse(200)
    pendingRequest.respond(response)
    const body = '<friendlyName>华为\ufffd📡</friendlyName>'
    response.emit('data', Buffer.from(body, 'utf-8'))
    response.emit('end')

    await expect(pending).resolves.toMatchObject({ ok: true, value: { body } })
  })

  const invalidUtf8: Array<[string, number[]]> = [
    ['isolated continuation byte', [0x80]],
    ['invalid leading byte', [0xff]],
    ['truncated multibyte sequence', [0xe4, 0xb8]],
    ['high surrogate', [0xed, 0xa0, 0x80]],
    ['low surrogate', [0xed, 0xb0, 0x80]],
    ['CESU-8 surrogate pair', [0xed, 0xa0, 0xbd, 0xed, 0xb3, 0xa1]],
    ['code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['overlong NUL', [0xc0, 0x80]],
    ['overlong markup delimiter', [0xe0, 0x80, 0xbc]],
  ]

  it.each(invalidUtf8)(
    'rejects UTF-8 %s before decoding',
    async (_name, bytes) => {
      // The outcome must not depend on boundaries inside a multibyte sequence.
      for (const split of [false, true]) {
        const pendingRequest = primeRequest()
        const pending = new NodeHttpClient().request({
          method: 'GET',
          host: '192.168.3.1',
          port: 37215,
          path: '/upnpdev.xml',
        })
        const response = new FakeResponse(200, {
          'content-type': 'text/xml; charset="utf-8"',
        })
        pendingRequest.respond(response)
        response.emit('data', Buffer.from('<friendlyName>华为'))
        if (split) {
          for (const byte of bytes) response.emit('data', Buffer.from([byte]))
        } else {
          response.emit('data', Buffer.from(bytes))
        }
        response.emit('data', Buffer.from('</friendlyName>'))
        response.emit('end')

        await expect(pending).resolves.toEqual({
          ok: false,
          error: NatErrorCode.SecurityViolation,
          detail: 'invalid UTF-8 response',
        })
      }
    }
  )

  it('rejects redirects without following them', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '169.254.10.20',
      port: 80,
      path: '/description.xml',
    })
    const response = new FakeResponse(302, {
      location: 'http://example.com/',
    })

    pendingRequest.respond(response)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: NatErrorCode.SecurityViolation,
      detail: 'unexpected redirect: 302',
    })
    expect(response.destroyed).toBe(true)
  })

  it('rejects responses above the hard size cap', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '10.0.0.1',
      port: 80,
      path: '/',
    })
    const response = new FakeResponse(200)

    pendingRequest.respond(response)
    response.emit('data', Buffer.alloc(HTTP_MAX_RESPONSE_SIZE + 1))

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: NatErrorCode.SecurityViolation,
      detail: 'http response too large',
    })
    expect(response.destroyed).toBe(true)
  })

  it('maps response stream errors to parse errors', async () => {
    const pendingRequest = primeRequest()
    const resultPromise = new NodeHttpClient().request({
      method: 'GET',
      host: '172.16.0.1',
      port: 80,
      path: '/',
    })
    const response = new FakeResponse(200)

    pendingRequest.respond(response)
    response.emit('error', new Error('truncated'))

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: NatErrorCode.ParseError,
      detail: 'truncated',
    })
  })

  it('maps request errors and timeouts to stable NAT errors', async () => {
    const failedRequest = primeRequest()
    const failedResult = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.0.1',
      port: 80,
      path: '/',
    })
    failedRequest.request.emit('error', new Error('connection refused'))

    await expect(failedResult).resolves.toEqual({
      ok: false,
      error: NatErrorCode.GatewayUnreachable,
      detail: 'connection refused',
    })

    const timedOutRequest = primeRequest()
    const timedOutResult = new NodeHttpClient().request({
      method: 'GET',
      host: '192.168.0.1',
      port: 80,
      path: '/',
      timeoutMs: 50,
    })
    timedOutRequest.request.timeoutHandler?.()

    await expect(timedOutResult).resolves.toEqual({
      ok: false,
      error: NatErrorCode.Timeout,
      detail: 'http timeout after 50ms',
    })
    expect(timedOutRequest.request.destroyed).toBe(true)
  })

  it('honors an already-aborted signal without writing a request body', async () => {
    const pendingRequest = primeRequest()
    const controller = new AbortController()
    controller.abort()

    const result = await new NodeHttpClient().request({
      method: 'POST',
      host: '192.168.0.1',
      port: 80,
      path: '/',
      body: 'must-not-send',
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: false,
      error: NatErrorCode.Timeout,
      detail: 'aborted',
    })
    expect(pendingRequest.request.destroyed).toBe(true)
    expect(pendingRequest.request.endedWith).toBeUndefined()
  })
})
