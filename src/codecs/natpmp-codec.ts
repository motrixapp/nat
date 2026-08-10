import { NatErrorCode } from '../errors.js'
import { PROTOCOL_MAX_LIFETIME_SECONDS } from './constants.js'
import { bufferToIpv4, isValidPort } from './ip-utils.js'
import { type ParseResult, parseErr, parseOk } from './parse-result.js'

export const NATPMP_PORT = 5351
export const NATPMP_VERSION = 0

export const NATPMP_OPCODE_EXTERNAL_IP = 0
export const NATPMP_OPCODE_MAP_UDP = 1
export const NATPMP_OPCODE_MAP_TCP = 2

export function buildExternalIpRequest(): Buffer {
  return Buffer.from([NATPMP_VERSION, NATPMP_OPCODE_EXTERNAL_IP])
}

export function buildMappingRequest(
  protocol: 'TCP' | 'UDP',
  internalPort: number,
  externalPort: number,
  ttl: number
): Buffer {
  if (!isValidPort(internalPort)) {
    throw new Error('internalPort out of range')
  }
  if (!isValidPort(externalPort, { allowZero: true })) {
    throw new Error('externalPort out of range')
  }
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff) {
    throw new Error('ttl out of range')
  }
  const buf = Buffer.alloc(12)
  buf[0] = NATPMP_VERSION
  buf[1] = protocol === 'TCP' ? NATPMP_OPCODE_MAP_TCP : NATPMP_OPCODE_MAP_UDP
  buf.writeUInt16BE(0, 2)
  buf.writeUInt16BE(internalPort, 4)
  buf.writeUInt16BE(externalPort, 6)
  buf.writeUInt32BE(ttl, 8)
  return buf
}

export type NatPmpResponse =
  | {
      kind: 'external-ip'
      resultCode: number
      epochSeconds: number
      externalIp: string
    }
  | {
      kind: 'mapping'
      resultCode: number
      epochSeconds: number
      internalPort: number
      externalPort: number
      ttl: number
    }

export function parseNatPmpResponse(
  buf: Buffer,
  expectedOpcode: number,
  sourceIp: string,
  gatewayIp: string
): ParseResult<NatPmpResponse> {
  if (sourceIp !== gatewayIp) {
    return parseErr(
      NatErrorCode.SecurityViolation,
      'response source IP mismatch'
    )
  }
  if (buf.length !== 12 && buf.length !== 16) {
    return parseErr(NatErrorCode.ParseError, `unexpected length: ${buf.length}`)
  }
  if (buf.readUInt8(0) !== NATPMP_VERSION) {
    return parseErr(
      NatErrorCode.ParseError,
      `wrong version: ${buf.readUInt8(0)}`
    )
  }
  const rawOpcode = buf.readUInt8(1)
  if ((rawOpcode & 0x80) === 0) {
    return parseErr(NatErrorCode.ParseError, 'response bit not set')
  }
  if ((rawOpcode & 0x7f) !== expectedOpcode) {
    return parseErr(NatErrorCode.ParseError, 'opcode mismatch')
  }
  const resultCode = buf.readUInt16BE(2)
  if (resultCode > 5) {
    return parseErr(
      NatErrorCode.ParseError,
      `invalid result code: ${resultCode}`
    )
  }
  if (resultCode !== 0) {
    return parseErr(
      NatErrorCode.ProtocolRejected,
      `natpmp error: result code ${resultCode}`
    )
  }
  const epochSeconds = buf.readUInt32BE(4)

  if (expectedOpcode === NATPMP_OPCODE_EXTERNAL_IP) {
    if (buf.length !== 12) {
      return parseErr(NatErrorCode.ParseError, 'external IP response length')
    }
    const externalIp = bufferToIpv4(buf, 8)
    return parseOk({
      kind: 'external-ip',
      resultCode,
      epochSeconds,
      externalIp,
    })
  }

  if (buf.length !== 16) {
    return parseErr(NatErrorCode.ParseError, 'mapping response length')
  }
  const internalPort = buf.readUInt16BE(8)
  const externalPort = buf.readUInt16BE(10)
  const rawTtl = buf.readUInt32BE(12)
  const ttl = Math.min(rawTtl, PROTOCOL_MAX_LIFETIME_SECONDS)
  return parseOk({
    kind: 'mapping',
    resultCode,
    epochSeconds,
    internalPort,
    externalPort,
    ttl,
  })
}
