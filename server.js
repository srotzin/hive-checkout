import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { fetch as undiciFetch } from 'undici';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONROE = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'base';
const CHAIN_ID = 8453;
const CONVENIENCE_FEE_BPS = 500; // 5%
const HMAC_SECRET = process.env.HMAC_SECRET || crypto.randomBytes(32).toString('hex');
const SETTLEMENT_LOG = '/tmp/checkout_settlements.jsonl';

// ── helpers ──────────────────────────────────────────────────────────────────

function buildCheckoutId(items) {
  return crypto.createHmac('sha256', HMAC_SECRET)
    .update(JSON.stringify(items) + Date.now())
    .digest('hex')
    .slice(0, 32);
}

function convenienceFee(subtotal) {
  return Math.ceil(subtotal * CONVENIENCE_FEE_BPS / 10000);
}

// In-memory store (Phase 1 — ephemeral; replace with Redis/DB for prod)
const checkoutStore = new Map();

function make402Challenge(checkoutId, totalAtomic) {
  return {
    scheme: 'exact',
    network: NETWORK,
    chainId: CHAIN_ID,
    asset: 'USDC',
    contract: USDC_BASE,
    maxAmountRequired: String(totalAtomic),
    payTo: MONROE,
    resource: `/v1/checkout/${checkoutId}/execute`,
    description: `Pay multi-tool cart with 5% convenience. Cart: ${checkoutId}`,
    mimeType: 'application/json'
  };
}

function logSettlement(record) {
  try {
    fs.appendFileSync(SETTLEMENT_LOG, JSON.stringify(record) + '\n');
  } catch (_) {}
}

// ── routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hive-checkout', version: '1.0.0', ts: new Date().toISOString() });
});

// Root
app.get('/', (_req, res) => {
  res.json({
    service: 'hive-checkout',
    description: 'Multi-tool cart with 5% convenience fee. x402 Base USDC settlement to Monroe.',
    monroe: MONROE,
    convenience_fee_bps: CONVENIENCE_FEE_BPS,
    docs: 'https://github.com/srotzin/hive-checkout',
    phase: 'Phase 1 — checkout-and-fanout'
  });
});

// Agent card
app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    name: 'hive-checkout',
    version: '1.0.0',
    description: 'Hive multi-tool cart. Bundles multiple Hive tool calls into a single x402 payment. 5% convenience fee.',
    brand_color: '#C08D23',
    payment: {
      protocol: 'x402',
      network: NETWORK,
      chain_id: CHAIN_ID,
      asset: 'USDC',
      contract: USDC_BASE,
      payTo: MONROE,
      convenience_fee_bps: CONVENIENCE_FEE_BPS
    },
    mcp_endpoint: '/mcp',
    tools: ['build_checkout', 'execute_checkout', 'get_checkout_status'],
    phase: 'Phase 1 — checkout-and-fanout',
    phase2_note: 'Phase 2 will implement true atomic batch x402 with merchant-side aggregator.'
  });
});

