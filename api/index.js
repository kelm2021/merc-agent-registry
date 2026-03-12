const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { createPublicClient, http, parseAbiItem, verifyMessage } = require('viem');
const { base } = require('viem/chains');
const { x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { bazaarResourceServerExtension, declareDiscoveryExtension } = require('@x402/extensions');

const app = express();
// Trust proxy headers from Vercel — ensures req.protocol returns 'https' not 'http'
// This fixes the resource URL in x402 402 responses
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// ─── Constants ────────────────────────────────────────────────────────────────
const MERC_BASE = '0x8923947EAfaf4aD68F1f0C9eb5463eC876D79058';
const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const EAS_SCHEMA_UID = '0xd517dc2a16083df866b992430d9028924fc204d0457ff4d452f3c5b738a248af';
const MERC_FREE_THRESHOLD = 100;
// ClawOps EOA — signing wallet, usable for openx402 seller registration
// (CDP wallet 0xC1ce2f3fc018EB304Fa178BDDFFf0E5664Fa6B64 is custodial, can't sign for registration)
const PAYMENT_RECEIVER = '0xEa8F59B504F18Ac7ed25C735f07864ae2EeFa493';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Use CAIP-2 format 'eip155:8453' — works with both CDP and openx402.ai facilitators
// ExactEvmScheme client registers for 'eip155:*' which wildcards this
const BASE_MAINNET = 'eip155:8453';
const CANONICAL_PAID_URL = 'https://merc-agent-registry-lake.vercel.app/api/agents/full';
const CANONICAL_AGENTIC_REGISTER_URL = 'https://merc-agent-registry-lake.vercel.app/agents/register/agentic';
const EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
const BASE_RPC_URLS = (process.env.BASE_RPC_URLS || process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com,https://1rpc.io/base,https://base-mainnet.public.blastapi.io,https://mainnet.base.org')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);
const AGENTIC_REGISTRY_FROM_BLOCK = BigInt(process.env.AGENTIC_REGISTRY_FROM_BLOCK || '43270000');
const EAS_SCHEMA_HYDRATION_PAGE_SIZE = Number(process.env.EAS_SCHEMA_HYDRATION_PAGE_SIZE || 100);
const EAS_SCHEMA_HYDRATION_MAX_PAGES = Number(process.env.EAS_SCHEMA_HYDRATION_MAX_PAGES || 20);

// ─── CDP / x402 Facilitator config ───────────────────────────────────────────
// Canonical env vars (standardized):
//   CDP_API_KEY        — CDP API key ID (UUID)
//   CDP_API_KEY_SECRET — CDP API key secret (Ed25519 base64)
//   CDP_FACILITATOR_URL — base URL for facilitator (e.g. https://api.cdp.coinbase.com/platform/v2/x402/facilitator)
//
// Legacy aliases (also supported for backwards compat):
//   CDP_API_KEY_ID   → same as CDP_API_KEY
//   CDP_API_SECRET   → same as CDP_API_KEY_SECRET
//
// If no CDP key is set, falls back to unauthenticated facilitator.openx402.ai (verify only).

const cdpKeyId = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID;
const cdpSecret = process.env.CDP_API_KEY_SECRET || process.env.CDP_API_SECRET;
// CDP_FACILITATOR_URL is the canonical base URL — strip trailing slash
// HTTPFacilitatorClient appends /verify, /settle, /supported to this base
const facilitatorUrl = (process.env.CDP_FACILITATOR_URL || 'https://facilitator.openx402.ai').replace(/\/$/, '');

// Derive JWT request paths from facilitator URL
// e.g. https://api.cdp.coinbase.com/platform/v2/x402/facilitator → /platform/v2/x402/facilitator
function getFacilitatorBasePath() {
  try {
    return new URL(facilitatorUrl).pathname.replace(/\/$/, '');
  } catch(e) {
    return '/platform/v2/x402/facilitator';
  }
}

// @coinbase/cdp-sdk uses jose (ESM-only), so we must use dynamic import()
async function generateCdpJwt(method, requestPath) {
  const { generateJwt } = await import('@coinbase/cdp-sdk/auth');
  return generateJwt({
    apiKeyId: cdpKeyId,
    apiKeySecret: cdpSecret,
    requestMethod: method,
    requestHost: 'api.cdp.coinbase.com',
    requestPath
  });
}

// HTTPFacilitatorClient.createAuthHeaders() is called with no args, then does authHeaders[verb]
// where verb = "verify" | "settle" | "supported"
// Return { verify: {Authorization}, settle: {Authorization}, supported: {Authorization} }
async function buildCdpAuthHeadersMap() {
  if (!cdpKeyId || !cdpSecret) return {};
  const base = getFacilitatorBasePath();
  const verbs = [
    { key: 'verify',    method: 'POST' },
    { key: 'settle',    method: 'POST' },
    { key: 'supported', method: 'GET'  }
  ];
  const result = {};
  await Promise.all(verbs.map(async ({ key, method }) => {
    try {
      const jwt = await generateCdpJwt(method, `${base}/${key}`);
      result[key] = { Authorization: 'Bearer ' + jwt };
    } catch(e) {
      console.error(`JWT gen failed for ${key}:`, e.message);
    }
  }));
  return result;
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  ...(cdpKeyId && cdpSecret ? { createAuthHeaders: buildCdpAuthHeadersMap } : {})
});

const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(BASE_MAINNET, new ExactEvmScheme());
resourceServer.registerExtension(bazaarResourceServerExtension);

// ─── Bazaar discovery metadata for /api/agents/full ──────────────────────────
const agentsFullDiscovery = declareDiscoveryExtension({
  input: {
    type: 'http',
    method: 'GET'
  },
  output: {
    type: 'application/json',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Agents returned' },
        total: { type: 'number', description: 'Total registered agents' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', description: 'Agent wallet address (Base)' },
              agentName: { type: 'string' },
              agentType: { type: 'string' },
              modelProvider: { type: 'string' },
              operatorHandle: { type: 'string' },
              mercBalance: { type: 'number', description: 'MERC token balance' },
              attestationUid: { type: 'string', description: 'EAS attestation UID on Base' },
              agentNumber: { type: 'number' }
            }
          }
        }
      }
    },
    example: {
      count: 2,
      total: 2,
      paid: true,
      agents: [
        {
          // Botti entry removed — not authorized by Jake. Re-add when Jake confirms.
          // address: '0xEaAE848fbD8F88874F5660E3F615a1430EEE5880',
          // agentName: 'Botti',
          agentType: 'Orchestrator',
          modelProvider: 'Anthropic Claude',
          mercBalance: 5924,
          attestationUid: '0xbb72046bca7f3ff34bfdf49d12e8bcfe3e0381029a8fcdebad2b899a3fe9fa96',
          agentNumber: 1
        }
      ]
    }
  }
});

