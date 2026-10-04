import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-ars-staff-'));
process.env.DATA_DIR = dataDir;
const store = await import('../src/store.js');
const { setRuntimeBindings } = await import('../src/runtime-config.js');
const { runStaff } = await import('../src/staff.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Test-only stand-in for the Workers AI binding: answers by role prompt.
const fakeAi = {
  async run(_model, { messages }) {
    const system = messages[0].content;
    if (system.startsWith('You are Sales')) return { response: '{"summary":"Wants network setup.","next_step":"Call to scope the site.","offer_services":["Test service","Fake"],"subject":"Following up","body":"Hi, when is a good time to talk? Test Business"}' };
    if (system.startsWith('You are the Reception')) return { response: '{"subject":"Your enquiry","body":"Thank you. We received your enquiry and will follow up."}' };
    return { response: '{"fit":"good","matched_services":["Not a real service","Test service"],"summary":"Needs network help.","rationale":"Customer asked for network setup.","follow_up_question":""}' };
  }
};

test('staff drafts, qualifies and requests handoff without sending or spending', async () => {
  store.initializeFileStore();
  assert.deepEqual(await runStaff('test'), { ran: false, reason: 'No AI provider is connected' });
  setRuntimeBindings({ AI: fakeAi });
  store.transact('service.created', {}, draft => { draft.services.push({ id: 's1', title: 'Test service', description: 'd', price_cents: null, currency: 'ZAR', status: 'available' }); });
  store.transact('lead.created', {}, draft => { draft.leads.push({ id: 'lead_test_1', name: 'Test Person', email: 'person@example.com', phone: '', organization: '', source: 'test', details: 'Need network setup', stage: 'enquiry' }); });

  const result = await runStaff('test');
  assert.equal(result.errors, 0);
  const s = store.snapshot();
  assert.equal(s.messageDrafts.length, 1);
  assert.equal(s.messageDrafts[0].status, 'pending_review');
  assert.equal(s.messageDrafts[0].delivery.enabled, false);
  assert.equal(s.leads[0].stage, 'marketing_review');
  assert.equal(s.tasks.length, 1);
  assert.match(s.tasks[0].description, /Matched services: Test service/);
  assert.doesNotMatch(s.tasks[0].description, /Not a real service/);
  assert.equal(s.approvals.length, 1);
  assert.equal(s.approvals[0].kind, 'sales_handoff');
  assert.equal(s.approvals[0].status, 'pending');
  assert.equal(s.decisions.length, 1);
  assert.equal(store.verifyAudit().valid, true);

  const again = await runStaff('test');
  assert.equal(again.drafts + again.tasks + again.handoffs, 0);

  // Founder approves the handoff; Sales and the rule-based departments act on real records.
  store.transact('approval.decided', {}, draft => {
    draft.leads[0].stage = 'sales_queue';
    draft.approvals[0].status = 'approved';
    draft.approvals.push({ id: 'ap_spend', created_at: new Date().toISOString(), requested_role: 'finance', kind: 'spend', summary: 'Domain renewal', rationale: 'r', lead_id: null, amount_cents: 15000, currency: 'ZAR', status: 'approved', decision: { by: 'owner', at: new Date().toISOString(), rationale: 'ok' } });
    draft.leads.push({ id: 'lead_test_2', name: 'Won Customer', email: 'w@example.com', phone: '', organization: '', source: 'test', details: '', stage: 'customer' });
    draft.incidents.push({ id: 'inc_1', opened_at: new Date().toISOString(), severity: 'P2', title: 'Site slow', description: '', status: 'open' });
    draft.tasks.push({ id: 'task_old', created_at: new Date().toISOString(), created_by: 'owner', department: 'sales', title: 'Old chase', description: '', status: 'open', due_date: '2020-01-01' });
  });
  const second = await runStaff('test');
  assert.equal(second.errors, 0);
  const t2 = store.snapshot();
  assert.equal(t2.leads.find(l => l.id === 'lead_test_1').stage, 'sales_working');
  const offer = t2.approvals.find(a => a.kind === 'customer_offer');
  assert.ok(offer && offer.status === 'pending');
  assert.doesNotMatch(offer.summary, /Fake/);
  assert.ok(t2.messageDrafts.some(d => d.requested_role === 'sales'));
  for (const dept of ['finance', 'technical', 'operations', 'administration']) assert.ok(t2.tasks.some(x => x.department === dept && x.source_ref), dept);
  const total = t2.tasks.length;
  await runStaff('test');
  assert.equal(store.snapshot().tasks.length, total);
  assert.equal(store.verifyAudit().valid, true);
});
