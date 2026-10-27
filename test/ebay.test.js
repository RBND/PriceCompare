'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUrlOrItemId, validateUrlForSsrf, checkEbayApiCredentials } = require('../src/ebayService');

test('eBay Service: checkEbayApiCredentials reports missing credentials correctly', async () => {
  const oldId = process.env.EBAY_CLIENT_ID;
  const oldSecret = process.env.EBAY_CLIENT_SECRET;
  try {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const res = await checkEbayApiCredentials();
    assert.equal(res.configured, false);
    assert.equal(res.valid, false);
  } finally {
    if (oldId) process.env.EBAY_CLIENT_ID = oldId;
    if (oldSecret) process.env.EBAY_CLIENT_SECRET = oldSecret;
  }
});

test('eBay Service: parseUrlOrItemId parses bare item IDs, eBay URLs, and generic URLs', () => {
  // Bare 12-digit ID
  const p1 = parseUrlOrItemId('298038770877');
  assert.equal(p1.type, 'ebay');
  assert.equal(p1.ebayItemId, '298038770877');
  assert.equal(p1.url, 'https://www.ebay.com/itm/298038770877');

  // eBay full item URL
  const p2 = parseUrlOrItemId('https://www.ebay.com/itm/298038770877?hash=item45a&var=123');
  assert.equal(p2.type, 'ebay');
  assert.equal(p2.ebayItemId, '298038770877');

  // eBay slugged URL
  const p3 = parseUrlOrItemId('https://www.ebay.com/itm/C7-Corvette-Rear-Bumper/298038770877');
  assert.equal(p3.type, 'ebay');
  assert.equal(p3.ebayItemId, '298038770877');

  // Generic vendor URL
  const p4 = parseUrlOrItemId('https://pacificmotors.com/product/corvette-part');
  assert.equal(p4.type, 'generic');
  assert.equal(p4.ebayItemId, null);
});

test('eBay Service: validateUrlForSsrf blocks localhost and invalid protocols', async () => {
  // Protocol rejection
  await assert.rejects(
    async () => { await validateUrlForSsrf('file:///etc/passwd'); },
    /Only http and https/
  );

  // Localhost rejection
  await assert.rejects(
    async () => { await validateUrlForSsrf('http://localhost:8080/api'); },
    /prohibited/
  );

  await assert.rejects(
    async () => { await validateUrlForSsrf('http://127.0.0.1:8080'); },
    /prohibited/
  );
});