// ─── Payment route config ─────────────────────────────────────────────────────
const agentsFullPaymentConfig = {
  'GET /api/agents/full': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.01',
        network: BASE_MAINNET,
        payTo: PAYMENT_RECEIVER,
        asset: USDC_BASE,
        description: 'Full MERC AI Agent Registry — all agents with live balances and EAS attestations',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
        extra: {
          name: 'MERC Agent Registry',
          mercFreeAccess: `Hold ${MERC_FREE_THRESHOLD}+ MERC at /agents/merc?wallet=0x...`,
          mercContract: MERC_BASE,
          easSchema: EAS_SCHEMA_UID,
          ...agentsFullDiscovery
        }
      }
    ]
  }
};

// ─── Fast 402 interceptor for Vercel ─────────────────────────────────────────
// The official x402 middleware calls facilitator.getSupported() on EVERY request
// (to build the 402 response), which times out in Vercel's serverless environment.
// We short-circuit unpaid requests with a pre-built 402 response,
// and only invoke the official middleware (which hits the facilitator) when
// a payment header is present (i.e., an actual payment attempt).
// x402Version:2 — the current @x402/evm ExactEvmScheme only handles v2
// Delivery: base64-encoded PAYMENT-REQUIRED header (required for v2)
// Body: same object with x402Version:2 (for clients that read body)
const PAYMENT_REQUIREMENTS = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    network: BASE_MAINNET,
    maxAmountRequired: '10000', // $0.01 USDC (6 decimals) — for facilitator
    amount: '10000', // $0.01 USDC — read by ExactEvmScheme client for EIP-3009
    resource: CANONICAL_PAID_URL,
    description: 'Full MERC AI Agent Registry — all agents with live balances and EAS attestations',
    mimeType: 'application/json',
    payTo: PAYMENT_RECEIVER,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    extra: {
      // EIP-712 domain for USDC on Base — client reads from extra.name / extra.version
      name: 'USD Coin',
      version: '2',
      mercFreeAccess: `Hold ${MERC_FREE_THRESHOLD}+ MERC at /agents/merc?wallet=0x...`,
      mercContract: MERC_BASE,
      easSchema: EAS_SCHEMA_UID
    }
  }]
};

const AGENTIC_REGISTER_PAYMENT_REQUIREMENTS = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    network: BASE_MAINNET,
    maxAmountRequired: '1000', // $0.001 USDC
    amount: '1000',
    resource: CANONICAL_AGENTIC_REGISTER_URL,
    description: 'Agentic wallet registration proof — registers the verified x402 payer address',
    mimeType: 'application/json',
    payTo: PAYMENT_RECEIVER,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    extra: {
      name: 'USD Coin',
      version: '2',
      registrationPath: 'x402-payment-proof',
      mercContract: MERC_BASE,
      easSchema: EAS_SCHEMA_UID
    }
  }]
};

// base64-encode for the PAYMENT-REQUIRED header (v2 spec)
function getPaymentRequiredHeader(requirements) {
  return Buffer.from(JSON.stringify(requirements)).toString('base64');
}

// ─── Direct verify/settle with timeout (avoids blocking middleware init) ──────
// HTTPFacilitatorClient.verify(paymentPayload, paymentRequirements) — no signal support
// Use Promise.race for timeout instead of AbortController
function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function verifyCdpPayment(paymentHeader, paymentReqs = PAYMENT_REQUIREMENTS.accepts[0], label = 'CDP verify') {
  const paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  return withTimeout(
    facilitatorClient.verify(paymentPayload, paymentReqs),
    8000,
    label
  );
}

async function settleCdpPayment(paymentHeader, paymentReqs = PAYMENT_REQUIREMENTS.accepts[0], label = 'CDP settle') {
  const paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  return withTimeout(
    facilitatorClient.settle(paymentPayload, paymentReqs),
    8000,
    label
  );
}

function extractSettleTxHash(settleResult) {
  return settleResult?.transaction || settleResult?.txHash || settleResult?.hash || null;
}

