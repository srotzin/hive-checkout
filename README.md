# hive-checkout

**Multi-tool cart with 5% convenience fee. x402 Base USDC settlement to Monroe.**

<span style="color:#C08D23">&#9632;</span> Brand: `#C08D23`

---

## Overview

`hive-checkout` bundles multiple Hive tool calls into a single x402 payment. Instead of paying each tool endpoint separately, an agent or user builds a cart, receives a single payment challenge for the total (including a 5% convenience fee), and submits one payment. `hive-checkout` then fans out the results to each constituent tool.

**Settlement rail:** Base mainnet — USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)  
**Monroe treasury:** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`  
**Convenience fee:** 5% on the subtotal of all bundled tool fees  

---

## Phase 1 / Phase 2

| Phase | Description |
|---|---|
| **Phase 1 (current)** | Checkout-and-fanout. hive-checkout collects the full x402 payment, then fans out to each tool URL with the forwarded `X-PAYMENT` header plus `X-Hive-Checkout-Origin`. Tools that don't accept forwarded payment receive the origin header as a fallback. |
| **Phase 2 (planned)** | True atomic batch x402 with merchant-side aggregator. Each tool's payment is independently verifiable; the aggregator issues a composable receipt. |

---

## Tools (MCP)

| Tool | Description |
|---|---|
| `build_checkout` | Build a multi-tool cart. Returns `checkout_id`, subtotal, 5% convenience fee, total, and x402 payment challenge. |
| `execute_checkout` | Execute a built cart. Requires x402 payment proof (real payment via `POST /v1/checkout/execute` with `X-PAYMENT`). |
| `get_checkout_status` | Get current status of a cart by `checkout_id`. |

MCP endpoint: `POST /mcp` (JSON-RPC 2.0, MCP `2024-11-05`)

---

## REST Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Health check |
| GET | `/` | none | Service info |
| GET | `/.well-known/agent.json` | none | Agent card (Monroe + convenience fee advertised) |
| POST | `/mcp` | none | MCP JSON-RPC |
| POST | `/v1/checkout/build` | none | Build a cart |
| POST | `/v1/checkout/execute` | **x402** | Execute cart; 402 fires without `X-PAYMENT` |
| GET | `/v1/checkout/:id/status` | none | Cart status |

---

## x402 Payment Challenge

When you call `POST /v1/checkout/execute` without an `X-PAYMENT` header, you receive:

```json
{
  "x402_version": "0.2.0",
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "chainId": 8453,
    "asset": "USDC",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxAmountRequired": "<total_atomic>",
    "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "resource": "/v1/checkout/<checkout_id>/execute",
    "description": "Pay multi-tool cart with 5% convenience.",
    "mimeType": "application/json"
  }]
}
```

`total_atomic` uses USDC 6-decimal representation (e.g. `1050000` = $1.05).

---

## Sample Cart Build

```bash
curl -X POST https://hive-checkout.onrender.com/v1/checkout/build \
  -H 'Content-Type: application/json' \
  -d '{
    "items": [
      {"tool_url": "https://hive-evaluator.onrender.com/v1/evaluator/run", "args": {"prompt": "score this"}, "est_amount_atomic": 500000},
      {"tool_url": "https://hive-vault.onrender.com/v1/vault/store", "args": {"key": "k", "value": "v"}, "est_amount_atomic": 100000}
    ]
  }'
```

Response:

```json
{
  "checkout_id": "a3f9...",
  "items_count": 2,
  "subtotal_atomic": 600000,
  "convenience_fee_atomic": 30000,
  "total_atomic": 630000,
  "x402_challenge": { ... },
  "expires_at": "2025-..."
}
```

---

## Settlement Log

Settlements are appended to `/tmp/checkout_settlements.jsonl` on the server. Each line contains `checkout_id`, `x_payment`, `total_atomic`, `hive_take_atomic`, and `ts`.

---

## Pairs With

- [`hive-receipt`](https://github.com/srotzin/hive-receipt) — generate a Spectral-signed universal receipt for any checkout settlement.
- [`hive-evaluator`](https://github.com/srotzin/hive-mcp-evaluator) — LLM evaluation tool, a natural cart item.

---

## Connect

**Smithery:** `https://smithery.ai/server/srotzin/hive-checkout`  
**Glama:** `https://glama.ai/mcp/servers/srotzin/hive-checkout`  
**Repo:** `https://github.com/srotzin/hive-checkout`

---

*Built on Base mainnet. Real rails only. Brand gold `#C08D23`. Hivemorph stays private.*


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
