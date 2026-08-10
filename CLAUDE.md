# CLAUDE.md

## Project

`@motrix/nat` is Motrix's dependency-free Node.js NAT traversal library. It
implements UPnP IGD, NAT-PMP, PCP, and STUN, with strict parser and network
security boundaries.

## Commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm fuzz
pnpm test:integration
```

## Hard rules

- Keep runtime dependencies at zero.
- Never weaken the private/link-local IPv4 SSRF guard.
- Never add a general-purpose XML parser. The bounded tokenizer deliberately
  rejects DTD, ENTITY, CDATA, comments, and oversized input.
- Security-sensitive nonce and transaction ID comparisons use
  `crypto.timingSafeEqual`.
- `scripts/fuzz-nat-codecs.mjs --duration` is a total wall-clock budget shared
  across selected codecs.
- Keep Docker bridge services reachable through `containerIp()`; loopback is
  rejected by the SSRF guard.
- Do not publish without explicit user confirmation.

## Style and workflow

- Use TypeScript strict mode, NodeNext modules, Biome, and vitest.
- Use Conventional Commits in English without AI attribution.
- Conversation is in Chinese; code, identifiers, commits, and PR titles are
  in English.