app.use('/api/agents/full', async (req, res, next) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!paymentHeader) {
    // No payment — return fast 402 without hitting facilitator
    // Send both v1 body (for @x402/axios) and v2 header (for v2 clients)
    res.setHeader('PAYMENT-REQUIRED', getPaymentRequiredHeader(PAYMENT_REQUIREMENTS));
    return res.status(402).json(PAYMENT_REQUIREMENTS);
  }

  // Payment header present — verify directly with facilitator (with timeout)
  try {
    const verifyResult = await verifyCdpPayment(paymentHeader);
    if (!verifyResult?.isValid) {
      return res.status(402).json({
        ...PAYMENT_REQUIREMENTS,
        error: verifyResult?.invalidReason || 'payment_invalid'
      });
    }
    // Verified — attach for settle after response
    req.x402PaymentHeader = paymentHeader;
    req.x402Verified = true;
    next();
  } catch (e) {
    console.error('Payment verify error:', e.message);
    return res.status(402).json({
      ...PAYMENT_REQUIREMENTS,
      error: 'facilitator_unavailable'
    });
  }
});

// ─── Registry data ─────────────────────────────────────────────────────────────
let agentRegistry = loadRegistry();

function loadRegistry() {
  return [
    {
      address: '0xEaAE848fbD8F88874F5660E3F615a1430EEE5880',
      attestationUid: '0xa5786bfdd05554faf80d255a064565c97ef58b53963e3a9df0313be0edf6c258',
      proofTxHash: null,
      registeredAt: '2026-03-12T13:17:34.000Z',
      agentNumber: 1
    },
    {
      address: '0xEa8F59B504F18Ac7ed25C735f07864ae2EeFa493',
      attestationUid: '0x7893e2ca7727aa356d7da6c33df2cc2cec386abbf33be0b60e7d02b251a75d50',
      proofTxHash: null,
      registeredAt: '2026-03-12T13:34:00.000Z',
      agentNumber: 2
    }
  ];
}

function toAddressKey(address) {
  return String(address || '').toLowerCase();
}

function parseIsoToMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function sortAndRenumberRegistry() {
  agentRegistry.sort((a, b) => {
    const aMs = parseIsoToMs(a.registeredAt);
    const bMs = parseIsoToMs(b.registeredAt);
    if (aMs !== bMs) return aMs - bMs;
    return toAddressKey(a.address).localeCompare(toAddressKey(b.address));
  });
  for (let i = 0; i < agentRegistry.length; i += 1) {
    agentRegistry[i].agentNumber = i + 1;
  }
}

const easSchemaRegistrationCache = {
  entries: [],
  expiresAt: 0
};
const EAS_SCHEMA_CACHE_TTL_MS = 60 * 1000;
let easSchemaHydrationPromise = null;

const chainRegistrationCache = {
  entries: [],
  expiresAt: 0
};
const CHAIN_REGISTRY_CACHE_TTL_MS = 60 * 1000;
const blockTimestampCache = new Map(); // blockNumber(string) -> ISO date
let chainHydrationPromise = null;

async function fetchEasSchemaRegistrations() {
  const now = Date.now();
  if (easSchemaRegistrationCache.entries.length > 0 && now < easSchemaRegistrationCache.expiresAt) {
    return easSchemaRegistrationCache.entries;
  }

  const query = `
    query SchemaAttestations($schemaId: String!, $skip: Int!, $take: Int!) {
      attestations(
        where: { schemaId: { equals: $schemaId }, revoked: { equals: false } },
        orderBy: { time: desc },
        take: $take,
        skip: $skip
      ) {
        id
        recipient
        time
      }
    }
  `;

  const byAddress = new Map();
  for (let page = 0; page < EAS_SCHEMA_HYDRATION_MAX_PAGES; page += 1) {
    const skip = page * EAS_SCHEMA_HYDRATION_PAGE_SIZE;
    const take = EAS_SCHEMA_HYDRATION_PAGE_SIZE;
    const resp = await axios.post(
      EAS_GRAPHQL_ENDPOINT,
      {
        query,
        variables: {
          schemaId: EAS_SCHEMA_UID,
          skip,
          take
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    );

    const attestations = resp.data?.data?.attestations || [];
    for (const att of attestations) {
      const address = toAddressKey(att?.recipient);
      if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
      if (byAddress.has(address)) continue; // already have newest due desc ordering

      byAddress.set(address, {
        address,
        attestationUid: att?.id || null,
        proofTxHash: null,
        registeredAt: att?.time
          ? new Date(Number(att.time) * 1000).toISOString()
          : new Date().toISOString()
      });
    }

    if (attestations.length < EAS_SCHEMA_HYDRATION_PAGE_SIZE) break;
  }

  const entries = [...byAddress.values()];
  easSchemaRegistrationCache.entries = entries;
  easSchemaRegistrationCache.expiresAt = now + EAS_SCHEMA_CACHE_TTL_MS;
  return entries;
}

async function fetchRegistrationTransferLogsForRpc(rpcUrl, transferEvent) {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 12000 })
  });

  const latestBlock = await client.getBlockNumber();
  const chunkSize = BigInt(process.env.AGENTIC_LOG_CHUNK_SIZE || '9500');
  const logs = [];

  for (let start = AGENTIC_REGISTRY_FROM_BLOCK; start <= latestBlock; start += (chunkSize + 1n)) {
    const end = start + chunkSize > latestBlock ? latestBlock : start + chunkSize;
    const chunkLogs = await client.getLogs({
      address: USDC_BASE,
      event: transferEvent,
      args: { to: PAYMENT_RECEIVER },
      fromBlock: start,
      toBlock: end
    });
    if (chunkLogs.length > 0) logs.push(...chunkLogs);
  }

  return { client, logs };
}

