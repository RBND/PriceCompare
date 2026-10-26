'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_STATE } = require('./src/defaultData');
const { evaluateState } = require('./public/js/calc');
const { buildExcelWorkbook } = require('./src/excelExporter');

const populated = JSON.parse(JSON.stringify(DEFAULT_STATE));
const now = new Date().toISOString();

// 1. Add Proportional Bundles:
// Bundle A: Right Rear Suspension Knee Assembly (Lines 16, 17, 18, 19)
// Shop OEM Pre-Tax Sum: $204.93 + $156.06 + $211.73 + $887.11 = $1,459.83 ($1,556.54 w/ tax)
populated.bundles = [
  {
    id: 'bundle-rear-susp-knee',
    name: 'Right Rear Suspension Knee Assembly (Lines 16–19)',
    lineNumbers: [16, 17, 18, 19],
    activeOptionId: 'bnd-opt-susp-used-ebay',
    options: [
      {
        id: 'bnd-opt-susp-used-ebay',
        vendor: 'eBay / Redline Auto Parts (Complete Right Rear Knee Assembly)',
        listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=C7+Corvette+Right+Rear+Suspension+Knee+Assembly+20965286',
        price: 425.00,
        shipping: 65.00,
        taxMode: 'rate',
        manualTax: 0,
        carrier: 'UPS',
        trackingNumber: '',
        status: 'Watching / Quoted',
        notes: 'Complete Used Right Rear Knee Assembly (Upper & Lower Control Arms, Toe Link, Shock, Spindle/Hub). Proportional OEM weights: #16 (14.04%), #17 (10.69%), #18 (14.50%), #19 (60.77%).',
        createdAt: now
      },
      {
        id: 'bnd-opt-susp-new-wholesale',
        vendor: 'GM Parts Giant / Tasca Parts (All 4 Parts Brand New Wholesale)',
        listingUrl: 'https://www.gmpartsgiant.com/',
        price: 1002.00,
        shipping: 55.00,
        taxMode: 'rate',
        manualTax: 0,
        carrier: 'FedEx',
        trackingNumber: '',
        status: 'Watching / Quoted',
        notes: 'Brand New Wholesale OEM breakdown: #16 ($128) + #17 ($96) + #18 ($118) + #19 ($660) = $1,002 + $55 shipping.',
        createdAt: now
      }
    ]
  },
  {
    id: 'bundle-rear-tires-pair',
    name: 'Matching Rear Tire Pair — 285/30ZR20 Michelin ZP (Lines 36 & 37)',
    lineNumbers: [36, 37],
    activeOptionId: 'bnd-opt-tires-used-pair',
    options: [
      {
        id: 'bnd-opt-tires-used-pair',
        vendor: 'United Tires (Utires.com) / eBay — Matching Used Pair (7.5/32"+ Tread)',
        listingUrl: 'https://www.utires.com/tires/size/285-30r20/',
        price: 390.00,
        shipping: 0.00,
        taxMode: 'rate',
        manualTax: 0,
        carrier: 'FedEx',
        trackingNumber: '',
        status: 'Watching / Quoted',
        notes: 'Matching pair of 285/30ZR20 Michelin Pilot Super Sport ZP / Pilot Sport AS4 ZP Run-Flats with 7.5–8/32" tread & free FedEx shipping ($195/tire).',
        createdAt: now
      },
      {
        id: 'bnd-opt-tires-new-tirerack',
        vendor: 'Tire Rack — Brand New Michelin Pilot Sport AS4 ZP Pair',
        listingUrl: 'https://www.tirerack.com/tires/TireSearchResults.jsp?width=285%2F&ratio=30&diameter=20',
        price: 808.00,
        shipping: 0.00,
        taxMode: 'rate',
        manualTax: 0,
        carrier: 'UPS',
        trackingNumber: '',
        status: 'Watching / Quoted',
        notes: 'Brand new Michelin Pilot Sport All Season 4 ZP ($404/tire w/ free shipping; often eligible for $80 Michelin rebate).',
        createdAt: now
      }
    ]
  }
];

