import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { setting } from './runtime-config.js';
import { snapshot, transact, auditEntries, verifyAudit, restoreWorkspaceBackup, id } from './store.js';
import { constitution, evaluate, execute } from './engine.js';
import { roles, leadStages, taskStatuses, approvalKinds, agentCanRequest } from './roles.js';
import {
  hashPassword, verifyPassword, issueSession, sessionFor, requireCsrf,
  setSessionCookie, clearSessionCookie, destroySession, saveOwner,
  ownerSummary, checkAgentKey, mintAgentKey, revokeAgentKey
} from './security.js';

const publicDir = path.resolve('public');
const maxBodyBytes = 64 * 1024;
const loginAttempts = new Map();
const publicLeadAttempts = new Map();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req, bodyLimit = maxBodyBytes) {
  const pieces = [];
  let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > bodyLimit) {
      const limitLabel = bodyLimit < 1024 * 1024 ? `${Math.floor(bodyLimit / 1024)} KB` : `${Math.floor(bodyLimit / (1024 * 1024))} MB`;
      throw new HttpError(413, `Request body exceeds ${limitLabel}`);
    }
    pieces.push(piece);
  }
  if (!pieces.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value;
  } catch { throw new HttpError(400, 'Request body must be a JSON object'); }
}
async function readFormBody(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Enquiry form must use URL-encoded form data');
  const pieces = [];
  let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Enquiry form exceeds 64 KB');
    pieces.push(piece);
  }
  const params = new URLSearchParams(Buffer.concat(pieces).toString('utf8'));
  const value = {};
  for (const [key, entry] of params) {
    if (Object.hasOwn(value, key)) throw new HttpError(400, 'Duplicate form field');
    value[key] = entry;
  }
  return value;
}
const text = (value, label, min = 1, max = 1000) => {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is required`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new HttpError(400, `${label} must be between ${min} and ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new HttpError(400, `${label} contains unsupported control characters`);
  return result;
};
const emailAddress = value => {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
};
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function clientAddress(req) {
  if (setting('TRUST_PROXY') === 'true') {
    const cloudflareIp = typeof req.headers['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'].trim() : '';
    if (net.isIP(cloudflareIp)) return cloudflareIp;
  }
  return req.socket.remoteAddress || 'unknown';
}
function requireOwner(req, mutation = false, allowAuditFailure = false) {
  const session = sessionFor(req);
  if (!session) throw new HttpError(401, 'Sign in to access this workspace');
  if (mutation && (!sameOrigin(req) || !requireCsrf(req))) throw new HttpError(403, 'The session check failed. Refresh the page and try again.');
  if (mutation && !allowAuditFailure && !verifyAudit().valid) throw new HttpError(503, 'Workspace changes are paused because the audit chain failed verification');
  return session.owner;
}
function requireAgent(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const identity = match ? checkAgentKey(match[1]) : null;
  if (!identity) throw new HttpError(401, 'A valid role credential is required');
  return identity;
}
function secureHeaders(res, pathname = '') {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  const dashboardPolicy = "default-src 'self'; script-src 'self' 'sha256-HlsC6U586bjxDsHd6uGG1h2ZLTlx6gqtf9yhGYVrRdc='; style-src 'self' 'sha256-0/CWAZ1ia+1j6CYGRI7mhDcv4FtFXRQnuQPb88LNPsM='; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  const defaultPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  res.setHeader('content-security-policy', pathname === '/autonomous-office.html' ? dashboardPolicy : defaultPolicy);
  if (setting('NODE_ENV') === 'production') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}