async function fetchAgenticRegistrationsFromChain() {
  const now = Date.now();
  if (chainRegistrationCache.entries.length > 0 && now < chainRegistrationCache.expiresAt) {
    return chainRegistrationCache.entries;
  }

  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const registrationAmount = BigInt(AGENTIC_REGISTER_PAYMENT_REQUIREMENTS.accepts[0].amount);
  let client = null;
  let logs = null;
  let lastError = null;

  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const result = await fetchRegistrationTransferLogsForRpc(rpcUrl, transferEvent);
      client = result.client;
      logs = result.logs;
      break;
    } catch (e) {
      lastError = e;
      console.error('RPC log scan failed:', rpcUrl, e.message);
    }
  }

  if (!client || !logs) {
    throw new Error(`All Base RPC endpoints failed for registration scan: ${lastError?.message || 'unknown error'}`);
  }

  const registrationLogs = logs
    .filter(log => log.args?.value === registrationAmount)
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      return Number(a.logIndex || 0n) - Number(b.logIndex || 0n);
    });

  const uniqueBlockNumbers = [...new Set(registrationLogs.map(log => String(log.blockNumber || '0')))];
  await Promise.all(uniqueBlockNumbers.map(async (blockNumberStr) => {
    if (blockTimestampCache.has(blockNumberStr)) return;
    try {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumberStr) });
      blockTimestampCache.set(blockNumberStr, new Date(Number(block.timestamp) * 1000).toISOString());
    } catch (e) {
      console.error('Block timestamp lookup error:', blockNumberStr, e.message);
    }
  }));

  const seenAddresses = new Set();
  const entries = [];
  for (const log of registrationLogs) {
    const from = toAddressKey(log.args?.from);
    if (!/^0x[a-f0-9]{40}$/.test(from)) continue;
    if (seenAddresses.has(from)) continue;
    seenAddresses.add(from);

    const blockKey = String(log.blockNumber || '0');
    entries.push({
      address: from,
      attestationUid: null,
      proofTxHash: log.transactionHash || null,
      registeredAt: blockTimestampCache.get(blockKey) || new Date().toISOString()
    });
  }

  chainRegistrationCache.entries = entries;
  chainRegistrationCache.expiresAt = now + CHAIN_REGISTRY_CACHE_TTL_MS;
  return entries;
}

async function hydrateAgentRegistryFromChain() {
  if (chainHydrationPromise) return chainHydrationPromise;

  chainHydrationPromise = (async () => {
    try {
      const chainEntries = await fetchAgenticRegistrationsFromChain();
      let mutated = false;

      for (const entry of chainEntries) {
        const key = toAddressKey(entry.address);
        const existing = agentRegistry.find(a => toAddressKey(a.address) === key);
        if (!existing) {
          agentRegistry.push({
            address: entry.address,
            attestationUid: entry.attestationUid || null,
            proofTxHash: entry.proofTxHash || null,
            registeredAt: entry.registeredAt || new Date().toISOString(),
            agentNumber: 0
          });
          mutated = true;
          continue;
        }

        if (!existing.proofTxHash && entry.proofTxHash) {
          existing.proofTxHash = entry.proofTxHash;
          mutated = true;
        }
        if (!existing.registeredAt && entry.registeredAt) {
          existing.registeredAt = entry.registeredAt;
          mutated = true;
        }
      }

      if (mutated) sortAndRenumberRegistry();
    } catch (e) {
      console.error('Agent registry chain hydration error:', e.message);
    }
  })();

  try {
    await chainHydrationPromise;
  } finally {
    chainHydrationPromise = null;
  }
}

async function hydrateAgentRegistryFromEasSchema() {
  if (easSchemaHydrationPromise) return easSchemaHydrationPromise;

  easSchemaHydrationPromise = (async () => {
    try {
      const easEntries = await fetchEasSchemaRegistrations();
      let mutated = false;

      for (const entry of easEntries) {
        const key = toAddressKey(entry.address);
        const existing = agentRegistry.find(a => toAddressKey(a.address) === key);
        if (!existing) {
          agentRegistry.push({
            address: entry.address,
            attestationUid: entry.attestationUid || null,
            proofTxHash: null,
            registeredAt: entry.registeredAt || new Date().toISOString(),
            agentNumber: 0
          });
          mutated = true;
          continue;
        }

        const entryUid = (entry.attestationUid || '').toLowerCase();
        const existingUid = (existing.attestationUid || '').toLowerCase();
        if (entryUid && entryUid !== existingUid) {
          existing.attestationUid = entry.attestationUid;
          mutated = true;
        }
        if (!existing.registeredAt && entry.registeredAt) {
          existing.registeredAt = entry.registeredAt;
          mutated = true;
        }
      }

      if (mutated) sortAndRenumberRegistry();
    } catch (e) {
      console.error('Agent registry EAS hydration error:', e.message);
    }
  })();

  try {
    await easSchemaHydrationPromise;
  } finally {
    easSchemaHydrationPromise = null;
  }
}

async function hydrateAgentRegistry() {
  await hydrateAgentRegistryFromEasSchema();
  await hydrateAgentRegistryFromChain();
}

// Track recent EAS lookups so list endpoints don't hammer GraphQL on every request.
const attestationBackfillCache = new Map(); // address -> lastLookupMs
const ATTESTATION_BACKFILL_COOLDOWN_MS = 60 * 1000;

