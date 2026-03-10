/**
 * x402 Payment Middleware for MERC Agent Registry
 * 
 * Protocol flow:
 * 1. Client requests /agents (full list)
 * 2. Server returns 402 with payment requirements
 * 3. Client pays $0.01 USDC on Base, gets payment proof
 * 4. Client retries with X-PAYMENT header
 * 5. Server verifies proof → serves data
 * 
 * Free tier: top 10 agents, no payment required
 * Paid tier: full list, $0.01 USDC/request OR hold 100 MERC
 * 
 * Payment receiver: ClawOps CDP wallet
 * 0xC1ce2f3fc018EB304Fa178BDDFFf0E5664Fa6B64
 */

const axios = require('axios');

const PAYMENT_RECEIVER = '0xC1ce2f3fc018EB304Fa178BDDFFf0E5664Fa6B64';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453; // Base mainnet
const MERC_BASE = '0x8923947EAfaf4aD68F1f0C9eb5463eC876D79058';
const MERC_FREE_THRESHOLD = 100;
const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';

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

function paymentRequired(res) {
  res.status(402).json({
    x402Version: 1,
    error: 'Payment required for full agent list. Top 10 free.',
    accepts: [{
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000',
      resource: 'https://merc-agent-registry.vercel.app/agents',
      description: 'Full MERC Agent Registry — $0.01 USDC',
      mimeType: 'application/json',
      payTo: PAYMENT_RECEIVER,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra: {
        name: 'MERC Agent Registry',
        mercFreeAccess: `Hold ${MERC_FREE_THRESHOLD}+ MERC for free access`,
        mercContract: MERC_BASE
      }
    }]
  });
}

async function verifyPayment(paymentHeader) {
  if (!paymentHeader) return false;
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    if (!decoded.x402Version || !decoded.scheme || !decoded.payload) return false;
    if (decoded.scheme !== 'exact') return false;
    // MVP: structural validation only
    // TODO: verify on-chain via x402 facilitator API
    return true;
  } catch (e) {
    return false;
  }
}

async function x402Gate(req, res, next) {
  const paymentHeader = req.headers['x-payment'];
  const walletAddress = req.headers['x-wallet-address'] || req.query.wallet;
  const requestedLimit = parseInt(req.query.limit) || 10;

  // Free tier: no explicit limit param and no ?full flag
  const hasExplicitLimit = req.query.limit !== undefined;
  if (!hasExplicitLimit && !req.query.full) {
    req.x402 = { paid: false, freeTier: true };
    return next();
  }

  // MERC holder free access
  if (walletAddress) {
    const balance = await checkMercBalance(walletAddress);
    if (balance >= MERC_FREE_THRESHOLD) {
      req.x402 = { paid: true, freeTier: false, mercHolder: true, balance };
      return next();
    }
  }

  // x402 payment proof
  if (paymentHeader) {
    const valid = await verifyPayment(paymentHeader);
    if (valid) {
      req.x402 = { paid: true, freeTier: false, mercHolder: false };
      return next();
    }
  }

  return paymentRequired(res);
}

module.exports = { x402Gate, paymentRequired, checkMercBalance, PAYMENT_RECEIVER };
