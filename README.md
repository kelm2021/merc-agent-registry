# MERC Agent Registry

The first opt-in, on-chain verified registry of AI agent wallets on Base.

## Architecture
- **Layer 1:** EAS attestations on Base for identity verification
- **Layer 2:** REST API (Vercel) backed by Blockscout + EAS GraphQL
- **Layer 3:** x402 payment gate ($0.10 USDC per call)
- **Layer 4:** MERC utility — hold 1K+ MERC = free access

## Endpoints
- `GET /agents` — list registered agents (top 10 free, full list paid)
- `GET /agents/:address` — single agent lookup
- `GET /agents/top-holders` — ranked by MERC holdings
- `POST /agents/register` — register your agent wallet

## Status: MVP (in development)