// 2. Add Standalone Competing Quotes for all remaining Replaceable Parts
populated.partQuotes = [
  // Line 6: R Quarter Outer Panel (84453011) - Shop OEM: $1,452.39 ($1,548.61 w/ tax)
  {
    id: 'q-line6-used-ebay',
    lineNumber: 6,
    vendor: 'eBay / Pacific Motors — Used OEM Coupe Right Quarter Panel',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=C7+Corvette+Coupe+Right+Rear+Quarter+Panel+84453011+84054834',
    price: 350.00,
    shipping: 125.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'Freight',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used factory SMC Coupe panel (interchange #84453011 / #84054834 / #23336861 / #20980043). Tip: Search your exact paint code to also save $328.30 in paint/refinish!',
    createdAt: now
  },
  {
    id: 'q-line6-new-wholesale',
    lineNumber: 6,
    vendor: 'ChevyPartsPros / GM Wholesale — Brand New OEM #84453011',
    listingUrl: 'https://www.chevypartspros.com/oem-parts/chevrolet-quarter-panel-84453011',
    price: 595.00,
    shipping: 150.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'Freight',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new unpainted GM OEM quarter panel (#84453011) at wholesale dealer pricing.',
    createdAt: now
  },

  // Line 10: R Quarter Reinforcement (20980041) - Shop OEM: $97.96 ($104.45 w/ tax)
  {
    id: 'q-line10-used',
    lineNumber: 10,
    vendor: 'eBay / Corvette Salvage — Used OEM Reinforcement #20980041',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=GM+20980041+Corvette',
    price: 38.00,
    shipping: 12.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'USPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM inner quarter panel reinforcement bracket (#20980041).',
    createdAt: now
  },
  {
    id: 'q-line10-new-wholesale',
    lineNumber: 10,
    vendor: 'GMPartsGiant / Patriot GMC — Brand New OEM #20980041',
    listingUrl: 'https://www.gmpartsgiant.com/parts/gm-reinforcement-20980041.html',
    price: 65.00,
    shipping: 14.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'FedEx',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new GM OEM reinforcement bracket (#20980041).',
    createdAt: now
  },

  // Line 11: R Drive Axle Differential Oil Cooler -M (22908627) - Shop OEM: $581.12 ($619.62 w/ tax)
  {
    id: 'q-line11-used',
    lineNumber: 11,
    vendor: 'eBay / C7 Salvage — Used OEM Z51 Differential Cooler #22908627',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=22908627+Corvette+Cooler',
    price: 175.00,
    shipping: 20.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM ACDelco/GM #22908627 differential oil cooler (verify fins and fittings are straight).',
    createdAt: now
  },
  {
    id: 'q-line11-new-wholesale',
    lineNumber: 11,
    vendor: 'GMPartsOnline / Summit Racing — Brand New OEM #22908627',
    listingUrl: 'https://www.summitracing.com/parts/ado-22908627',
    price: 358.00,
    shipping: 0.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'FedEx',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new genuine GM/ACDelco #22908627 with free shipping over $109 at Summit Racing.',
    createdAt: now
  },

  // Individual fallback quotes for Lines 16-19 (in case user switches off bundle mode)
  {
    id: 'q-line16-used',
    lineNumber: 16,
    vendor: 'eBay — Used Right Rear Upper Control Arm #84463637',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=C7+Corvette+Rear+Upper+Control+Arm+84463637+23240821',
    price: 75.00,
    shipping: 15.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Standalone used Upper Control Arm (Interchange #84463637 / #23240821 / #23120539). New wholesale is ~$125.',
    createdAt: now
  },
  {
    id: 'q-line17-used',
    lineNumber: 17,
    vendor: 'eBay — Used Right Rear Suspension Toe Link #23175952',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=23175952+20965287+Corvette+Toe+Link',
    price: 45.00,
    shipping: 10.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'USPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Standalone used Rear Toe/Adjuster Link (#23175952 / #20965287). New wholesale is ~$96.',
    createdAt: now
  },
  {
    id: 'q-line18-used',
    lineNumber: 18,
    vendor: 'eBay — Used Rear Shock Absorber #84513886 (Base/Z51 Non-Mag)',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=84513886+Corvette+Shock',
    price: 65.00,
    shipping: 15.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Standalone used shock (#84513886). Or buy Brand New OEM at Glendora Chevy / Tasca for $122.',
    createdAt: now
  },
  {
    id: 'q-line19-used',
    lineNumber: 19,
    vendor: 'eBay — Used Right Rear Lower Control Arm #20965286',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=20965286+Corvette+Lower+Control+Arm',
    price: 145.00,
    shipping: 25.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Huge savings item: Shop charges $887.11 new; clean low-mile used arms on eBay sell for $140–$175 shipped!',
    createdAt: now
  },

  // Line 20: Rear Susp Spring -M (22782496) - Shop OEM: $431.65 ($460.25 w/ tax)
  {
    id: 'q-line20-used',
    lineNumber: 20,
    vendor: 'eBay — Used C7 Rear Composite Transverse Leaf Spring #22782496',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=22782496+Corvette+Rear+Leaf+Spring',
    price: 165.00,
    shipping: 30.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used C7 manual trans composite mono-leaf spring (#22782496). Inspect fiberglass for any delamination or exhaust heat marks.',
    createdAt: now
  },
  {
    id: 'q-line20-new-wholesale',
    lineNumber: 20,
    vendor: 'OEMPartsOnline / VPartsInc — Brand New OEM #22782496',
    listingUrl: 'https://www.gmpartsgiant.com/parts/gm-spring-22782496.html',
    price: 268.00,
    shipping: 35.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'FedEx',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new genuine GM rear leaf spring (#22782496) at wholesale discount ($267.58 + shipping).',
    createdAt: now
  },

  // Line 23: R Rear Signal Lamp (23210930) - Shop OEM: $98.48 ($105.00 w/ tax)
  {
    id: 'q-line23-used',
    lineNumber: 23,
    vendor: 'eBay — Used OEM Right Rear Marker / Signal Lamp #23210930',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=23210930+Corvette',
    price: 35.00,
    shipping: 8.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'USPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM right rear fascia auxiliary signal lamp (#23210930).',
    createdAt: now
  },
  {
    id: 'q-line23-new-wholesale',
    lineNumber: 23,
    vendor: 'ChevyPartsPros / GMPartsOutlet — Brand New OEM #23210930',
    listingUrl: 'https://www.chevypartspros.com/oem-parts/chevrolet-signal-lamp-23210930',
    price: 59.00,
    shipping: 10.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'USPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new OEM signal lamp (#23210930).',
    createdAt: now
  },

  // Line 25: Rear Upr Bumper Cover (84411653) - Shop OEM: $1,049.40 ($1,118.92 w/ tax)
  {
    id: 'q-line25-used',
    lineNumber: 25,
    vendor: 'CorvetteSalvage.com / eBay — Used OEM Rear Upper Bumper Cover',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=C7+Corvette+Rear+Upper+Bumper+Cover+84411653+23397592',
    price: 425.00,
    shipping: 120.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'Freight',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM C7 Stingray Rear Upper Bumper Fascia (#84411653 / #23397592 / #23244322). Verify all upper mounting tabs are intact. If found in matching paint color, saves an extra $407.41 in paint/refinish!',
    createdAt: now
  },
  {
    id: 'q-line25-new-wholesale',
    lineNumber: 25,
    vendor: 'Country Chevrolet / GMPartsCenter — Brand New OEM #84411653',
    listingUrl: 'https://www.gmpartsgiant.com/parts/gm-fascia-84411653.html',
    price: 705.00,
    shipping: 135.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'Freight',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new unpainted GM OEM Rear Upper Bumper Cover (#84411653).',
    createdAt: now
  },

  // Line 28: Rear Bumper Energy Absorber (84186343) - Shop OEM: $273.01 ($291.10 w/ tax)
  {
    id: 'q-line28-used',
    lineNumber: 28,
    vendor: 'eBay — Used OEM Rear Bumper Energy Absorber #84186343',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=84186343+Corvette+Absorber',
    price: 85.00,
    shipping: 18.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM rear bumper energy absorber (#84186343). Verify no impact cracks.',
    createdAt: now
  },
  {
    id: 'q-line28-new-wholesale',
    lineNumber: 28,
    vendor: 'ChevyPartsPros / OEMPartsOnline — Brand New OEM #84186343',
    listingUrl: 'https://www.chevypartspros.com/oem-parts/chevrolet-energy-absorber-84186343',
    price: 182.00,
    shipping: 22.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new OEM rear bumper energy absorber (#84186343).',
    createdAt: now
  },

  // Line 29: Rear Bumper Impact Bar (Alum) (84337474) - Shop OEM: $594.64 ($634.03 w/ tax)
  {
    id: 'q-line29-used',
    lineNumber: 29,
    vendor: 'eBay / Dino\'s Corvette Salvage — Used OEM Rear Impact Bar #84337474',
    listingUrl: 'https://www.ebay.com/sch/i.html?_nkw=C7+Corvette+Rear+Impact+Bar+84337474+84180246+23136262',
    price: 210.00,
    shipping: 45.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'UPS',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Used OEM rear bumper impact bar / cross bar (Interchange #84337474 / #84180246 / #84311108 / #23136262).',
    createdAt: now
  },
  {
    id: 'q-line29-new-wholesale',
    lineNumber: 29,
    vendor: 'Tasca Parts / GMPartsOnline — Brand New OEM #84337474',
    listingUrl: 'https://www.tascaparts.com/oem-parts/gm-compartment-panel-84337474',
    price: 395.00,
    shipping: 55.00,
    taxMode: 'rate',
    manualTax: 0,
    carrier: 'FedEx',
    trackingNumber: '',
    status: 'Watching / Quoted',
    notes: 'Brand new OEM rear impact bar (#84337474) at dealer wholesale.',
    createdAt: now
  }
];

// 3. Activate Best Used Quotes & Bundles across the replaceable line items
const bundleSuspLines = new Set([16, 17, 18, 19]);
const bundleTireLines = new Set([36, 37]);

const activeStandaloneMap = {
  6: 'q-line6-used-ebay',
  10: 'q-line10-used',
  11: 'q-line11-used',
  20: 'q-line20-used',
  23: 'q-line23-used',
  25: 'q-line25-used',
  28: 'q-line28-used',
  29: 'q-line29-used'
};

populated.lineItems = populated.lineItems.map((item) => {
  if (bundleSuspLines.has(item.lineNumber)) {
    return {
      ...item,
      sourcingMode: 'bundle',
      activeBundleId: 'bundle-rear-susp-knee',
      status: 'Watching / Quoted'
    };
  }
  if (bundleTireLines.has(item.lineNumber)) {
    return {
      ...item,
      sourcingMode: 'bundle',
      activeBundleId: 'bundle-rear-tires-pair',
      status: 'Watching / Quoted'
    };
  }
  if (activeStandaloneMap[item.lineNumber]) {
    return {
      ...item,
      sourcingMode: 'standalone',
      activeQuoteId: activeStandaloneMap[item.lineNumber],
      status: 'Watching / Quoted'
    };
  }
  return item;
});

async function run() {
  const evaluated = evaluateState(populated);
  console.log('=== SUMMARY OF POPULATED MARKET QUOTES ===');
  console.log('Original Shop Estimate Grand Total:', evaluated.summary.originalEstimateGrandTotal);
  console.log('Original Shop Parts Total (w/ tax):', evaluated.summary.oemPartsTotal);
  console.log('Projected Parts Total (Used Sourced):', evaluated.summary.projectedPartsTotal);
  console.log('Savings on Parts Alone:', evaluated.summary.savingsOnSourcedParts);
  console.log('Projected Grand Total (w/ Fixed Labor & Paint):', evaluated.summary.projectedGrandTotal);
  console.log('Total Projected Savings:', evaluated.summary.totalProjectedSavings, `(${evaluated.summary.totalSavingsPct}%)`);

  // Save to local data/state.json and regenerate Excel workbook
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(populated, null, 2), 'utf8');

  const wb = await buildExcelWorkbook(populated);
  await wb.xlsx.writeFile(path.join(__dirname, 'Corvette-Z51-Repair-Comparison.xlsx'));
  console.log('Updated Corvette-Z51-Repair-Comparison.xlsx written.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
