import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { NatErrorCode } from '../errors.js'
import { parseDeviceDescription } from './device-desc-parser.js'

const VALID_DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Test Router</friendlyName>
    <manufacturer>TP-LINK</manufacturer>
    <modelName>AX73</modelName>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
                <controlURL>/ctl/IPConn</controlURL>
                <eventSubURL>/evt/IPConn</eventSubURL>
                <SCPDURL>/IPConn.xml</SCPDURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`

describe('parseDeviceDescription happy path', () => {
  it('parses the Huawei AX3 Unicode friendlyName regression (issue #5)', () => {
    const xml = VALID_DESC.replace('Test Router', '华为路由AX3')
      .replace('TP-LINK', 'Huawei Technologies Co., Ltd.')
      .replace('AX73', 'WS7100-15')
    expect(parseDeviceDescription(xml)).toEqual({
      ok: true,
      value: {
        friendlyName: '华为路由AX3',
        manufacturer: 'Huawei Technologies Co., Ltd.',
        modelName: 'WS7100-15',
        services: [
          {
            serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
            controlUrl: '/ctl/IPConn',
          },
        ],
      },
    })
  })

  it('preserves Unicode in all device metadata, including surrogate pairs', () => {
    const xml = VALID_DESC.replace('Test Router', '\u00a0路由器📡\u3000')
      .replace('TP-LINK', '华为 技术')
      .replace('AX73', '型号\u{20000}')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.friendlyName).toBe('\u00a0路由器📡\u3000')
      expect(r.value.manufacturer).toBe('华为 技术')
      expect(r.value.modelName).toBe('型号\u{20000}')
      expect(r.value.services).toHaveLength(1)
    }
  })

  it('extracts manufacturer and model', () => {
    const r = parseDeviceDescription(VALID_DESC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.manufacturer).toBe('TP-LINK')
      expect(r.value.modelName).toBe('AX73')
      expect(r.value.friendlyName).toBe('Test Router')
    }
  })

  it('extracts WANIPConnection service', () => {
    const r = parseDeviceDescription(VALID_DESC)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.services).toHaveLength(1)
      const s = r.value.services[0]
      expect(s?.serviceType).toBe(
        'urn:schemas-upnp-org:service:WANIPConnection:1'
      )
      expect(s?.controlUrl).toBe('/ctl/IPConn')
    }
  })

  it('ignores non-port-mapping services', () => {
    const xml = VALID_DESC.replace(
      'urn:schemas-upnp-org:service:WANIPConnection:1',
      'urn:schemas-upnp-org:service:LANHostConfigManagement:1'
    )
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toEqual([])
  })
})

describe('parseDeviceDescription security', () => {
  it.each([
    '\u0000',
    '\u000b',
    '\u007f',
    '\u0085',
    '\ufffe',
    '\ud800',
    '\udc00',
    '\udc00\ud800',
  ])('rejects invalid characters or surrogates %j in friendlyName', (value) => {
    const r = parseDeviceDescription(
      VALID_DESC.replace('Test Router', `华为${value}AX3`)
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects relative path with ..', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/../../../secret')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects absolute URL in controlURL', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'http://evil.com/ctl')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL with CRLF', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/\r\nInjected: x')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL with non-ASCII', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/ä')
    const r = parseDeviceDescription(xml)
    expect(r).toEqual({
      ok: false,
      error: NatErrorCode.SecurityViolation,
      detail: 'controlURL has disallowed byte',
    })
  })

  it.each(['\u00a0/ctl/IPConn', '/ctl/IPConn\u3000'])(
    'does not trim Unicode whitespace out of controlURL %j',
    (value) => {
      const r = parseDeviceDescription(VALID_DESC.replace('/ctl/IPConn', value))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
    }
  )

  it('rejects descriptions exceeding size', () => {
    const huge = `<?xml version="1.0"?><root>${'<x/>'.repeat(30000)}</root>`
    const r = parseDeviceDescription(huge)
    expect(r.ok).toBe(false)
  })
})

test.prop([fc.string({ maxLength: 4096 })])(
  'parseDeviceDescription never throws',
  (s) => {
    const r = parseDeviceDescription(s)
    expect(typeof r.ok).toBe('boolean')
  }
)

describe('parseDeviceDescription additional branches', () => {
  it('returns empty string for missing friendlyName/manufacturer/modelName', () => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/ip</controlURL>
      </service>
    </serviceList>
  </device>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.friendlyName).toBe('')
      expect(r.value.manufacturer).toBe('')
      expect(r.value.modelName).toBe('')
    }
  })

  it('rejects when root element is not <root>', () => {
    const xml = `<?xml version="1.0"?>
<notroot><device/></notroot>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects when device element is missing', () => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major></specVersion>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('skips service with missing serviceType', () => {
    const xml = `<?xml version="1.0"?>
<root><device><serviceList><service><controlURL>/ctl</controlURL></service></serviceList></device></root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('skips service with missing controlURL', () => {
    const xml = `<?xml version="1.0"?>
<root><device><serviceList><service>
  <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
</service></serviceList></device></root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('skips service when controlURL is empty string (treated as missing)', () => {
    // Empty string is falsy so the service is skipped, not rejected
    const xml = VALID_DESC.replace('/ctl/IPConn', '')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.services).toHaveLength(0)
  })

  it('rejects controlURL exceeding max length (validateControlUrl path)', () => {
    // Must start with / to pass the prefix check, then be too long
    const longPath = `/${'a'.repeat(201)}`
    const xml = VALID_DESC.replace('/ctl/IPConn', longPath)
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects controlURL without leading slash', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'ctl/IPConn')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('rejects controlURL that looks like https absolute URL', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', 'https://evil.com/ctl')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(NatErrorCode.SecurityViolation)
  })

  it('rejects controlURL with disallowed character (space)', () => {
    const xml = VALID_DESC.replace('/ctl/IPConn', '/ctl/bad path')
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(false)
  })

  it('finds friendlyName via findDescendants fallback', () => {
    // Put friendlyName nested deeper (so findChild fails, findDescendants picks it up)
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <nested><friendlyName>Deep Router</friendlyName></nested>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/ip</controlURL>
      </service>
    </serviceList>
  </device>
</root>`
    const r = parseDeviceDescription(xml)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.friendlyName).toBe('Deep Router')
  })
})