async function backfillAttestationUidForEntry(entry, { force = false } = {}) {
  if (!entry || entry.attestationUid) return false;

  const key = entry.address.toLowerCase();
  const now = Date.now();
  const lastLookup = attestationBackfillCache.get(key) || 0;
  if (!force && now - lastLookup < ATTESTATION_BACKFILL_COOLDOWN_MS) return false;

  attestationBackfillCache.set(key, now);
  const attestation = await lookupEasAttestation(entry.address);
  if (!attestation?.uid) return false;

  entry.attestationUid = attestation.uid;
  if (!entry.registeredAt && attestation.time) {
    entry.registeredAt = new Date(attestation.time * 1000).toISOString();
  }
  return true;
}

async function backfillMissingAttestationUids(entries, { maxLookups = 10, force = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0 || maxLookups <= 0) return 0;

  const targets = entries.filter(e => e && !e.attestationUid).slice(0, maxLookups);
  if (targets.length === 0) return 0;

  let updated = 0;
  await Promise.all(targets.map(async (entry) => {
    try {
      const didUpdate = await backfillAttestationUidForEntry(entry, { force });
      if (didUpdate) updated += 1;
    } catch (e) {
      console.error('Attestation backfill error:', entry?.address, e.message);
    }
  }));
  return updated;
}

function toAgentResponse(entry) {
  const attestationUid = entry.attestationUid || null;
  const proofTxHash = entry.proofTxHash || null;
  const credentialUid = attestationUid || proofTxHash || null;
  const credentialType = attestationUid
    ? 'eas-attestation'
    : (proofTxHash ? 'x402-settlement' : null);

  return {
    address: entry.address,
    attestationUid,
    proofTxHash,
    credentialUid,
    credentialType,
    registeredAt: entry.registeredAt,
    agentNumber: entry.agentNumber
  };
}

// ─── Nonce store (in-memory, TTL 10 min) ──────────────────────────────────────
// Maps address.toLowerCase() → { nonce, expiresAt }
const nonceStore = new Map();
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function issueNonce(address) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonceStore.set(address.toLowerCase(), { nonce, expiresAt });
  return nonce;
}

function consumeNonce(address) {
  const key = address.toLowerCase();
  const entry = nonceStore.get(key);
  if (!entry) return null;
  nonceStore.delete(key); // single-use
  if (Date.now() > entry.expiresAt) return null; // expired
  return entry.nonce;
}

// Prune expired nonces every 10 min (no accumulation in long-running envs)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonceStore) {
    if (now > v.expiresAt) nonceStore.delete(k);
  }
}, NONCE_TTL_MS);

// ─── MERC balance helper ───────────────────────────────────────────────────────
async function checkMercBalance(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return 0;
  try {
    // Use direct RPC balanceOf — avoids Blockscout indexing lag
    const data = '0x70a08231' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    for (const rpcUrl of BASE_RPC_URLS) {
      try {
        const r = await axios.post(rpcUrl, {
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: MERC_BASE, data }, 'latest']
        }, { timeout: 3000 });
        if (r.data?.result && r.data.result !== '0x') {
          return parseInt(r.data.result, 16) / 1e18;
        }
      } catch (e) { continue; }
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// ─── Route: Free preview (top 10) ─────────────────────────────────────────────
app.get('/agents', async (req, res) => {
  await hydrateAgentRegistry();

  // Keep Path B/C entries fresh: if an EAS attestation appears later, surface UID in UI.
  await backfillMissingAttestationUids(agentRegistry, { maxLookups: 10 });

  const preview = agentRegistry.slice(0, 10).map(toAgentResponse);

  res.json({
    count: preview.length,
    total: agentRegistry.length,
    freeTier: true,
    note: 'Free preview — top 10 agents. Full list at /api/agents/full (x402, $0.01 USDC on Base)',
    paidEndpoint: CANONICAL_PAID_URL,
    agents: preview
  });
});

// ─── Route: MERC holder bypass ────────────────────────────────────────────────
app.get('/agents/merc', async (req, res) => {
  await hydrateAgentRegistry();

  const walletAddress = req.query.wallet;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Pass ?wallet=0x... to verify MERC balance' });
  }
  const balance = await checkMercBalance(walletAddress);
  if (balance < MERC_FREE_THRESHOLD) {
    return res.status(403).json({
      error: `Insufficient MERC. Required: ${MERC_FREE_THRESHOLD}, found: ${balance.toFixed(2)}`,
      mercContract: MERC_BASE
    });
  }

  await backfillMissingAttestationUids(agentRegistry, { maxLookups: 25 });

  res.json({
    count: agentRegistry.length,
    total: agentRegistry.length,
    mercHolder: true,
    balance,
    agents: agentRegistry.map(toAgentResponse)
  });
});

// ─── Route: GET /agents/challenge ─────────────────────────────────────────────
// Path B: Returns a nonce for the given address to sign.
// MUST be declared before /agents/:address wildcard route.
// The agent signs the nonce with their wallet, then submits to POST /agents/register
// with { address, signature }.
app.get('/agents/challenge', async (req, res) => {
  await hydrateAgentRegistry();

  const { address } = req.query;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Pass ?address=0x...' });
  }

  // Already registered?
  const existing = agentRegistry.find(a => a.address.toLowerCase() === address.toLowerCase());
  if (existing) {
    await backfillAttestationUidForEntry(existing);
    return res.json({
      message: 'Already registered',
      agent: toAgentResponse(existing)
    });
  }

  const nonce = issueNonce(address);
  res.json({
    address,
    nonce,
    message: `MERC Agent Registry: prove ownership of ${address} — nonce: ${nonce}`,
    instructions: 'Sign the message field with your wallet (personal_sign / eth_sign), then POST /agents/register with { address, signature }',
    expiresInSeconds: NONCE_TTL_MS / 1000
  });
});

