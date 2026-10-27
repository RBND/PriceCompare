'use strict';

/**
 * Clean-Room Baseline Dataset (Schema Version 2)
 * Pre-loaded with 11 C7 Corvette Stingray Z51 replacement parts
 * and exact DND Auto Body shop quote baseline pre-tax prices.
 */

const DEFAULT_STATE = {
  version: 2,
  updatedAt: new Date().toISOString(),
  settings: {
    projectName: '2015 Corvette Z51 — Right Rear Repair',
    taxRate: 0.06625, // 6.625% NJ Sales Tax default
    zipCode: '08879',
    sellerShipping: {} // e.g. { 'pacificmotors': { mode: 'flat', amount: 45.0, taxable: true } }
  },
  parts: [
    {
      id: 'part-c7-1',
      name: 'Right rear lower control arm',
      partNumbers: ['20965286'],
      shopPrice: 887.11,
      shopTaxable: true,
      notes: 'Cast aluminum lower control arm (Line 19 in DND estimate)'
    },
    {
      id: 'part-c7-2',
      name: 'Right rear upper control arm',
      partNumbers: ['84463637', '23240821'],
      shopPrice: 204.93,
      shopTaxable: true,
      notes: 'Upper control arm wishbone (Line 16 in DND estimate)'
    },
    {
      id: 'part-c7-3',
      name: 'Rear toe link / adjuster link',
      partNumbers: ['23175952', '20965287'],
      shopPrice: 156.06,
      shopTaxable: true,
      notes: 'Toe adjuster link rod (Line 17 in DND estimate)'
    },
    {
      id: 'part-c7-4',
      name: 'Rear transverse leaf spring for manual',
      partNumbers: ['22782496'],
      shopPrice: 431.65,
      shopTaxable: true,
      notes: 'Composite rear mono-leaf spring for manual trans (Line 20 in DND estimate)'
    },
    {
      id: 'part-c7-5',
      name: 'Diff oil cooler with lines',
      partNumbers: ['22908627'],
      shopPrice: 581.12,
      shopTaxable: true,
      notes: 'Note: Shop estimate Line 11 quoted oil cooler unit ($581.12); listings may include hard lines'
    },
    {
      id: 'part-c7-6',
      name: 'Rear aluminum bumper impact bar / cross bar',
      partNumbers: ['84337474', '84180246', '23136262'],
      shopPrice: 594.64,
      shopTaxable: true,
      notes: 'Aluminum rear crash cross bar (Line 29 in DND estimate)'
    },
    {
      id: 'part-c7-7',
      name: 'Rear bumper foam absorber',
      partNumbers: ['84186343'],
      shopPrice: 273.01,
      shopTaxable: true,
      notes: 'Energy absorber foam block (Line 28 in DND estimate)'
    },
    {
      id: 'part-c7-8',
      name: 'Right rear side marker lamp',
      partNumbers: ['23210930'],
      shopPrice: 98.48,
      shopTaxable: true,
      notes: 'Rear fascia marker / signal lamp (Line 23 in DND estimate)'
    },
    {
      id: 'part-c7-9',
      name: 'Right rear quarter reinforcement bracket',
      partNumbers: ['20980041'],
      shopPrice: 97.96,
      shopTaxable: true,
      notes: 'Inner quarter panel reinforcement bracket (Line 10 in DND estimate)'
    },
    {
      id: 'part-c7-10',
      name: 'Right rear outer quarter panel (coupe)',
      partNumbers: ['84453011', '84054834', '23336861'],
      shopPrice: 1452.39,
      shopTaxable: true,
      notes: 'SMC coupe outer quarter panel (Line 6 in DND estimate)'
    },
    {
      id: 'part-c7-11',
      name: 'Rear upper bumper cover / fascia',
      partNumbers: ['84411653', '84139446', '23294374'],
      shopPrice: 1049.40,
      shopTaxable: true,
      notes: 'Rear upper bumper fascia (Line 25 in DND estimate)'
    }
  ],
  listings: []
};

function createBlankState(projectName = 'New Project') {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    settings: {
      projectName: String(projectName || 'New Project').trim(),
      taxRate: 0.06625,
      zipCode: '08879',
      sellerShipping: {}
    },
    parts: [],
    listings: []
  };
}

module.exports = { DEFAULT_STATE, createBlankState };
