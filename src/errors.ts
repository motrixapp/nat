/** Stable error codes returned by NAT protocol and transport operations. */
export enum NatErrorCode {
  DiscoveryFailed = 'NAT_DISCOVERY_FAILED',
  MappingFailed = 'NAT_MAPPING_FAILED',
  MappingConflict = 'NAT_MAPPING_CONFLICT',
  ProtocolRejected = 'NAT_PROTOCOL_REJECTED',
  ParseError = 'NAT_PARSE_ERROR',
  SecurityViolation = 'NAT_SECURITY_VIOLATION',
  Timeout = 'NAT_TIMEOUT',
  NetworkChanged = 'NAT_NETWORK_CHANGED',
  GatewayUnreachable = 'NAT_GATEWAY_UNREACHABLE',
  StunDetectionFailed = 'STUN_DETECTION_FAILED',
}
