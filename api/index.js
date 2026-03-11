const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { paymentMiddleware, x402ResourceServer, x402HTTPResourceServer } = require('@x402/express');
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
const BASE_MAINNET = 'eip155:8453';
const CANONICAL_PAID_URL = 'https://merc-agent-registry-lake.vercel.app/api/agents/full';

// ─── x402 Resource Server with Bazaar extension ───────────────────────────────
// openx402.ai facilitator — supports eip155:8453 (Base mainnet) with v2
// CDP facilitator requires API key auth; upgrade path: set CDP_API_KEY env var
const facilitatorUrl = process.env.CDP_FACILITATOR_URL || 'https://facilitator.openx402.ai';
const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl
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
          address: '0xEaAE848fbD8F88874F5660E3F615a1430EEE5880',
          agentName: 'Botti',
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
const PAYMENT_REQUIREMENTS = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    network: BASE_MAINNET,
    maxAmountRequired: '10000', // $0.01 USDC (6 decimals)
    resource: `${CANONICAL_PAID_URL}`,
    description: 'Full MERC AI Agent Registry — all agents with live balances and EAS attestations',
    mimeType: 'application/json',
    payTo: PAYMENT_RECEIVER,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    extra: {
      name: 'MERC Agent Registry',
      version: '2',
      mercFreeAccess: `Hold ${MERC_FREE_THRESHOLD}+ MERC at /agents/merc?wallet=0x...`,
      mercContract: MERC_BASE,
      easSchema: EAS_SCHEMA_UID
    }
  }]
};

app.use('/api/agents/full', (req, res, next) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!paymentHeader) {
    // No payment — return fast 402 without hitting facilitator
    return res.status(402).json(PAYMENT_REQUIREMENTS);
  }
  // Payment header present — pass to official middleware for verification
  next();
});

// Apply official x402 payment middleware (only reached when payment header present)
const httpServer = new x402HTTPResourceServer(resourceServer, agentsFullPaymentConfig);
app.use(paymentMiddleware(agentsFullPaymentConfig, resourceServer, undefined, undefined, false));

// ─── Registry data ─────────────────────────────────────────────────────────────
let agentRegistry = loadRegistry();

function loadRegistry() {
  return [
    {
      address: '0xEaAE848fbD8F88874F5660E3F615a1430EEE5880',
      agentName: 'Botti',
      agentType: 'Orchestrator',
      modelProvider: 'Anthropic Claude',
      operatorHandle: 'Jake Giebel (@giebz)',
      githubOrTwitter: '@giebz',
      attestationUid: '0xbb72046bca7f3ff34bfdf49d12e8bcfe3e0381029a8fcdebad2b899a3fe9fa96',
      registeredAt: '2026-03-10T22:49:00.000Z',
      mercBalance: 5924,
      agentNumber: 1
    },
    {
      address: '0xEa8F59B504F18Ac7ed25C735f07864ae2EeFa493',
      agentName: 'ClawOps',
      agentType: 'Operations & Analytics',
      modelProvider: 'Anthropic Claude',
      operatorHandle: 'LMercdigital',
      githubOrTwitter: '@lmercdigital',
      attestationUid: '0xc925561d4caee32551ea47a640c3dc4e4cdcc5960bdbcbc62f285d9664f48346',
      registeredAt: '2026-03-11T00:09:00.000Z',
      mercBalance: 0,
      agentNumber: 2
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
    agentName: a.agentName,
    agentType: a.agentType,
    modelProvider: a.modelProvider,
    mercBalance: a.mercBalance || 0,
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
    agents: agentRegistry.map(a => ({ ...a }))
  });
});

// ─── Route: Single agent lookup ───────────────────────────────────────────────
app.get('/agents/:address', async (req, res) => {
  const addr = req.params.address.toLowerCase();
  const agent = agentRegistry.find(a => a.address.toLowerCase() === addr);
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });

  try {
    const r = await axios.get(`${BLOCKSCOUT_BASE}/addresses/${agent.address}/token-balances`);
    const merc = r.data?.find(t => t.token?.address?.toLowerCase() === MERC_BASE.toLowerCase());
    agent.mercBalance = merc ? parseInt(merc.value) / 1e18 : 0;
  } catch (e) {}

  res.json(agent);
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

// ─── Route: Paid full registry (runs after x402 middleware verifies payment) ──
app.get('/api/agents/full', async (req, res) => {
  const agents = await Promise.all(
    agentRegistry.map(async (a) => {
      try {
        const r = await axios.get(`${BLOCKSCOUT_BASE}/addresses/${a.address}/token-balances`, { timeout: 3000 });
        const merc = r.data?.find(t => t.token?.address?.toLowerCase() === MERC_BASE.toLowerCase());
        return { ...a, mercBalance: merc ? parseInt(merc.value) / 1e18 : a.mercBalance };
      } catch (e) {
        return { ...a };
      }
    })
  );

  res.json({
    count: agents.length,
    total: agents.length,
    paid: true,
    schemaUid: EAS_SCHEMA_UID,
    easExplorer: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`,
    agents
  });
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
