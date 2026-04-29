# hive-checkout v1.0.0

**Hive multi-tool cart — x402 Base USDC settlement to Monroe**

---

## What This Server Does

`hive-checkout` provides a multi-tool cart primitive for the Hive ecosystem. Agents and users bundle multiple Hive tool calls into a single x402 payment, reducing payment round-trips and enabling compound workflows.

---

## Tools

| Tool | Description |
|---|---|
| `build_checkout` | Build a cart from N tool items. Returns `checkout_id`, subtotal, 5% convenience fee, total, and x402 challenge. |
| `execute_checkout` | Execute a built cart with x402 payment. Fans out to each tool URL. |
| `get_checkout_status` | Retrieve cart status by `checkout_id`. |

---

## Backend Endpoint

```
https://hive-checkout.onrender.com
```

x402 challenge pays to Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`) on Base 8453, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

---

## Pricing

- **5% convenience fee** on the subtotal of all bundled tool fees (CONVENIENCE_FEE_BPS = 500)
- No flat fee per cart; fee is proportional to value of bundled calls

---

## Council Provenance

Ad-hoc launch — commodity surface. Passes NEED + YIELD + CLEAN-MONEY gates:

- **NEED:** Every Hive customer benefits from bundled multi-tool payment.
- **YIELD:** 5% take on all cart volume; fee compounds with ecosystem growth.
- **CLEAN-MONEY:** Pure USDC on Base mainnet. No derivatives, no energy futures, no external exchange layer.

---

## Phase 1 / Phase 2

**Phase 1 (this release):** Checkout-and-fanout. hive-checkout collects full payment, fans out to tool URLs with forwarded `X-PAYMENT` + `X-Hive-Checkout-Origin`.

**Phase 2 (planned):** True atomic batch x402 with merchant-side aggregator. Each tool payment independently verifiable.

---

## Brand

Color: `#C08D23` (Pantone 1245 C — Hive gold)

---

*Real rails only. Base USDC mainnet. Hivemorph stays private.*
