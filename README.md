# Car Parts & Bundle Price Optimizer

A clean, self-hosted web application and optimizer built to solve car parts shopping comparisons. When searching for multiple car parts, you can compare standalone part listings, multi-part bundle packages (e.g. Someone selling Part A + Part B + Part C together for one price), and dealer/shop baseline quotes.

The software **automatically solves for the mathematically cheapest option**, telling you whether it's best to buy a bundle, buy items individually, or stick with the shop quote, with instant one-click **Open Listing ↗** buttons.

---

## Key Features

1. **Automatic Cheapest-Option Combination Solver (Exact Set-Cover)**:
   - Evaluates all available listings across single parts, multi-part bundles, and shop quotes.
   - Automatically determines whether a bundle saves money compared to buying individual parts, with clear badges (e.g., `✓ Bundle Saves $60.08 vs. Individual`).
   - Supports **Must Buy (Force into Cart)**, **Already Purchased**, and **Excluded** listing states.

2. **Clean 3-Tab Interface**:
   - **Tab 1: Parts List**: Manage needed parts, interchange part numbers, and shop baseline quotes. One-click **Search eBay ↗** buttons generate multi-part-number searches. Supports CSV and JSON file import.
   - **Tab 2: Listings & Bundles**: Fast listing entry with eBay URL/Item ID auto-pull. Check off 1 part for individual listings, or 2+ parts for a bundle.
   - **Tab 3: Cheapest Results**: Live optimal shopping cart showing what to buy, seller, itemized price/shipping/tax breakdown, and total savings vs. shop baseline.

3. **Per-Listing & Per-Seller Combined Shipping**:
   - Set shipping per item (Free, Flat Amount, or Unknown/Inquire).
   - Configure **Per-Seller Combined Shipping Overrides** (e.g., $45 flat freight or free combined shipping for any order from Pacific Motors). The optimizer factors combined shipping into the solution.

4. **eBay Integration**:
   - **Zero-Key Best-Effort Auto-Pull**: Paste an eBay item ID (e.g. `296772916455`) or URL to automatically extract price, shipping, seller username, and title.
   - **Official eBay Browse API Ready**: Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` environment variables to query the official eBay Browse API with ZIP code contextual location.
   - **Refresh Prices**: One-click live refresh that re-checks prices and flags ended listings.

5. **Multi-Tab Excel (`.xlsx`) Export**:
   - Exports a 3-sheet workbook: **Cheapest Plan** (with live `SUM` formulas and purchase URLs), **Parts List**, and **All Listings**.

6. **Multi-Project Management (SaaS-Ready)**:
   - Run multiple car builds or repair comparisons simultaneously.
   - Header project selector for instant switching with URL query sync (`/?project=<id>`).
   - Create blank projects, duplicate existing builds, rename, and manage projects via the Project Manager.
   - Fully isolated project storage in `data/projects/<id>.json` with RESTful stateless API endpoints under `/api/projects/:id`.

7. **Data Safety & Security**:
   - Atomic disk persistence with write-ahead sync and rolling automatic backups (last 30 saves) in `data/backups/`.
   - Strict path traversal prevention on project identifiers (`/^[a-zA-Z0-9_-]{1,64}$/`).
   - Hardened with cryptographic CSP nonces, Fetch Metadata (`Sec-Fetch-*`), and locked-down same-origin requests.

---

## Quick Start

### Running Locally with Node.js
```bash
npm install
npm test
npm start
# Open http://localhost:28085 in your browser
```

### Running with Docker Compose (HEXnas / Remote Server)
```bash
docker compose up -d --build
# Open http://<server-ip>:28085
```

---

## CSV Import Format Example
Upload or paste CSV with standard headers (quoted commas in part numbers are supported):
```csv
Part Name,Part Numbers,Shop Price,Taxable,Notes
"Right rear lower control arm","20965286",887.11,Yes,"Cast aluminum"
"Right rear upper control arm","84463637, 23240821",204.93,Yes,"Upper wishbone"
"Rear toe link / adjuster link","23175952, 20965287",156.06,Yes,"Toe adjuster"
```