function makeLead(input, actor) {
  const name = text(input.name, 'Contact name', 2, 160);
  const email = input.email ? emailAddress(input.email) : null;
  const phone = input.phone ? text(input.phone, 'Phone', 3, 40) : null;
  if (input.email && !email) throw new HttpError(400, 'Enter a valid email address');
  if (phone && !/^[+()0-9 .-]+$/.test(phone)) throw new HttpError(400, 'Phone may contain only digits, spaces, +, -, parentheses, and periods');
  if (phone && phone.replace(/\D/g, '').length < 5) throw new HttpError(400, 'Phone must contain at least five digits');
  if (!email && !phone) throw new HttpError(400, 'Add an email address or phone number');
  const organization = input.organization ? text(input.organization, 'Organization', 1, 160) : '';
  const source = input.source ? text(input.source, 'Source', 1, 120) : '';
  const detailsInput = input.details || input.message || '';
  const details = detailsInput ? text(detailsInput, 'Enquiry details', 1, 3000) : '';
  const phoneDigits = phone?.replace(/\D/g, '');
  const duplicate = snapshot().leads.find(lead => (email && lead.email === email) || (phoneDigits && lead.phone?.replace(/\D/g, '') === phoneDigits));
  if (duplicate) throw new HttpError(409, `A lead with these contact details already exists (${duplicate.id})`);
  return { id: id('lead'), created_at: new Date().toISOString(), created_by: actor, name, email, phone, organization, source, details, stage: 'enquiry' };
}
function publicLeadAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const isWebsite = ['vantage-ars.co.za', 'www.vantage-ars.co.za'].includes(parsed.hostname) && parsed.protocol === 'https:';
      if (!isWebsite && !sameOrigin(req)) return false;
    } catch { return false; }
  }
  const ip = clientAddress(req);
  const now = Date.now();
  for (const [key, value] of publicLeadAttempts) if (value.until <= now) publicLeadAttempts.delete(key);
  if (publicLeadAttempts.size > 10000 && !publicLeadAttempts.has(ip)) return false;
  const current = publicLeadAttempts.get(ip) || { count: 0, until: now + 60 * 60 * 1000 };
  if (current.until <= now) { current.count = 0; current.until = now + 60 * 60 * 1000; }
  if (current.count >= 5) return false;
  current.count++;
  publicLeadAttempts.set(ip, current);
  return true;
}
function publicLeadResponse(res, status, title, message) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · VANTAGE ARS</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:1rem"><h1>${title}</h1><p>${message}</p><p><a href="https://vantage-ars.co.za/">Return to VANTAGE ARS</a></p></body></html>`);
}
async function publicLeadRoute(req, res) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!publicLeadAllowed(req)) return publicLeadResponse(res, 429, 'Please try again later', 'The enquiry could not be accepted right now. Please try again later.');
  const input = await readFormBody(req);
  if (typeof input.website === 'string' && input.website.trim()) return publicLeadResponse(res, 200, 'Thank you', 'Your enquiry has been received.');
  if (!input.message) throw new HttpError(400, 'Tell us briefly what you need help with');
  if (!verifyAudit().valid) throw new HttpError(503, 'The enquiry system is temporarily unavailable');
  const suppliedEmail = emailAddress(input.email);
  if (suppliedEmail && snapshot().leads.some(item => item.email === suppliedEmail)) return publicLeadResponse(res, 200, 'Thank you', 'Your enquiry has been received.');
  const lead = makeLead({ ...input, source: 'website' }, 'website');
  recordLead(lead);
  return publicLeadResponse(res, 201, 'Thank you', 'Your enquiry has been received. The VANTAGE ARS team will review it.');
}
function makeTask(input, actor, forcedDepartment) {
  const department = forcedDepartment || input.department;
  if (!roles[department]) throw new HttpError(400, 'Choose a valid department');
  let dueDate = null;
  if (input.due_date) {
    if (typeof input.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.due_date)) throw new HttpError(400, 'Due date must be a valid calendar date');
    const parsedDate = new Date(`${input.due_date}T00:00:00Z`);
    if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== input.due_date) throw new HttpError(400, 'Due date must be a valid calendar date');
    dueDate = input.due_date;
  }
  return {
    id: id('task'), created_at: new Date().toISOString(), created_by: actor,
    department, title: text(input.title, 'Task title', 3, 160),
    description: input.description ? text(input.description, 'Task details', 1, 2000) : '',
    status: 'open', due_date: dueDate
  };
}
function makeService(input, existing = null) {
  const title = text(input.title, 'Service name', 3, 160);
  const description = input.description ? text(input.description, 'Service details', 1, 2000) : '';
  let priceCents = existing?.price_cents ?? null;
  if (Object.hasOwn(input, 'price_cents')) {
    if (input.price_cents === '' || input.price_cents === null) priceCents = null;
    else if (!Number.isSafeInteger(input.price_cents) || input.price_cents < 0) throw new HttpError(400, 'Price must be a non-negative whole amount in ZAR cents');
    else priceCents = input.price_cents;
  }
  const status = input.status || existing?.status || 'draft';
  if (!['draft', 'available', 'paused'].includes(status)) throw new HttpError(400, 'Choose draft, available, or paused');
  return { title, description, price_cents: priceCents, currency: 'ZAR', status };
}
function makeMessageDraft(input, actor, role) {
  const leadId = text(input.lead_id, 'Enquiry', 5, 100);
  const lead = snapshot().leads.find(item => item.id === leadId);
  if (!lead) throw new HttpError(404, 'Enquiry not found');
  const allowedStages = role === 'owner' ? leadStages : role === 'reception' ? ['enquiry'] : role === 'marketing' ? ['enquiry', 'marketing_review'] : ['sales_queue', 'sales_working'];
  if (!allowedStages.includes(lead.stage)) throw new HttpError(403, 'This role cannot prepare a message for this enquiry');
  const channel = input.channel;
  if (!['email', 'sms', 'whatsapp', 'manual'].includes(channel)) throw new HttpError(400, 'Choose email, SMS, WhatsApp, or manual');
  if (channel === 'email' && !lead.email) throw new HttpError(409, 'This enquiry has no email address');
  if (['sms', 'whatsapp'].includes(channel) && !lead.phone) throw new HttpError(409, 'This enquiry has no phone number');
  return {
    id: id('draft'), created_at: new Date().toISOString(), created_by: actor, requested_role: role,
    lead_id: leadId, channel, subject: input.subject ? text(input.subject, 'Subject', 1, 200) : '',
    body: text(input.body, 'Message draft', 1, 5000), status: 'pending_review',
    review: null, delivery: { enabled: false, sent_at: null }
  };
}
function makeBusinessProfile(input) {
  const current = snapshot().businessProfile;
  const value = { ...current };
  if (Object.hasOwn(input, 'name')) value.name = text(input.name, 'Business name', 2, 160);
  if (Object.hasOwn(input, 'domain')) {
    const domain = text(input.domain, 'Domain', 1, 253).toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new HttpError(400, 'Enter a valid domain name without a URL path');
    value.domain = domain;
  }
  for (const [key, label, max] of [['offering', 'What the business sells', 2000], ['target_customers', 'Target customers', 1000], ['service_area', 'Service area', 500]]) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== 'string' || input[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input[key])) throw new HttpError(400, `${label} must be at most ${max} characters and contain no control characters`);
    value[key] = input[key].trim();
  }
  value.currency = 'ZAR';
  value.updated_at = new Date().toISOString();
  return value;
}
function makeApproval(input, actor, role) {
  if (!Object.hasOwn(approvalKinds, input.kind) || (role !== 'owner' && !agentCanRequest(role, input.kind))) throw new HttpError(403, 'This role cannot request that approval');
  const summary = text(input.summary, 'Request summary', 5, 240);
  const rationale = text(input.rationale, 'Reason', 5, 2000);
  let leadId = null;
  if (['sales_handoff', 'customer_offer', 'customer_commitment', 'customer_outcome', 'customer_risk'].includes(input.kind)) {
    leadId = text(input.lead_id, 'Lead', 5, 100);
    const lead = snapshot().leads.find(item => item.id === leadId);
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (input.kind === 'sales_handoff' && lead.stage !== 'marketing_review') throw new HttpError(409, 'Move this enquiry into marketing review before requesting a sales handoff');
    if (['customer_offer', 'customer_commitment', 'customer_outcome'].includes(input.kind) && lead.stage !== 'sales_working') throw new HttpError(409, 'Sales can request this approval only for a lead in the sales queue');
    if (input.kind === 'customer_risk' && lead.stage !== 'customer') throw new HttpError(409, 'At-risk customer actions require an existing customer record');
    const duplicate = snapshot().approvals.some(item => item.status === 'pending' && item.kind === input.kind && item.lead_id === leadId);
    if (duplicate) throw new HttpError(409, 'There is already a pending request of this type for this lead');
  }
  let amountCents = null;
  if (input.kind === 'spend') {
    if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents < 1) throw new HttpError(400, 'A positive proposed amount in ZAR cents is required');
    amountCents = input.amount_cents;
  }
  let proposedOutcome = null;
  if (input.kind === 'customer_outcome') {
    if (!['customer', 'closed_lost'].includes(input.proposed_outcome)) throw new HttpError(400, 'Choose customer or closed_lost as the proposed outcome');
    proposedOutcome = input.proposed_outcome;
  }
  return {
    id: id('approval'), created_at: new Date().toISOString(), requested_by: actor,
    requested_role: role, kind: input.kind, summary, rationale, lead_id: leadId,
    amount_cents: amountCents, currency: amountCents === null ? null : 'ZAR',
    proposed_outcome: proposedOutcome, status: 'pending', decision: null
  };
}
const aiStaffRoles = new Set(Object.keys(roles));
function lastStaffRun() {
  const entry = auditEntries(500).find(item => item.type === 'staff.run_completed');
  return entry ? { at: entry.timestamp ?? entry.created_at ?? null, ...entry.payload } : null;
}
function overview() {
  const s = snapshot();
  const integrity = verifyAudit();
  const pending = s.approvals.filter(item => item.status === 'pending').length;
  const openTasks = s.tasks.filter(item => item.status !== 'done').length;
  const openIncidents = s.incidents.filter(item => !item.resolved_at).length;
  return {
    service: { name: 'Vantage-ARS Office', version: '2.0.0', status: !integrity.valid ? 'audit error' : openIncidents ? 'incident review' : 'ready', region: 'ZA' },
    owner: ownerSummary(),
    metrics: {
      enquiries: s.leads.filter(item => !['customer', 'closed_lost'].includes(item.stage)).length,
      sales_queue: s.leads.filter(item => ['sales_queue', 'sales_working'].includes(item.stage)).length,
      customers: s.leads.filter(item => item.stage === 'customer').length,
      pending_approvals: pending,
      open_tasks: openTasks,
      audit_entries: s.audit.length,
      audit_integrity: integrity.valid,
      open_incidents: openIncidents
    },
    integrations: { ai_provider: Boolean(setting('AI') && staffRunner), email: false, calendar: false, payments: false, accounting: false, message_delivery: false, website_lead_intake: false },
    runtime: { configured: Boolean(setting('AI') && staffRunner), worker_state: setting('AI') && staffRunner ? 'All seven departments active (Reception, Marketing and Sales on Cloudflare Workers AI)' : 'unavailable', external_actions_enabled: false, last_staff_run: lastStaffRun() },
    catalog: { total: s.services.length, available: s.services.filter(item => item.status === 'available').length },
    message_drafts: { pending_review: s.messageDrafts.filter(item => item.status === 'pending_review').length },
    recent_approvals: s.approvals.slice(0, 8),
    recent_tasks: s.tasks.slice(0, 8),
    recent_leads: s.leads.slice(0, 8)
  };
}
function sessionEndpoint(req, res) {
  const session = sessionFor(req);
  return json(res, 200, {
    configured: Boolean(ownerSummary()), authenticated: Boolean(session),
    setup_token_required: setting('NODE_ENV') === 'production',
    setup_ready: setting('NODE_ENV') !== 'production' || Boolean(setting('OWNER_SETUP_TOKEN')),
    owner: session?.owner || null, csrf: session?.csrf || null
  });
}
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function recordLead(lead) {
  return transact('lead.created', { lead_id: lead.id, source: lead.source || null, stage: lead.stage }, draft => {
    draft.leads.unshift(lead);
    return lead;
  });
}
function recordTask(task) {
  return transact('task.created', { task_id: task.id, department: task.department }, draft => {
    draft.tasks.unshift(task);
    return task;
  });
}
async function ownerRoute(req, res, url) {
  const restoreRoute = req.method === 'POST' && url.pathname === '/api/backup/restore';
  requireOwner(req, req.method !== 'GET', restoreRoute);
  if (req.method === 'GET' && url.pathname === '/api/overview') return json(res, 200, overview());
  if (req.method === 'POST' && url.pathname === '/api/staff/run') {
    if (!staffRunner || !setting('AI')) throw new HttpError(409, 'No AI provider is connected to this deployment');
    return json(res, 200, await staffRunner('owner'));
  }
  if (req.method === 'GET' && url.pathname === '/api/roles') return json(res, 200, Object.entries(roles).map(([id, role]) => ({ id, ...role, credential_active: snapshot().agentKeys.some(key => key.role === id && !key.revoked_at), worker_state: aiStaffRoles.has(id) && setting('AI') && staffRunner ? 'active' : 'unavailable' })));
  if (req.method === 'GET' && url.pathname === '/api/agents') return json(res, 200, Object.entries(roles).map(([id, role]) => ({ id, role: role.name, department: role.department, credential_active: snapshot().agentKeys.some(key => key.role === id && !key.revoked_at), state: aiStaffRoles.has(id) && setting('AI') && staffRunner ? (['reception', 'marketing', 'sales'].includes(id) ? 'AI worker active' : 'Rule-based worker active') : 'no worker connected', authority: role.permissions, boundaries: role.boundaries })));
  if (req.method === 'GET' && url.pathname === '/api/leads') return json(res, 200, snapshot().leads);
  if (req.method === 'GET' && url.pathname === '/api/business-profile') return json(res, 200, snapshot().businessProfile);
  if (req.method === 'GET' && url.pathname === '/api/services') return json(res, 200, snapshot().services);
  if (req.method === 'GET' && url.pathname === '/api/message-drafts') return json(res, 200, snapshot().messageDrafts);
  if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, snapshot().tasks);
  if (req.method === 'GET' && url.pathname === '/api/approvals') return json(res, 200, snapshot().approvals);
  if (req.method === 'GET' && url.pathname === '/api/decisions') return json(res, 200, snapshot().decisions);
  if (req.method === 'GET' && url.pathname === '/api/constitution') return json(res, 200, constitution);
  if (req.method === 'GET' && url.pathname === '/api/metrics') return json(res, 200, overview().metrics);
  if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, auditEntries(Number(url.searchParams.get('limit') || 100)));
  if (req.method === 'GET' && url.pathname === '/api/audit/verify') return json(res, 200, verifyAudit());
  if (req.method === 'GET' && url.pathname === '/api/incidents') return json(res, 200, snapshot().incidents);
  if (req.method === 'GET' && url.pathname === '/api/proposals') return json(res, 200, snapshot().proposals);
  if (req.method === 'GET' && url.pathname === '/api/agent-keys') return json(res, 200, snapshot().agentKeys.map(({ token_hash, ...key }) => key));
  if (req.method === 'GET' && url.pathname === '/api/backup/export') {
    const integrity = verifyAudit();
    if (!integrity.valid) throw new HttpError(503, 'The workspace audit chain is invalid; export a backup only from a verified workspace');
    return json(res, 200, { format: 'vantage-ars-backup', version: 1, created_at: new Date().toISOString(), workspace: snapshot() });
  }

  if (req.method === 'POST' && url.pathname === '/api/leads') return json(res, 201, recordLead(makeLead(await readBody(req), 'owner')));
  if (req.method === 'POST' && url.pathname === '/api/approvals') {
    const approval = makeApproval(await readBody(req), 'owner', 'owner');
    return json(res, 201, transact('approval.requested', { approval_id: approval.id, kind: approval.kind, requested_role: 'owner', lead_id: approval.lead_id }, draft => { draft.approvals.unshift(approval); return approval; }));
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') return json(res, 201, recordTask(makeTask(await readBody(req), 'owner', null)));
  if (req.method === 'POST' && url.pathname === '/api/business-profile') {
    const input = await readBody(req);
    const profile = makeBusinessProfile(input);
    return json(res, 200, transact('business.profile_updated', { fields: Object.keys(input).sort() }, draft => { draft.businessProfile = profile; return profile; }));
  }
  if (restoreRoute) {
    const backup = await readBody(req, 32 * 1024 * 1024);
    try {
      return json(res, 200, restoreWorkspaceBackup(backup, requireOwner(req).id));
    } catch (error) {
      throw new HttpError(400, error.message || 'Backup restore failed validation');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/services') {
    const service = { id: id('service'), created_at: new Date().toISOString(), updated_at: null, ...makeService(await readBody(req)) };
    return json(res, 201, transact('service.created', { service_id: service.id, status: service.status }, draft => { draft.services.unshift(service); draft.counters.services++; return service; }));
  }
  const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)$/);
  if (req.method === 'POST' && serviceMatch) {
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const current = snapshot().services.find(item => item.id === serviceId);
    if (!current) throw new HttpError(404, 'Service not found');
    const updated = { ...current, ...makeService(await readBody(req), current), updated_at: new Date().toISOString() };
    return json(res, 200, transact('service.updated', { service_id: serviceId, status: updated.status }, draft => { const index = draft.services.findIndex(item => item.id === serviceId); draft.services[index] = updated; return updated; }));
  }
  if (req.method === 'POST' && url.pathname === '/api/message-drafts') {
    const draftMessage = makeMessageDraft(await readBody(req), 'owner', 'owner');
    return json(res, 201, transact('message.draft_created', { draft_id: draftMessage.id, lead_id: draftMessage.lead_id, channel: draftMessage.channel }, draft => { draft.messageDrafts.unshift(draftMessage); draft.counters.messageDrafts++; return draftMessage; }));
  }
  const messageReviewMatch = url.pathname.match(/^\/api\/message-drafts\/([^/]+)\/review$/);
  if (req.method === 'POST' && messageReviewMatch) {
    const input = await readBody(req);
    if (!['reviewed', 'changes_requested'].includes(input.status)) throw new HttpError(400, 'Choose reviewed or changes_requested');
    const note = text(input.note, 'Review note', 5, 1000);
    const draftId = decodeURIComponent(messageReviewMatch[1]);
    const current = snapshot().messageDrafts.find(item => item.id === draftId);
    if (!current) throw new HttpError(404, 'Message draft not found');
    if (current.status !== 'pending_review') throw new HttpError(409, 'This message draft has already been reviewed');
    const review = { status: input.status, note, by: 'owner', at: new Date().toISOString() };
    return json(res, 200, transact('message.draft_reviewed', { draft_id: draftId, status: input.status }, draft => {
      const message = draft.messageDrafts.find(item => item.id === draftId);
      message.status = input.status; message.review = review;
      return message;
    }));
  }
  if (req.method === 'POST' && url.pathname === '/api/agent-keys') {
    const input = await readBody(req);
    if (!roles[input.role]) throw new HttpError(400, 'Choose a valid department role');
    return json(res, 201, mintAgentKey(input.role));
  }
  const revokeMatch = url.pathname.match(/^\/api\/agent-keys\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && revokeMatch) {
    const result = revokeAgentKey(decodeURIComponent(revokeMatch[1]));
    return result ? json(res, 200, result) : json(res, 404, { error: 'Active credential not found' });
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === 'POST' && taskMatch) {
    const input = await readBody(req);
    if (!taskStatuses.includes(input.status)) throw new HttpError(400, 'Choose open, in_progress, or done');
    const taskId = decodeURIComponent(taskMatch[1]);
    if (!snapshot().tasks.some(task => task.id === taskId)) throw new HttpError(404, 'Task not found');
    const updated = transact('task.status_changed', { task_id: taskId, status: input.status }, draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      task.status = input.status;
      task.updated_at = new Date().toISOString();
      task.updated_by = 'owner';
      return task;
    });
    return json(res, 200, updated);
  }
  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (req.method === 'POST' && approvalMatch) {
    const input = await readBody(req);
    if (!['approve', 'reject'].includes(input.decision)) throw new HttpError(400, 'Choose approve or reject');
    const rationale = text(input.rationale, 'Decision reason', 5, 1000);
    const approvalId = decodeURIComponent(approvalMatch[1]);
    const current = snapshot().approvals.find(item => item.id === approvalId);
    if (!current) throw new HttpError(404, 'Approval request not found');
    if (current.status !== 'pending') throw new HttpError(409, 'This request has already been decided');
    if (current.lead_id && !snapshot().leads.some(item => item.id === current.lead_id)) throw new HttpError(409, 'The linked lead no longer exists');
    const now = new Date().toISOString();
    const result = transact('approval.decided', { approval_id: approvalId, decision: input.decision, kind: current.kind }, draft => {
      const approval = draft.approvals.find(item => item.id === approvalId);
      approval.status = input.decision === 'approve' ? 'approved' : 'rejected';
      approval.decision = { by: 'owner', at: now, rationale };
      if (input.decision === 'approve' && approval.kind === 'sales_handoff') {
        const lead = draft.leads.find(item => item.id === approval.lead_id);
        lead.stage = 'sales_queue'; lead.updated_at = now; lead.updated_by = 'owner';
      }
      if (input.decision === 'approve' && approval.kind === 'customer_outcome') {
        const lead = draft.leads.find(item => item.id === approval.lead_id);
        lead.stage = approval.proposed_outcome; lead.updated_at = now; lead.updated_by = 'owner';
      }
      return approval;
    });
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/decisions/evaluate') return json(res, 200, evaluate(await readBody(req)));
  if (req.method === 'POST' && url.pathname === '/api/decisions/execute') return json(res, 201, execute(await readBody(req), 'owner'));
  if (req.method === 'POST' && url.pathname === '/api/incidents') {
    const input = await readBody(req);
    const incident = { id: id('inc'), opened_at: new Date().toISOString(), severity: ['P0', 'P1', 'P2', 'P3'].includes(input.severity) ? input.severity : 'P2', title: text(input.title, 'Incident title', 3, 160), description: input.description ? text(input.description, 'Description', 1, 2000) : '', status: 'open', detection: 'owner' };
    return json(res, 201, transact('incident.opened', { incident_id: incident.id, severity: incident.severity }, draft => { draft.incidents.unshift(incident); draft.counters.incidents++; return incident; }));
  }
  if (req.method === 'POST' && url.pathname === '/api/constitution/proposals') {
    const input = await readBody(req);
    const proposal = { id: id('prop'), created_at: new Date().toISOString(), status: 'pending_multisig', title: text(input.title, 'Title', 3, 160), rationale: text(input.rationale, 'Reason', 5, 2000), proposed_change: text(input.proposed_change, 'Proposed change', 5, 4000), requested_by: 'owner' };
    return json(res, 201, transact('constitution.proposal', { proposal_id: proposal.id }, draft => { draft.proposals.unshift(proposal); draft.counters.proposals++; return proposal; }));
  }
  const incidentMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && incidentMatch) {
    const input = await readBody(req);
    const incidentId = decodeURIComponent(incidentMatch[1]);
    const result = transact('incident.resolved', { incident_id: incidentId }, draft => {
      const incident = draft.incidents.find(item => item.id === incidentId);
      if (!incident) return null;
      incident.status = 'resolved'; incident.resolved_at = new Date().toISOString(); incident.remediation = text(input.remediation, 'Remediation record', 5, 1000);
      return incident;
    });
    return result ? json(res, 200, result) : json(res, 404, { error: 'Incident not found' });
  }
  const decisionMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
  if (req.method === 'GET' && decisionMatch) {
    const result = snapshot().decisions.find(item => item.id === decodeURIComponent(decisionMatch[1]));
    return result ? json(res, 200, result) : json(res, 404, { error: 'Decision not found' });
  }
  return json(res, 404, { error: 'Not found' });
}
async function agentRoute(req, res, url) {
  const agent = requireAgent(req);
  if (req.method === 'GET' && url.pathname === '/api/agent/identity') {
    const role = roles[agent.role];
    return json(res, 200, { id: agent.id, role: agent.role, ...role });
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/leads') {
    if (!['reception', 'marketing', 'sales'].includes(agent.role)) throw new HttpError(403, 'This role does not access customer records');
    const visibleStages = agent.role === 'reception' ? ['enquiry'] : agent.role === 'marketing' ? ['enquiry', 'marketing_review'] : ['sales_queue', 'sales_working'];
    return json(res, 200, snapshot().leads.filter(lead => visibleStages.includes(lead.stage)));
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/business-profile') {
    if (!['marketing', 'sales'].includes(agent.role)) throw new HttpError(403, 'This role cannot access the business profile');
    const { name, domain, offering, target_customers, service_area, currency } = snapshot().businessProfile;
    return json(res, 200, { name, domain, offering, target_customers, service_area, currency });
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/services') {
    if (!['marketing', 'sales'].includes(agent.role)) throw new HttpError(403, 'This role cannot access the service catalogue');
    return json(res, 200, snapshot().services.filter(item => item.status === 'available'));
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/message-drafts') {
    if (!['reception', 'marketing', 'sales'].includes(agent.role)) throw new HttpError(403, 'This role cannot access customer message drafts');
    const visibleStages = agent.role === 'reception' ? ['enquiry'] : agent.role === 'marketing' ? ['enquiry', 'marketing_review'] : ['sales_queue', 'sales_working'];
    const leads = new Set(snapshot().leads.filter(lead => visibleStages.includes(lead.stage)).map(lead => lead.id));
    return json(res, 200, snapshot().messageDrafts.filter(item => leads.has(item.lead_id)));
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/tasks') {
    return json(res, 200, snapshot().tasks.filter(task => task.department === agent.role));
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Role credentials can only submit scoped work');
  if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin requests are not accepted');
  if (!verifyAudit().valid) throw new HttpError(503, 'Workspace changes are paused because the audit chain failed verification');
  const input = await readBody(req);
  if (url.pathname === '/api/agent/intake') {
    if (!['reception', 'marketing'].includes(agent.role)) throw new HttpError(403, 'This role cannot create enquiries');
    return json(res, 201, recordLead(makeLead(input, `agent:${agent.role}`)));
  }
  if (url.pathname === '/api/agent/tasks') {
    return json(res, 201, recordTask(makeTask(input, `agent:${agent.role}`, agent.role)));
  }
  if (url.pathname === '/api/agent/approvals') {
    const approval = makeApproval(input, `agent:${agent.role}`, agent.role);
    return json(res, 201, transact('approval.requested', { approval_id: approval.id, kind: approval.kind, requested_role: agent.role, lead_id: approval.lead_id }, draft => { draft.approvals.unshift(approval); return approval; }));
  }
  if (url.pathname === '/api/agent/message-drafts') {
    const draftMessage = makeMessageDraft(input, `agent:${agent.role}`, agent.role);
    return json(res, 201, transact('message.draft_created', { draft_id: draftMessage.id, lead_id: draftMessage.lead_id, channel: draftMessage.channel, requested_role: agent.role }, draft => { draft.messageDrafts.unshift(draftMessage); draft.counters.messageDrafts++; return draftMessage; }));
  }
  const progressMatch = url.pathname.match(/^\/api\/agent\/leads\/([^/]+)\/progress$/);
  if (progressMatch) {
    const leadId = decodeURIComponent(progressMatch[1]);
    const lead = snapshot().leads.find(item => item.id === leadId);
    if (!lead) throw new HttpError(404, 'Lead not found');
    let nextStage;
    if (agent.role === 'marketing' && lead.stage === 'enquiry') nextStage = 'marketing_review';
    else if (agent.role === 'sales' && lead.stage === 'sales_queue') nextStage = 'sales_working';
    else throw new HttpError(403, 'This role cannot progress this lead from its current stage');
    const result = transact('lead.progressed', { lead_id: leadId, from: lead.stage, to: nextStage, actor: agent.role }, draft => {
      const item = draft.leads.find(record => record.id === leadId);
      item.stage = nextStage; item.updated_at = new Date().toISOString(); item.updated_by = `agent:${agent.role}`;
      return item;
    });
    return json(res, 200, result);
  }
  throw new HttpError(404, 'Not found');
}
async function api(req, res, url) {
  if (url.pathname === '/api/lead') return publicLeadRoute(req, res);
  if (req.method === 'GET' && url.pathname === '/api/session') return sessionEndpoint(req, res);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/api/ready') {
    const audit = verifyAudit();
    const ready = Boolean(ownerSummary()) && audit.valid;
    return json(res, ready ? 200 : 503, { ready, owner_configured: Boolean(ownerSummary()), audit_integrity: audit.valid });
  }
  if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin requests are not accepted');
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    const input = await readBody(req);
    if (ownerSummary()) throw new HttpError(409, 'Owner access has already been configured');
    if (setting('NODE_ENV') === 'production') {
      if (!setting('OWNER_SETUP_TOKEN')) throw new HttpError(503, 'Set OWNER_SETUP_TOKEN before configuring the first owner in production');
      if (!constantTimeEqual(input.setup_token, setting('OWNER_SETUP_TOKEN'))) throw new HttpError(403, 'The one-time setup token is incorrect');
    }
    const name = text(input.name, 'Owner name', 2, 100);
    const email = emailAddress(input.email);
    if (!email) throw new HttpError(400, 'Enter a valid email address');
    if (typeof input.password !== 'string' || input.password.length < 16 || input.password.length > 256) throw new HttpError(400, 'Use a password or passphrase with at least 16 characters');
    const owner = saveOwner({ name, email, passwordHash: hashPassword(input.password) });
    const issued = issueSession(owner);
    setSessionCookie(res, issued.sid);
    return json(res, 201, { owner, csrf: issued.csrf });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = clientAddress(req);
    const attempts = loginAttempts.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (attempts.until <= Date.now()) { attempts.count = 0; attempts.until = Date.now() + 15 * 60 * 1000; }
    if (attempts.count >= 8) throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const input = await readBody(req);
    const owner = snapshot().owner;
    if (!owner || !verifyPassword(input.password, owner.password_hash) || emailAddress(input.email) !== owner.email) {
      attempts.count++;
      loginAttempts.set(ip, attempts);
      throw new HttpError(401, 'Email or password is incorrect');
    }
    loginAttempts.delete(ip);
    const summary = { id: owner.id, name: owner.name, email: owner.email };
    const issued = issueSession(summary);
    setSessionCookie(res, issued.sid);
    return json(res, 200, { owner: summary, csrf: issued.csrf });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    requireOwner(req, true, true); destroySession(req); clearSessionCookie(res); return json(res, 200, { signed_out: true });
  }
  if (url.pathname.startsWith('/api/agent/')) return agentRoute(req, res, url);
  return ownerRoute(req, res, url);
}
function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/index.html') pathname = '/site.html';
    else if (pathname === '/office' || pathname === '/office/') pathname = '/index.html';
  }
  catch { throw new HttpError(400, 'Invalid path'); }
  const target = path.resolve(publicDir, `.${pathname}`);
  const relative = path.relative(publicDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(403, 'Forbidden');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  try {
    const data = fs.readFileSync(target);
    res.writeHead(200, { 'content-type': `${types[path.extname(target)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { throw new HttpError(404, 'Not found'); }
}

let staffRunner = null;
export function registerStaffRunner(fn) { staffRunner = fn; }
export const staffOps = {
  makeMessageDraft, makeTask, makeApproval, recordTask,
  draftRecord: draftMessage => transact('message.draft_created', { draft_id: draftMessage.id, lead_id: draftMessage.lead_id, channel: draftMessage.channel, requested_role: draftMessage.requested_role }, draft => { draft.messageDrafts.unshift(draftMessage); draft.counters.messageDrafts++; return draftMessage; }),
  approvalRecord: (approval, role) => transact('approval.requested', { approval_id: approval.id, kind: approval.kind, requested_role: role, lead_id: approval.lead_id }, draft => { draft.approvals.unshift(approval); return approval; }),
  progressLead: (leadId, from, to, role) => transact('lead.progressed', { lead_id: leadId, from, to, actor: role }, draft => {
    const item = draft.leads.find(record => record.id === leadId);
    item.stage = to; item.updated_at = new Date().toISOString(); item.updated_by = `agent:${role}`;
    return item;
  }),
  auditValid: () => verifyAudit().valid
};
export const server = http.createServer(async (req, res) => {
  secureHeaders(res, req.url.split('?')[0]);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error('Request failed:', error);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'The request could not be completed' : error.message });
    else res.destroy();
  }
});
