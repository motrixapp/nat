import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type NatLogFn,
  type NatLogger,
  natLogger,
  setNatLogger,
} from './logger.js'

function fakeLogger() {
  const child = vi.fn<(bindings: Record<string, unknown>) => NatLogger>()
  const debug = vi.fn<NatLogFn>()
  const info = vi.fn<NatLogFn>()
  const warn = vi.fn<NatLogFn>()
  const error = vi.fn<NatLogFn>()
  const logger: NatLogger = {
    child,
    debug,
    info,
    warn,
    error,
  }
  child.mockReturnValue(logger)
  return { logger, child, debug, info, warn, error }
}

afterEach(() => setNatLogger())

describe('NAT logger injection', () => {
  it('is a no-op by default', () => {
    const log = natLogger('test')
    expect(() => log.info('ignored')).not.toThrow()
  })

  it('updates loggers created before injection', () => {
    const log = natLogger('test')
    const injected = fakeLogger()

    setNatLogger(injected.logger)
    log.warn({ attempt: 1 }, 'retrying')

    expect(injected.child).toHaveBeenCalledWith({ module: 'nat.test' })
    expect(injected.warn).toHaveBeenCalledWith({ attempt: 1 }, 'retrying')
  })
})