// ─── Route: Single agent lookup ───────────────────────────────────────────────
// Path C: x402 payment-proof registration for Agentic wallets that can't signMessage
app.use('/agents/register/agentic', async (req, res, next) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!paymentHeader) {
    res.setHeader('PAYMENT-REQUIRED', getPaymentRequiredHeader(AGENTIC_REGISTER_PAYMENT_REQUIREMENTS));
    return res.status(402).json(AGENTIC_REGISTER_PAYMENT_REQUIREMENTS);
  }

  try {
    const verifyResult = await verifyCdpPayment(
      paymentHeader,
      AGENTIC_REGISTER_PAYMENT_REQUIREMENTS.accepts[0],
      'CDP verify agentic registration'
    );
    if (!verifyResult?.isValid || !verifyResult?.payer) {
      return res.status(402).json({
        ...AGENTIC_REGISTER_PAYMENT_REQUIREMENTS,
        error: verifyResult?.invalidReason || 'payment_invalid'
      });
    }
    req.x402RegisterVerified = true;
    req.x402RegisterPayer = String(verifyResult.payer);
    req.x402RegisterPaymentHeader = paymentHeader;
    return next();
  } catch (e) {
    console.error('Agentic registration verify error:', e.message);
    return res.status(402).json({
      ...AGENTIC_REGISTER_PAYMENT_REQUIREMENTS,
      error: 'facilitator_unavailable'
    });
  }
});

app.all('/agents/register/agentic', async (req, res) => {
  await hydrateAgentRegistry();

  if (!req.x402RegisterVerified || !req.x402RegisterPayer) {
    return res.status(402).json({ error: 'payment_required' });
  }

  const payerAddress = req.x402RegisterPayer.toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(payerAddress)) {
    return res.status(403).json({ error: 'Verified payer is not a valid EVM address' });
  }

  const requestedAddress = (req.body?.address || req.query?.address || '').toString().trim();
  if (requestedAddress && requestedAddress.toLowerCase() !== payerAddress) {
    return res.status(403).json({
      error: 'Submitted address does not match x402 payer',
      expectedPayer: payerAddress
    });
  }

  const existing = agentRegistry.find(a => a.address.toLowerCase() === payerAddress);
  if (existing) {
    await backfillAttestationUidForEntry(existing);

    if (!existing.proofTxHash && req.x402RegisterPaymentHeader) {
      try {
        const settleResult = await settleCdpPayment(
          req.x402RegisterPaymentHeader,
          AGENTIC_REGISTER_PAYMENT_REQUIREMENTS.accepts[0],
          'CDP settle existing agentic registration'
        );
        existing.proofTxHash = extractSettleTxHash(settleResult) || null;
        chainRegistrationCache.expiresAt = 0;
      } catch (e) {
        console.error('Agentic existing-registration settle error:', e.message);
      }
    }

    return res.json({
      message: 'Already registered',
      path: 'x402-payment-proof',
      agent: toAgentResponse(existing)
    });
  }

  let settleTxHash = null;
  try {
    const settleResult = await settleCdpPayment(
      req.x402RegisterPaymentHeader,
      AGENTIC_REGISTER_PAYMENT_REQUIREMENTS.accepts[0],
      'CDP settle agentic registration'
    );
    settleTxHash = extractSettleTxHash(settleResult);
  } catch (e) {
    console.error('Agentic registration settle error:', e.message);
  }

  const attestation = await lookupEasAttestation(payerAddress);
  const entry = {
    address: payerAddress,
    attestationUid: attestation?.uid || null,
    proofTxHash: settleTxHash || null,
    registeredAt: attestation?.time
      ? new Date(attestation.time * 1000).toISOString()
      : new Date().toISOString(),
    agentNumber: agentRegistry.length + 1
  };
  agentRegistry.push(entry);
  sortAndRenumberRegistry();
  chainRegistrationCache.expiresAt = 0;

  const responseBody = {
    message: 'Registered via x402 payment proof (Path C)',
    path: 'x402-payment-proof',
    agent: toAgentResponse(entry),
    note: entry.attestationUid
      ? 'EAS attestation found and linked automatically.'
      : 'No EAS attestation linked yet. Showing x402 proof tx; EAS UID auto-links once available.'
  };

  if (settleTxHash) {
    responseBody.settleTxHash = settleTxHash;
    responseBody.settleExplorer = `https://basescan.org/tx/${settleTxHash}`;
    res.setHeader('X-Settle-Tx', settleTxHash);
  }

  return res.json(responseBody);
});

app.get('/agents/:address', async (req, res) => {
  await hydrateAgentRegistry();

  const addr = req.params.address.toLowerCase();
  const agent = agentRegistry.find(a => a.address.toLowerCase() === addr);
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });

  await backfillAttestationUidForEntry(agent);

  res.json(toAgentResponse(agent));
});