// MCP JSON-RPC endpoint
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'build_checkout',
            description: 'Build a multi-tool cart. Returns checkout_id, subtotal, 5% convenience fee, total, and x402 payment challenge.',
            inputSchema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  description: 'Array of tool call items to bundle.',
                  items: {
                    type: 'object',
                    required: ['tool_url', 'args', 'est_amount_atomic'],
                    properties: {
                      tool_url: { type: 'string', description: 'Full URL of the Hive tool endpoint.' },
                      args: { type: 'object', description: 'Arguments to pass to the tool.' },
                      est_amount_atomic: { type: 'integer', description: 'Estimated cost in USDC atomic units (6 decimals).' }
                    }
                  }
                }
              }
            }
          },
          {
            name: 'execute_checkout',
            description: 'Execute a previously built checkout cart. Requires x402 payment in the X-PAYMENT header for the full total.',
            inputSchema: {
              type: 'object',
              required: ['checkout_id'],
              properties: {
                checkout_id: { type: 'string', description: 'The checkout_id returned by build_checkout.' },
                x_payment: { type: 'string', description: 'x402 payment proof (X-PAYMENT header value).' }
              }
            }
          },
          {
            name: 'get_checkout_status',
            description: 'Get the current status of a checkout cart by checkout_id.',
            inputSchema: {
              type: 'object',
              required: ['checkout_id'],
              properties: {
                checkout_id: { type: 'string' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (toolName === 'build_checkout') {
      try {
        const { items } = toolArgs;
        if (!Array.isArray(items) || items.length === 0) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'items array required' }) }] } });
        }
        const subtotal = items.reduce((sum, i) => sum + (parseInt(i.est_amount_atomic) || 0), 0);
        const fee = convenienceFee(subtotal);
        const total = subtotal + fee;
        const checkout_id = buildCheckoutId(items);
        const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const record = { checkout_id, items, subtotal_atomic: subtotal, convenience_fee_atomic: fee, total_atomic: total, x402_challenge: make402Challenge(checkout_id, total), expires_at, status: 'pending', created_at: new Date().toISOString() };
        checkoutStore.set(checkout_id, record);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ checkout_id, items_count: items.length, subtotal_atomic: subtotal, convenience_fee_atomic: fee, total_atomic: total, x402_challenge: record.x402_challenge, expires_at }) }] } });
      } catch (e) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
      }
    }

    if (toolName === 'execute_checkout') {
      const { checkout_id } = toolArgs;
      const cart = checkoutStore.get(checkout_id);
      if (!cart) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'checkout_id not found' }) }] } });
      // Simulate 402 gate via MCP (actual HTTP 402 is on POST /v1/checkout/:id/execute)
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ note: 'Use POST /v1/checkout/execute with X-PAYMENT header for real x402 gated execution.', checkout_id, total_atomic: cart.total_atomic, x402_challenge: cart.x402_challenge }) }] } });
    }

    if (toolName === 'get_checkout_status') {
      const { checkout_id } = toolArgs;
      const cart = checkoutStore.get(checkout_id);
      if (!cart) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }] } });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ checkout_id: cart.checkout_id, status: cart.status, items_count: cart.items.length, total_atomic: cart.total_atomic, created_at: cart.created_at, expires_at: cart.expires_at }) }] } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

// ── REST endpoints ────────────────────────────────────────────────────────────


// POST /v1/checkout/quote
// Returns a USAd or USDCx Aleo facilitator quote for a merchant checkout.
// Routes through hive-aleo-arc facilitator.
app.post('/v1/checkout/quote', async (req, res) => {
  const { asset, amount, merchant } = req.body || {};
  if (!asset || !amount) {
    return res.status(400).json({ error: 'asset and amount required' });
  }

  const supportedAleoAssets = { 'USAd': 'usad_stablecoin.aleo', 'USDCx': 'usdcx_stablecoin.aleo' };
  const programId = supportedAleoAssets[asset];

  if (!programId) {
    return res.status(400).json({
      error: `Unsupported Aleo asset: ${asset}. Accepted: ${Object.keys(supportedAleoAssets).join(', ')}`,
    });
  }

  try {
    const facilitatorUrl = 'https://hive-aleo-arc.onrender.com/v1/facilitator/quote';
    const resp = await fetch(facilitatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset, amount }),
      signal: AbortSignal.timeout(10000),
    });
    const quote = await resp.json();

    return res.json({
      program_id: programId,
      asset,
      amount: String(amount),
      merchant: merchant || null,
      facilitator: 'https://hive-aleo-arc.onrender.com/v1/facilitator',
      treasury: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcuvgyq72q6tk',
      network: 'aleo-mainnet',
      hive_fee_bps: quote.hive_fee_bps,
      hive_fee: quote.hive_fee,
      net_to_merchant: quote.net_to_merchant,
      settle_endpoint: quote.settle_endpoint,
      verify_endpoint: quote.verify_endpoint,
      custody_model: 'atomic-settle-and-forward',
      quoted_at: quote.quoted_at || new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Facilitator unavailable', detail: err.message });
  }
});

