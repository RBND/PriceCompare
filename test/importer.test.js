'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, splitPartNumbers, importParts } = require('../src/importer');

test('Importer: splitPartNumbers handles commas, slashes, semicolons, and "or"', () => {
  const pns = splitPartNumbers('84337474, 84180246, or 23136262');
  assert.deepEqual(pns, ['84337474', '84180246', '23136262']);

  const pns2 = splitPartNumbers('23175952 / 20965287');
  assert.deepEqual(pns2, ['23175952', '20965287']);

  const pns3 = splitPartNumbers(['84463637', '23240821']);
  assert.deepEqual(pns3, ['84463637', '23240821']);
});

test('Importer: parseCsv handles RFC-4180 quotes, embedded commas, and CRLF', () => {
  const csv = 'Name,Part Numbers,Price\r\n' +
    '"Rear aluminum bumper impact bar / cross bar","84337474, 84180246, or 23136262",594.64\r\n' +
    '"Right rear upper control arm","84463637, 23240821",204.93\r\n';

  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'Rear aluminum bumper impact bar / cross bar');
  assert.equal(rows[1][1], '84337474, 84180246, or 23136262');
  assert.equal(rows[1][2], '594.64');
});

test('Importer: importParts successfully imports CSV with quoted commas', () => {
  const csv = 'Part Name,GM Part Numbers,Shop Price,Notes\n' +
    '"Rear aluminum bumper impact bar","84337474, 84180246, 23136262","$594.64","Crash bar"\n' +
    '"Rear bumper foam absorber","84186343","$273.01","Foam"\n';

  const res = importParts('csv', csv, 'replace', []);
  assert.equal(res.ok, true);
  assert.equal(res.addedCount, 2);
  assert.equal(res.parts.length, 2);
  assert.deepEqual(res.parts[0].partNumbers, ['84337474', '84180246', '23136262']);
  assert.equal(res.parts[0].shopPrice, 594.64);
  assert.equal(res.parts[1].shopPrice, 273.01);
});

test('Importer: importParts supports JSON format in append mode', () => {
  const existing = [{ id: 'old-1', name: 'Existing Part', partNumbers: ['1111'], shopPrice: 50 }];
  const json = JSON.stringify({
    parts: [
      { name: 'New Part', partNumbers: ['2222', '3333'], shopPrice: 75.50 }
    ]
  });

  const res = importParts('json', json, 'append', existing);
  assert.equal(res.ok, true);
  assert.equal(res.addedCount, 1);
  assert.equal(res.parts.length, 2);
  assert.equal(res.parts[0].name, 'Existing Part');
  assert.equal(res.parts[1].name, 'New Part');
  assert.deepEqual(res.parts[1].partNumbers, ['2222', '3333']);
});
