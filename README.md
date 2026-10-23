# 2015 Chevrolet Corvette Stingray Z51 — Repair Quote & Used Parts PriceCompare

A fast, self-hosted web application and live Excel (`.xlsx`) workbook generator built to compare the **DND Auto Body OEM Repair Estimate (#31065854)** against used/salvage replacement parts, bundled assemblies, and same-color painted panels.

## Key Features

- **Pre-Loaded with Complete DND Auto Body Estimate (#31065854)**:
  - All 38 estimate lines for **2015 Chevrolet Corvette Stingray Z51 2LT (`1G1YJ2D72F5108806`)**
  - **Scope Toggles**: Instantly switch between:
    1. All 15 "New" replaceable items (`$6,988.48` pre-tax / `$7,451.47` w/ 6.625% NJ tax)
    2. 13 OEM Car Parts Only (excluding tires & mount/balance)
    3. All 38 Estimate Lines (including existing panel repairs, blends, overhaul, alignment)
  - Toggle Fixed Shop Labor (`$4,459.59`) & Paint Materials (`$552.32`) on or off to view either the full `$12,463.38` out-the-door comparison or a pure parts-only comparison.
- **Proportional Bundle & Assembly Cost Allocation**:
  - Group multiple parts bought together (e.g., *Right Rear Suspension Knee Assembly* — Lines 16, 17, 18, 19) under one combined price, shipping, and tax.
  - Automatically calculates each part's exact percentage weight of the grouped OEM New price ($\text{Weight}_i = \frac{\text{OEM}_i}{\sum \text{OEM}}$) and divides the used bundle price, shipping, and tax proportionally across each member part.
- **Multi-Quote Shopping Comparison**:
  - Save multiple competing quotes per part or per bundle (eBay, Car-Part.com, Corvette Forum, salvage yards) and select one as **Active** to drive live totals.
- **Same-Color Painted Panel Credit Preview**:
  - Toggle *"Same Paint Color? (Skip Repaint)"* on painted body panels (`#6 R Quarter Outer Panel` and `#25 Rear Upr Bumper Cover`) to preview Refinish Labor & Paint Material savings.
- **Order Workflow & Auto-Linked Carrier Tracking**:
  - Track status from `Need to Find` → `Watching / Quoted` → `Ordered` → `Shipped` → `Delivered` → `At Body Shop`, with one-click UPS/FedEx/USPS tracking links.
- **Multi-Tab Excel (`.xlsx`) Export with Live Formulas**:
  - Generates a 4-tab `.xlsx` workbook compatible with Excel, LibreOffice Calc, and Google Sheets containing live `SUM`, `ROUND`, and proportional `%` formulas, plus a print-ready Body Shop Handover sheet.
- **Security & Data Safety**:
  - Atomic write-ahead file persistence (`temp` write + `fsync` + atomic `rename`) + automatic rolling snapshots (`data/backups/`, last 30 saves) + instant browser `localStorage` mirror.
  - Per-request cryptographic CSP nonces, Fetch Metadata (`Sec-Fetch-*`) cross-site isolation, strict DOM creation (`textContent` / `createElement` only), and non-root Docker execution.

## Running Locally or with Docker Compose (HEXnas)

### Local Node.js
```bash
npm install
npm test
npm start
# Open http://localhost:28085
```

### Docker Compose (HEXnas)
```bash
docker compose up -d --build
# Open http://10.10.10.1:28085
```