// POST /v1/checkout/build
app.post('/v1/checkout/build', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }
  for (const item of items) {
    if (!item.tool_url || item.est_amount_atomic == null) {
      return res.status(400).json({ error: 'each item needs tool_url and est_amount_atomic' });
    }
  }
  const subtotal = items.reduce((sum, i) => sum + (parseInt(i.est_amount_atomic) || 0), 0);
  const fee = convenienceFee(subtotal);
  const total = subtotal + fee;
  const checkout_id = buildCheckoutId(items);
  const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const record = {
    checkout_id, items,
    subtotal_atomic: subtotal,
    convenience_fee_atomic: fee,
    total_atomic: total,
    x402_challenge: make402Challenge(checkout_id, total),
    expires_at,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  checkoutStore.set(checkout_id, record);
  res.json({ checkout_id, items_count: items.length, subtotal_atomic: subtotal, convenience_fee_atomic: fee, total_atomic: total, x402_challenge: record.x402_challenge, expires_at });
});

// POST /v1/checkout/execute — gated by x402
app.post('/v1/checkout/execute', async (req, res) => {
  const xPayment = req.headers['x-payment'];
  const { checkout_id } = req.body || {};

  if (!checkout_id) return res.status(400).json({ error: 'checkout_id required' });
  const cart = checkoutStore.get(checkout_id);
  if (!cart) return res.status(404).json({ error: 'checkout not found' });

  if (cart.status === 'completed') {
    return res.json({ checkout_id, status: 'completed', note: 'Already executed.' });
  }

  // x402 gate
  if (!xPayment) {
    res.status(402).set({
      'X-Payment-Required': 'true',
      'Content-Type': 'application/json'
    });
    return res.json({
      x402_version: '0.2.0',
      error: 'Payment Required',
      accepts: [make402Challenge(checkout_id, cart.total_atomic)]
    });
  }

  // Payment received — log and fan out
  const settlementRecord = {
    checkout_id,
    x_payment: xPayment,
    total_atomic: cart.total_atomic,
    hive_take_atomic: cart.convenience_fee_atomic,
    ts: new Date().toISOString()
  };
  logSettlement(settlementRecord);

  // Fan out to each item (Phase 1: forward X-PAYMENT + add X-Hive-Checkout-Origin)
  const results = [];
  for (const item of cart.items) {
    try {
      const resp = await undiciFetch(item.tool_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': xPayment,
          'X-Hive-Checkout-Origin': checkout_id
        },
        body: JSON.stringify(item.args || {})
      });
      const text = await resp.text();
      results.push({
        tool_url: item.tool_url,
        status_code: resp.status,
        response_excerpt: text.slice(0, 300)
      });
    } catch (e) {
      results.push({
        tool_url: item.tool_url,
        status_code: 0,
        response_excerpt: `fanout error: ${e.message}`
      });
    }
  }

  const allOk = results.every(r => r.status_code >= 200 && r.status_code < 300);
  const anyOk = results.some(r => r.status_code >= 200 && r.status_code < 300);
  const status = allOk ? 'completed' : anyOk ? 'partial' : 'failed';

  cart.status = status;
  cart.results = results;

  res.json({
    checkout_id,
    results,
    total_paid_atomic: cart.total_atomic,
    hive_take_atomic: cart.convenience_fee_atomic,
    status
  });
});

// GET /v1/checkout/:checkout_id/status
app.get('/v1/checkout/:checkout_id/status', (req, res) => {
  const cart = checkoutStore.get(req.params.checkout_id);
  if (!cart) return res.status(404).json({ error: 'not found' });
  res.json({
    checkout_id: cart.checkout_id,
    status: cart.status,
    items_count: cart.items.length,
    subtotal_atomic: cart.subtotal_atomic,
    convenience_fee_atomic: cart.convenience_fee_atomic,
    total_atomic: cart.total_atomic,
    expires_at: cart.expires_at,
    created_at: cart.created_at
  });
});

