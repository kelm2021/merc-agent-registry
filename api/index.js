const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
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

// base64-encode for the PAYMENT-REQUIRED header (v2 spec)
function getPaymentRequiredHeader() {
  return Buffer.from(JSON.stringify(PAYMENT_REQUIREMENTS)).toString('base64');
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

async function verifyCdpPayment(paymentHeader) {
  const paymentReqs = PAYMENT_REQUIREMENTS.accepts[0];
  const paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  return withTimeout(
    facilitatorClient.verify(paymentPayload, paymentReqs),
    8000,
    'CDP verify'
  );
}

async function settleCdpPayment(paymentHeader) {
  const paymentReqs = PAYMENT_REQUIREMENTS.accepts[0];
  const paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  return withTimeout(
    facilitatorClient.settle(paymentPayload, paymentReqs),
    8000,
    'CDP settle'
  );
}

app.use('/api/agents/full', async (req, res, next) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!paymentHeader) {
    // No payment — return fast 402 without hitting facilitator
    // Send both v1 body (for @x402/axios) and v2 header (for v2 clients)
    res.setHeader('PAYMENT-REQUIRED', getPaymentRequiredHeader());
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
      registeredAt: '2026-03-12T13:17:34.000Z',
      agentNumber: 1
    },
    {
      address: '0xEa8F59B504F18Ac7ed25C735f07864ae2EeFa493',
      attestationUid: '0x7893e2ca7727aa356d7da6c33df2cc2cec386abbf33be0b60e7d02b251a75d50',
      registeredAt: '2026-03-12T13:34:00.000Z',
      agentNumber: 2
    }
  ];
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
    const r = await axios.get(`${BLOCKSCOUT_BASE}/addresses/${address}/token-balances`, { timeout: 3000 });
    const merc = r.data?.find(t => t.token?.address?.toLowerCase() === MERC_BASE.toLowerCase());
    return merc ? parseInt(merc.value) / 1e18 : 0;
  } catch (e) {
    return 0;
  }
}

// ─── Route: Free preview (top 10) ─────────────────────────────────────────────
app.get('/agents', async (req, res) => {
  const preview = agentRegistry.slice(0, 10).map(a => ({
    address: a.address,
    address: a.address,
    attestationUid: a.attestationUid || null,
    registeredAt: a.registeredAt,
    agentNumber: a.agentNumber
  }));

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
  res.json({
    count: agentRegistry.length,
    total: agentRegistry.length,
    mercHolder: true,
    balance,
    agents: agentRegistry.map(a => ({
      address: a.address,
      attestationUid: a.attestationUid || null,
      registeredAt: a.registeredAt,
      agentNumber: a.agentNumber
    }))
  });
});

// ─── Route: Single agent lookup ───────────────────────────────────────────────
app.get('/agents/:address', async (req, res) => {
  const addr = req.params.address.toLowerCase();
  const agent = agentRegistry.find(a => a.address.toLowerCase() === addr);
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });

  res.json({
    address: agent.address,
    attestationUid: agent.attestationUid || null,
    registeredAt: agent.registeredAt,
    agentNumber: agent.agentNumber
  });
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

// ─── Route: GET /agents/challenge ─────────────────────────────────────────────
// Path B: Returns a nonce for the given address to sign.
// The agent signs the nonce with their wallet, then submits to POST /agents/register
// with { address, signature }.
app.get('/agents/challenge', (req, res) => {
  const { address } = req.query;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Pass ?address=0x...' });
  }

  // Already registered?
  const existing = agentRegistry.find(a => a.address.toLowerCase() === address.toLowerCase());
  if (existing) {
    return res.json({
      message: 'Already registered',
      agent: {
        address: existing.address,
        attestationUid: existing.attestationUid,
        registeredAt: existing.registeredAt,
        agentNumber: existing.agentNumber
      }
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
    return res.json({
      message: 'Already registered',
      agent: {
        address: existing.address,
        attestationUid: existing.attestationUid,
        registeredAt: existing.registeredAt,
        agentNumber: existing.agentNumber
      }
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
      const { verifyMessage } = await import('viem');
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
      registeredAt: new Date().toISOString(),
      agentNumber: agentRegistry.length + 1
    };
    agentRegistry.push(entry);

    return res.json({
      message: 'Registered via signature verification (Path B)',
      path: 'challenge-response',
      agent: {
        address: entry.address,
        attestationUid: entry.attestationUid,
        registeredAt: entry.registeredAt,
        agentNumber: entry.agentNumber
      },
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
    registeredAt: new Date(attestation.time * 1000).toISOString(),
    agentNumber: agentRegistry.length + 1
  };
  agentRegistry.push(entry);

  res.json({
    message: 'Registered via EAS attestation (Path A)',
    path: 'eas',
    agent: {
      address: entry.address,
      attestationUid: entry.attestationUid,
      registeredAt: entry.registeredAt,
      agentNumber: entry.agentNumber
    },
    attester: attestation.attester,
    easExplorer: `https://base.easscan.org/attestation/view/${attestation.uid}`
  });
});

// ─── Route: Paid full registry (reached after payment verified in middleware) ──
app.get('/api/agents/full', async (req, res) => {
  const agents = agentRegistry.map(a => ({
    address: a.address,
    attestationUid: a.attestationUid || null,
    registeredAt: a.registeredAt,
    agentNumber: a.agentNumber
  }));

  // Settle before responding so we can include the tx hash
  let settleTxHash = null;
  if (req.x402PaymentHeader && req.x402Verified) {
    try {
      const settleResult = await settleCdpPayment(req.x402PaymentHeader);
      // CDP settle result shape: { success, transaction: { hash, ... } }
      // CDP settle response: { success: true, transaction: "0x..." }
      settleTxHash = settleResult?.transaction || settleResult?.txHash || settleResult?.hash || null;
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
    endpoint: 'POST /agents/register',
    note: 'Trustless — no manual review. EAS attestation or signature is the credential.'
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
    paid: '/api/agents/full (x402 official, $0.01 USDC — Bazaar discoverable)',
    schema: '/schema'
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MERC Agent Registry v0.2.0 running on port ${PORT}`));

module.exports = app;
