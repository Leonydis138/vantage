import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-ars-store-'));
process.env.DATA_DIR = dataDir;
const store = await import('../src/store.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('new workspace uses the published service scope and records profile changes in the audit chain', () => {
  store.initializeFileStore();
  const initial = store.snapshot();
  assert.match(initial.businessProfile.offering, /VoIP, networking, and IT infrastructure/);
  assert.match(initial.businessProfile.service_area, /Worldwide remote delivery/);
  assert.equal(initial.owner, null);
  assert.deepEqual(initial.services, []);

  store.transact('business.profile_updated', { fields: ['offering'] }, draft => {
    draft.businessProfile.offering = 'Updated real service scope';
  });

  const reopened = JSON.parse(fs.readFileSync(path.join(dataDir, 'vantage-ars.json'), 'utf8'));
  assert.equal(reopened.businessProfile.offering, 'Updated real service scope');
  assert.equal(store.verifyAudit().valid, true);
});