// ── well-known / x402 ─────────────────────────────────────────────────────────

app.get('/.well-known/x402', (_req, res) => {
  res.json({
    x402Version:  2,
    cold_safe:    true,
    service:      'hive-checkout',
    version:      '1.0.0',
    brand_color:  '#C08D23',
    payTo:        '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    network:      'base',
    chain_id:     8453,
    asset:        'USDC',
    contract:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    accepted_assets: [
      {
        symbol:    'USDC',
        contract:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network:   'base',
        chain_id:  8453,
        primary:   true
      },
      {
        symbol:    'USDT',
        contract:  '0xfde4C96c8593536E31F229Ea8f37b2ADa2699bb2',
        network:   'base',
        chain_id:  8453,
        primary:   false
      },
      {
        symbol:               'USAd',
        program_id:           'usad_stablecoin.aleo',
        network:              'aleo',
        network_name:         'aleo-mainnet',
        primary:              false,
        issuer:               'Paxos Labs',
        backing:              'Paxos Trust USDG 1:1',
        privacy:              'zk-default',
        docs:                 'https://aleo.org/usad',
        facilitator:          'https://hive-aleo-arc.onrender.com/v1/facilitator',
        facilitator_treasury: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
        added:                '2026-04-29'
      },
      {
        symbol:               'USDCx',
        program_id:           'usdcx_stablecoin.aleo',
        network:              'aleo',
        network_name:         'aleo-mainnet',
        primary:              false,
        issuer:               'Circle xReserve',
        backing:              'USDC 1:1 (Ethereum reserve)',
        privacy:              'zk-default',
        docs:                 'https://aleo.org/usdcx',
        facilitator:          'https://hive-aleo-arc.onrender.com/v1/facilitator',
        facilitator_treasury: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
        added:                '2026-04-29'
      }
    ],
    facilitator: {
      url:                    'https://hive-aleo-arc.onrender.com/v1/facilitator',
      supported_schemes:      ['exact'],
      supported_networks:     ['eip155:8453', 'aleo-mainnet'],
      syncFacilitatorOnStart: false,
      cold_safe:              true,
      aleo_treasury:          'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
      usad_program_id:        'usad_stablecoin.aleo',
      usdcx_program_id:       'usdcx_stablecoin.aleo',
    },
    resources: [
      {
        path:        '/v1/checkout/execute',
        method:      'POST',
        description: 'Execute a multi-tool cart. 5% convenience fee on subtotal.',
        'x-pricing': {
          scheme: 'exact',
          asset: 'USDC',
          fee_bps: 500,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '5% of cart subtotal_atomic. payTo Monroe.',
        },
        'x-payment-info': {
          scheme: 'exact',
          asset: 'USDC',
          fee_bps: 500,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '5% of cart subtotal_atomic. payTo Monroe.',
        }
      },
      {
        path:        '/v1/checkout/build',
        method:      'POST',
        description: 'Build a cart and receive x402 challenge. No fee.',
        'x-pricing':      { scheme: 'free', note: 'Cart build is free. Payment required on execute.' },
        'x-payment-info': { scheme: 'free', note: 'Cart build is free. Payment required on execute.' }
      }
    ],
    discovery_companions: {
      agent_card: '/.well-known/agent-card.json',
      ap2:        '/.well-known/ap2.json',
      openapi:    '/.well-known/openapi.json'
    },
    disclaimers: {
      not_a_security: true,
      not_custody:    true,
      not_insurance:  true,
      signal_only:    true
    }
  });
});

// ── well-known / agent-card.json (A2A 0.1) ────────────────────────────────────

