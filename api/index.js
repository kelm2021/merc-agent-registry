const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const MERC_BASE = '0x8923947EAfaf4aD68F1f0C9eb5463eC876D79058';
const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const EAS_SCHEMA_UID = '0xd23bf1c0bc1b08d7b88f990f0e3c39721c40d897eef77355b6ac9f16cafe187d';
const EAS_GRAPHQL = 'https://base.easscan.org/graphql';
const MERC_FREE_THRESHOLD = 100; // MERC tokens to get free API access

// In-memory registry (MVP — replace with DB later)
let agentRegistry = loadRegistry();

// Seed with verified on-chain agents
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
    }
  ];
}

// GET /agents — paginated list (free tier: top 10, paid: full)
app.get('/agents', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const paid = req.headers['x-payment-verified'] === 'true'; // x402 middleware sets this
    const maxResults = paid ? Math.min(limit, 200) : 10;

    // Pull live MERC balances for registered agents
    const agents = agentRegistry.slice(0, maxResults).map(a => ({
      address: a.address,
      agentName: a.agentName,
      agentFramework: a.agentFramework,
      operator: a.operator,
      mercBalance: a.mercBalance || 0,
      attestationUid: a.attestationUid || null,
      registeredAt: a.registeredAt
    }));

    res.json({
      count: agents.length,
      total: agentRegistry.length,
      freeTier: !paid,
      agents
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /agents/:address — single lookup
app.get('/agents/:address', async (req, res) => {
  const addr = req.params.address.toLowerCase();
  const agent = agentRegistry.find(a => a.address.toLowerCase() === addr);
  
  if (!agent) return res.status(404).json({ error: 'Agent not registered' });
  
  // Fetch live MERC balance
  try {
    const r = await axios.get(`${BLOCKSCOUT_BASE}/addresses/${agent.address}/token-balances`);
    const merc = r.data?.find(t => t.token?.address?.toLowerCase() === MERC_BASE.toLowerCase());
    agent.mercBalance = merc ? parseInt(merc.value) / 1e18 : 0;
  } catch (e) {}
  
  res.json(agent);
});

// POST /agents/register — self-registration
app.post('/agents/register', async (req, res) => {
  const { address, agentName, agentFramework, operator, modelProvider, signedMessage } = req.body;
  
  if (!address || !agentName) {
    return res.status(400).json({ error: 'address and agentName required' });
  }
  
  // TODO: verify signedMessage proves wallet ownership
  // TODO: check MERC balance >= threshold
  // TODO: create EAS attestation
  
  const entry = {
    address,
    agentName,
    agentFramework: agentFramework || 'Unknown',
    operator: operator || '',
    modelProvider: modelProvider || 'Unknown',
    registeredAt: new Date().toISOString(),
    attestationUid: null,
    mercBalance: 0
  };
  
  // Deduplicate
  const existing = agentRegistry.findIndex(a => a.address.toLowerCase() === address.toLowerCase());
  if (existing >= 0) {
    agentRegistry[existing] = { ...agentRegistry[existing], ...entry };
    return res.json({ message: 'Agent updated', entry });
  }
  
  agentRegistry.push(entry);
  res.json({ message: 'Agent registered', entry });
});

// GET /agents/top-holders — ranked by MERC
app.get('/agents/top-holders', async (req, res) => {
  const sorted = [...agentRegistry].sort((a, b) => (b.mercBalance || 0) - (a.mercBalance || 0));
  res.json({ agents: sorted.slice(0, 20) });
});

// GET /schema — EAS schema info
app.get('/schema', (req, res) => res.json({
  schemaUid: EAS_SCHEMA_UID,
  easExplorer: `https://base.easscan.org/schema/view/${EAS_SCHEMA_UID}`,
  fields: ['agentName', 'agentType', 'modelProvider', 'operatorHandle', 'githubOrTwitter'],
  mercFreeThreshold: MERC_FREE_THRESHOLD,
  mercContract: MERC_BASE
}));

// Health check
app.get('/', (req, res) => res.json({ 
  status: 'ok', 
  name: 'MERC Agent Registry',
  version: '0.1.0',
  schemaUid: EAS_SCHEMA_UID,
  registeredAgents: agentRegistry.length,
  mercFreeThreshold: MERC_FREE_THRESHOLD
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MERC Agent Registry running on port ${PORT}`));

module.exports = app;
