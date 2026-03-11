/**
 * MERC Agent Registry — x402 Test Payment Client
 *
 * Runs one real paid request against /api/agents/full via CDP facilitator.
 * A successful payment triggers Bazaar indexing on CDP discovery.
 *
 * Prerequisites (run once in this directory):
 *   npm install @x402/axios @x402/evm @x402/core viem axios
 *
 * Usage:
 *   PRIVATE_KEY=0x... node test-payment.js
 *
 * The wallet needs:
 *   - ~$0.02 USDC on Base (contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 *   - A tiny amount of ETH on Base for gas (~0.0001 ETH is plenty)
 *
 * SECURITY: Use a dedicated hot wallet with minimal funds. Never use your main wallet.
 */

const axios = require('axios');
const { wrapAxiosWithPayment, x402Client } = require('@x402/axios');
const { toClientEvmSigner } = require('@x402/evm');
const { registerExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

const REGISTRY_URL = 'https://merc-agent-registry-lake.vercel.app';
const PAID_ENDPOINT = `${REGISTRY_URL}/api/agents/full`;

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ Set PRIVATE_KEY=0x... environment variable');
    console.error('   Use a dedicated hot wallet with ~$0.02 USDC on Base');
    process.exit(1);
  }

  console.log('🦞 MERC Agent Registry — x402 Test Payment');
  console.log('━'.repeat(50));
  console.log('Endpoint:', PAID_ENDPOINT);
  console.log('Price:    $0.01 USDC on Base');
  console.log('Facilitator: CDP (api.cdp.coinbase.com)');
  console.log('');

  // Set up signer
  const account = privateKeyToAccount(privateKey);
  console.log('Wallet:', account.address);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);

  // Build x402Client and register ExactEvmScheme for all EVM networks (including 'base')
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  // Wrap axios with x402 payment handling
  const axiosInstance = axios.create({ timeout: 30000 });
  wrapAxiosWithPayment(axiosInstance, client);

  console.log('\nSending paid request...');

  try {
    const response = await axiosInstance.get(PAID_ENDPOINT);
    
    console.log('\n✅ Payment successful! Response:');
    console.log('━'.repeat(50));
    console.log(JSON.stringify(response.data, null, 2));
    console.log('━'.repeat(50));
    console.log('\n🎯 Bazaar indexing triggered via CDP facilitator');
    console.log('   Check discovery: https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources');
  } catch (err) {
    if (err.response) {
      console.error('\n❌ Request failed:', err.response.status);
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('\n❌ Error:', err.message);
    }
    process.exit(1);
  }
}

main();
