# PriceIt — Universal Parts & Bundle Price Optimizer

**Subdomain**: `priceit.rbnd.cc` | **Default Port**: `28085` | **Aesthetic**: Workshop Utility / High-Density Craft

PriceIt is a universal Bill of Materials (BOM) and combinatorial bundle price optimizer for multi-part projects—whether building a PC, executing automotive repairs, or sourcing hardware/electronics.

## Key Capabilities
- **Combinatorial Bundle Solver**: Solves the Minimum-Cost Integer Set Cover problem (with over-coverage allowed) in a dedicated Web Worker using Connected-Component graph decomposition + Branch-and-Bound.
- **Vendor Order Consolidation**: Factors in unit prices, discounts, per-item shipping, flat vendor shipping, free-shipping order minimums, sales tax (`bps`), `yield_qty` (multi-packs), and `max_purchasable_qty`.
- **Guest & Cloud Tiers**:
  - **Guest Mode**: 1 active project in `localStorage` (up to 10 parts) with full bundle solver access.
  - **Registered Account**: Email/Password + OAuth (Google, Microsoft, Reddit, Meta), idempotent guest project migration (`client_project_uuid` + `is_dirty`), unlimited cloud projects, custom vendor shipping profiles, CSV/Excel export (sanitized against formula injection), `@media print` PDF datasheets, and 128-bit `base64url` read-only share links.

## Quick Start

```bash
npm install
npm test
npm run build
npm start
```

## Docker Deployment (`127.0.0.1:28085`)

```bash
docker compose up -d --build
```