// ─── EAS attestation lookup ───────────────────────────────────────────────────
// Query the EAS GraphQL API for attestations on our schema where recipient = address
// Returns the attestation UID if found, null otherwise
async function lookupEasAttestation(address) {
  const query = `{
    attestations(
      where: {
        schemaId: { equals: "${EAS_SCHEMA_UID}" },
        recipient: { equals: "${address}", mode: insensitive },
        revoked: { equals: false }
      },
      orderBy: { time: desc },
      take: 1
    ) {
      id
      attester
      recipient
      time
      revocationTime
    }
  }`;

  try {
    const resp = await axios.post(
      'https://base.easscan.org/graphql',
      { query },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    const attestations = resp.data?.data?.attestations || [];
    if (attestations.length === 0) return null;
    return {
      uid: attestations[0].id,
      attester: attestations[0].attester,
      time: attestations[0].time
    };
  } catch(e) {
    console.error('EAS lookup error:', e.message);
    return null;
  }
}

// ─── Route: POST /agents/register ────────────────────────────────────────────
// Dual-path trustless registration:
//
// Path A (EAS): submit { address } — registry looks up EAS attestation on-chain.
//   Works for any wallet that can sign Base transactions.
//
// Path B (challenge-response): submit { address, signature } after GET /agents/challenge.
//   Works for Agentic/CDP wallets that can sign messages but can't do EAS contract calls.
//   Registry verifies ecrecover(signed_message) == address, no EAS required.
//
// Both paths produce the same registry entry. Path B entries have attestationUid = null
// until an EAS attestation is linked.
app.post('/agents/register', async (req, res) => {
  await hydrateAgentRegistry();

  const { address, signature } = req.body;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Valid address required (0x...)',
      pathA: 'POST { address } — requires EAS attestation on Base Schema #1181',
      pathB: 'GET /agents/challenge?address=0x... → sign nonce → POST { address, signature }',
      schema: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`
    });
  }

  // Check if already registered
  const existing = agentRegistry.find(a => a.address.toLowerCase() === address.toLowerCase());
  if (existing) {
    await backfillAttestationUidForEntry(existing);
    return res.json({
      message: 'Already registered',
      agent: toAgentResponse(existing)
    });
  }

  // ── Path B: signature provided — challenge-response verification ──────────
  if (signature) {
    const nonce = consumeNonce(address);
    if (!nonce) {
      return res.status(400).json({
        error: 'No valid nonce found for this address (missing or expired)',
        hint: 'Call GET /agents/challenge?address=0x... first to get a nonce, then sign and submit within 10 minutes'
      });
    }

    const expectedMessage = `MERC Agent Registry: prove ownership of ${address} — nonce: ${nonce}`;

    try {
      const isValid = await verifyMessage({
        address,
        message: expectedMessage,
        signature
      });

      if (!isValid) {
        return res.status(403).json({
          error: 'Signature verification failed — address does not match signer',
          hint: 'Sign the exact message string from GET /agents/challenge with the wallet at the submitted address'
        });
      }
    } catch(e) {
      console.error('Signature verify error:', e.message);
      return res.status(500).json({ error: 'Signature verification error', detail: e.message });
    }

    // Signature valid — register (no EAS attestation UID for Path B entries)
    const entry = {
      address,
      attestationUid: null,
      proofTxHash: null,
      registeredAt: new Date().toISOString(),
      agentNumber: agentRegistry.length + 1
    };
    agentRegistry.push(entry);
    sortAndRenumberRegistry();

    return res.json({
      message: 'Registered via signature verification (Path B)',
      path: 'challenge-response',
      agent: toAgentResponse(entry),
      note: 'No EAS attestation linked. Attest on Schema #1181 to earn on-chain credential.',
      easAttest: `https://base.easscan.org/attestation/create#schema=${EAS_SCHEMA_UID}`
    });
  }

  // ── Path A: no signature — EAS attestation lookup ─────────────────────────
  const attestation = await lookupEasAttestation(address);
  if (!attestation) {
    return res.status(403).json({
      error: 'No valid EAS attestation found for this address',
      pathA: `Attest your agent wallet on Schema #1181 on Base, then re-submit.`,
      pathB: 'Or: GET /agents/challenge?address=0x... → sign nonce → POST { address, signature } (works for Agentic/CDP wallets)',
      schema: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`,
      easAttest: `https://base.easscan.org/attestation/create#schema=${EAS_SCHEMA_UID}`
    });
  }

  // Valid attestation found — register
  const entry = {
    address,
    attestationUid: attestation.uid,
    proofTxHash: null,
    registeredAt: new Date(attestation.time * 1000).toISOString(),
    agentNumber: agentRegistry.length + 1
  };
  agentRegistry.push(entry);
  sortAndRenumberRegistry();

  res.json({
    message: 'Registered via EAS attestation (Path A)',
    path: 'eas',
    agent: toAgentResponse(entry),
    attester: attestation.attester,
    easExplorer: `https://base.easscan.org/attestation/view/${attestation.uid}`
  });
});

// ─── Route: Paid full registry (reached after payment verified in middleware) ──
app.get('/api/agents/full', async (req, res) => {
  await hydrateAgentRegistry();

  await backfillMissingAttestationUids(agentRegistry, { maxLookups: 100 });

  const agents = agentRegistry.map(toAgentResponse);

  // Settle before responding so we can include the tx hash
  let settleTxHash = null;
  if (req.x402PaymentHeader && req.x402Verified) {
    try {
      const settleResult = await settleCdpPayment(req.x402PaymentHeader);
      settleTxHash = extractSettleTxHash(settleResult);
      if (settleTxHash) {
        console.log('Settled tx:', settleTxHash);
      }
    } catch(e) {
      console.error('Settle error (non-fatal):', e.message);
    }
  }

  const responseBody = {
    count: agents.length,
    total: agents.length,
    paid: true,
    schemaUid: EAS_SCHEMA_UID,
    easExplorer: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`,
    agents
  };

  if (settleTxHash) {
    responseBody.settleTxHash = settleTxHash;
    responseBody.settleExplorer = `https://basescan.org/tx/${settleTxHash}`;
    res.setHeader('X-Settle-Tx', settleTxHash);
  }

  res.json(responseBody);
});

