const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
const EAS_SCHEMA_UID = '0xd23bf1c0bc1b08d7b88f990f0e3c39721c40d897eef77355b6ac9f16cafe187d';
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
  // NOTE: Botti entry removed — Jake has not authorized inclusion. Re-add when Jake confirms.
  // Attestation UIDs in this seed data are placeholder/fabricated — not real on-chain attestations.
  return [
    {
      address: '0xEa8F59B504F18Ac7ed25C735f07864ae2EeFa493',
      agentName: 'ClawOps',
      agentType: 'Operations & Analytics',
      modelProvider: 'Anthropic Claude',
      operatorHandle: 'LMercdigital',
      githubOrTwitter: '@lmercdigital',
      attestationUid: null, // EAS schema not yet deployed — placeholder only
      registeredAt: '2026-03-11T00:09:00.000Z',
      mercBalance: 0,
      agentNumber: 1
    }
  ];
}

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

// ─── Route: POST /agents/register ────────────────────────────────────────────
app.post('/agents/register', async (req, res) => {
  const { address, agentName, agentType, modelProvider, operatorHandle, githubOrTwitter } = req.body;
  if (!address || !agentName) {
    return res.status(400).json({ error: 'address and agentName required' });
  }
  const entry = {
    address,
    agentName,
    agentType: agentType || 'Unknown',
    modelProvider: modelProvider || 'Unknown',
    operatorHandle: operatorHandle || '',
    githubOrTwitter: githubOrTwitter || '',
    registeredAt: new Date().toISOString(),
    attestationUid: null,
    mercBalance: 0
  };
  const existing = agentRegistry.findIndex(a => a.address.toLowerCase() === address.toLowerCase());
  if (existing >= 0) {
    agentRegistry[existing] = { ...agentRegistry[existing], ...entry };
    return res.json({ message: 'Agent updated', entry });
  }
  entry.agentNumber = agentRegistry.length + 1;
  agentRegistry.push(entry);
  res.json({ message: 'Agent registered', entry });
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
      settleTxHash = settleResult?.transaction?.hash
        || settleResult?.txHash
        || settleResult?.hash
        || null;
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
  fields: ['agentName', 'agentType', 'modelProvider', 'operatorHandle', 'githubOrTwitter'],
  mercFreeThreshold: MERC_FREE_THRESHOLD,
  mercContract: MERC_BASE
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