app.get('/.well-known/agent-card.json', (req, res) => {
  const pubkey = (typeof getPublicKeyB64 === 'function')
    ? getPublicKeyB64()
    : (typeof spectral !== 'undefined' ? (spectral.publicKeyB64 || null) : null);
  res.json({
    name:        'hive-checkout',
    version:     '1.0.0',
    description: 'Multi-tool cart with 5% convenience fee. x402 Base USDC settlement to Monroe.',
    brand_color: '#C08D23',
    did:         `did:web:${req.hostname}`,
    protocol:    'A2A/0.1',
    capabilities: [
      'checkout.build',
      'checkout.execute',
      'checkout.status'
    ],
    spectral: {
      public_key:    pubkey,
      signature_algo: 'ed25519',
      jwks_endpoint: '/.well-known/jwks.json'
    },
    treasury: {
      address:  '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      network:  'base',
      chain_id: 8453,
      asset:    'USDC'
    },
    payment: {
      protocol: 'x402',
      version:  '2',
      network:  'base',
      chain_id: 8453,
      asset:    'USDC',
      contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo:    '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    },
    mcp_endpoint: '/mcp',
    tools: ['build_checkout', 'execute_checkout', 'get_checkout_status']
  });
});

// ── well-known / ap2.json (AP2 0.1) ───────────────────────────────────────────

app.get('/.well-known/ap2.json', (_req, res) => {
  res.json({
    ap2_version:   '0.1',
    service:       'hive-checkout',
    accepted_tokens: [
      {
        symbol:   'USDC',
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network:  'base',
        chain_id: 8453,
        decimals: 6
      },
      {
        symbol:   'USDT',
        contract: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        network:  'base',
        chain_id: 8453,
        decimals: 6,
        role:     'alternate'
      }
    ],
    networks:           [{ name: 'base', chain_id: 8453, role: 'primary' }],
    payment_protocols:  ['x402/v2'],
    settlement: {
      finality:  'on-chain',
      network:   'base',
      chain_id:  8453,
      payTo:     '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    },
    paid_endpoints: [
      { path: '/v1/checkout/execute', method: 'POST', description: 'Execute a multi-tool cart. 5% convenience fee on subtotal.' }
    ],
    free_endpoints: [
      { path: '/v1/checkout/build', method: 'POST', description: 'Build a cart and receive x402 challenge. No fee.' }
    ],
    brand_color: '#C08D23'
  });
});

// ── well-known / openapi.json (OpenAPI 3.0.3 + x-pricing + x-payment-info) ────

app.get('/.well-known/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title:       'hive-checkout API',
      version:     '1.0.0',
      description: 'Multi-tool cart with 5% convenience fee. x402 Base USDC settlement to Monroe.',
      contact:     { name: 'The Hivery', url: 'https://thehiveryiq.com' }
    },
    servers: [{ url: 'https://hive-checkout.onrender.com', description: 'Production (Render)' }],
    paths: {
      '/v1/checkout/execute': {
        post: {
          operationId: 'v1_checkout_execute',
          summary: 'Execute a multi-tool cart. 5% convenience fee on subtotal.',
          'x-pricing': {
          scheme: 'exact',
          asset: 'USDC',
          fee_bps: 500,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '5% of cart subtotal_atomic. payTo Monroe.'
          },
          'x-payment-info': {
          scheme: 'exact',
          asset: 'USDC',
          fee_bps: 500,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '5% of cart subtotal_atomic. payTo Monroe.'
          },
          responses: {
            '200': { description: 'Success.' },
            '402': { description: 'Payment Required — x402 challenge.' },
            '400': { description: 'Validation error.' }
          }
        }
      },
      '/v1/checkout/build': {
        post: {
          operationId: 'v1_checkout_build',
          summary: 'Build a cart and receive x402 challenge. No fee.',
          responses: {
            '200': { description: 'Success.' },
            '400': { description: 'Validation error.' }
          }
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`hive-checkout listening on :${PORT}`);
});