// ─── Schema info ──────────────────────────────────────────────────────────────
app.get('/schema', (req, res) => res.json({
  schemaUid: EAS_SCHEMA_UID,
  easExplorer: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`,
  mercFreeThreshold: MERC_FREE_THRESHOLD,
  mercContract: MERC_BASE,
  registration: {
    pathA: {
      how: 'Attest your agent wallet on EAS Schema #1181 on Base, then POST /agents/register with { "address": "0x..." }',
      easAttest: `https://base.easscan.org/attestation/create#schema=${EAS_SCHEMA_UID}`,
      works_for: 'EOAs, standard wallets'
    },
    pathB: {
      how: '1) GET /agents/challenge?address=0x...  2) Sign the returned message  3) POST /agents/register with { "address": "0x...", "signature": "0x..." }',
      works_for: 'Agentic wallets, CDP wallets, any wallet that can sign messages',
      note: 'No EAS attestation required. Signature proves ownership.'
    },
    pathC: {
      how: 'Call /agents/register/agentic with x402 payment. Registry verifies facilitator payer and registers that payer address.',
      works_for: 'Agentic wallets that can pay via x402 but cannot sign arbitrary messages',
      endpoint: '/agents/register/agentic'
    },
    endpoint: 'POST /agents/register',
    note: 'Trustless — no manual review. EAS attestation, signature, or x402 payer proof is the credential.'
  }
}));

// ─── Health / root ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  name: 'MERC Agent Registry',
  version: '0.2.0',
  schemaUid: EAS_SCHEMA_UID,
  registeredAgents: agentRegistry.length,
  mercFreeThreshold: MERC_FREE_THRESHOLD,
  routes: {
    free: '/agents (top 10 preview)',
    mercHolder: '/agents/merc?wallet=0x... (100+ MERC = full access free)',
    lookup: '/agents/:address',
    agenticRegister: '/agents/register/agentic (x402 payment-proof registration)',
    paid: '/api/agents/full (x402 official, $0.01 USDC — Bazaar discoverable)',
    schema: '/schema'
  }
}));

// ─── Admin: sweep CDP v1 MERC to CDP v2 ──────────────────────────────────────
// One-shot endpoint to unlock ~7,493 MERC locked in the Vercel-context CDP v1 wallet.
// CDP v1 wallet (0xC1ce2f...) was created in this serverless context — key is accessible
// via CDP API using the Vercel env vars. Sweeps to CDP v2 (0x4C8106...).
// Protected by SWEEP_SECRET env var — must pass ?secret=<value> to execute.
const CDP_V1_ADDRESS = '0xC1ce2f3fc018EB304Fa178BDDFFf0E5664Fa6B64';
const CDP_V2_ADDRESS = '0x4C810678945b74700981Ae6D8a20E8563a0C01DC';
const SWEEP_SECRET = process.env.SWEEP_SECRET || null;

app.post('/admin/sweep-cdp-v1', async (req, res) => {
  // Auth check
  const secret = req.query.secret || req.body?.secret;
  if (!SWEEP_SECRET || secret !== SWEEP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cdpKey = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID;
  const cdpSecret = process.env.CDP_API_KEY_SECRET || process.env.CDP_API_SECRET;

  if (!cdpKey || !cdpSecret) {
    return res.status(500).json({ error: 'CDP credentials not found in env' });
  }

  try {
    // Import CDP SDK dynamically (ESM)
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    const cdp = new CdpClient({ apiKeyId: cdpKey, apiKeySecret: cdpSecret });

    // Get the v1 wallet — CDP SDK v2 uses wallet address directly
    // Build ERC-20 transfer call: transfer(address to, uint256 amount)
    const { parseUnits, encodeFunctionData } = await import('viem');

    // First check balance
    const balanceResp = await withTimeout(
      fetch(`https://base.blockscout.com/api/v2/addresses/${CDP_V1_ADDRESS}/token-balances`).then(r => r.json()),
      5000, 'balance check'
    );
    const mercToken = balanceResp?.find?.(t => t.token?.address?.toLowerCase() === MERC_BASE.toLowerCase());
    const rawBalance = mercToken ? BigInt(mercToken.value) : 0n;

    if (rawBalance === 0n) {
      return res.json({ message: 'CDP v1 wallet has 0 MERC — nothing to sweep', balance: 0 });
    }

    const humanBalance = Number(rawBalance) / 1e18;

    // Encode ERC-20 transfer
    const transferData = encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' }],
      functionName: 'transfer',
      args: [CDP_V2_ADDRESS, rawBalance]
    });

    // Send via CDP v2 sendTransaction
    const result = await withTimeout(
      cdp.evm.sendTransaction({
        address: CDP_V1_ADDRESS,
        network: 'base',
        transaction: {
          to: MERC_BASE,
          data: transferData,
          value: 0n
        }
      }),
      8000, 'CDP sendTransaction'
    );

    const txHash = result?.transactionHash || result?.transaction || result?.hash || JSON.stringify(result);

    console.log('CDP v1 sweep tx:', txHash, 'amount:', humanBalance, 'MERC');

    return res.json({
      message: 'Sweep submitted',
      from: CDP_V1_ADDRESS,
      to: CDP_V2_ADDRESS,
      amount: humanBalance,
      txHash,
      explorer: `https://basescan.org/tx/${txHash}`
    });

  } catch(e) {
    console.error('Sweep error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MERC Agent Registry v0.2.0 running on port ${PORT}`));

module.exports = app;
