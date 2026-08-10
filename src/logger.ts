export type NatLogFn = (bindingsOrMessage: unknown, message?: string) => void

/** Minimal pino-compatible logger surface used by the package. */
export interface NatLogger {
  child(bindings: Record<string, unknown>): NatLogger
  debug: NatLogFn
  info: NatLogFn
  warn: NatLogFn
  error: NatLogFn
}

const noop: NatLogFn = () => {}

const noopLogger: NatLogger = {
  child: () => noopLogger,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

let rootLogger: NatLogger = noopLogger

/**
 * Inject a structured logger. Passing no logger restores the default no-op
 * implementation.
 */
export function setNatLogger(logger?: NatLogger): void {
  rootLogger = logger ?? noopLogger
}

function lazyLogger(resolve: () => NatLogger): NatLogger {
  return {
    child(bindings) {
      return lazyLogger(() => resolve().child(bindings))
    },
    debug(bindingsOrMessage, message) {
      resolve().debug(bindingsOrMessage, message)
    },
    info(bindingsOrMessage, message) {
      resolve().info(bindingsOrMessage, message)
    },
    warn(bindingsOrMessage, message) {
      resolve().warn(bindingsOrMessage, message)
    },
    error(bindingsOrMessage, message) {
      resolve().error(bindingsOrMessage, message)
    },
  }
}

// The lazy child observes logger injection that happens after module import.
export function natLogger(sub: string): NatLogger {
  return lazyLogger(() => rootLogger.child({ module: `nat.${sub}` }))
}
