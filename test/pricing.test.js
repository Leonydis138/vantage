import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const publicSite = fs.readFileSync(path.join(root, 'public/site.html'), 'utf8');
const pricingRecord = fs.readFileSync(path.join(root, 'business-scope-and-competitive-pricing.md'), 'utf8');

test('published pricing and business pricing record stay aligned', () => {
  for (const [sitePrice, recordPrice] of [
    ['R690 / hour', 'R690/hour'],
    ['R805 / hour', 'R805/hour'],
    ['R1,035', 'R1,035/hour'],
    ['R1,207.50', 'R1,207.50/hour'],
    ['R1,380–R3,450', 'R1,380–R3,450']
  ]) {
    assert.ok(publicSite.includes(sitePrice), `public rate card is missing ${sitePrice}`);
    assert.ok(pricingRecord.includes(recordPrice), `pricing record is missing ${recordPrice}`);
  }
  assert.equal(690 * 1.5, 1035);
  assert.equal(805 * 1.5, 1207.5);
  assert.doesNotMatch(publicSite, /R632\.50|R747\.50|R948\.75|R1,121\.25/);
  assert.doesNotMatch(pricingRecord, /R632\.50|R747\.50|R948\.75|R1,121\.25/);
});
