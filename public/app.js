const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateFmt = value => value ? new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeZone: 'Africa/Johannesburg' }).format(new Date(value)) : 'No due date';
const dateTimeFmt = value => value ? new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }).format(new Date(value)) : '—';
const moneyFmt = cents => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format((Number(cents) || 0) / 100);
const stageNames = { enquiry: 'Enquiry', marketing_review: 'Marketing review', sales_queue: 'Sales queue', sales_working: 'Sales working', customer: 'Customer', closed_lost: 'Closed lost' };
const taskNames = { open: 'Open', in_progress: 'In progress', done: 'Done' };
const approvalNames = { spend: 'Proposed spend', sales_handoff: 'Marketing to Sales handoff', customer_offer: 'Customer offer', customer_commitment: 'Customer commitment', customer_outcome: 'Customer outcome', customer_risk: 'At-risk customer action', production_change: 'Production change' };
const viewNames = { overview: 'OVERVIEW', customers: 'CUSTOMER PIPELINE', work: 'OPERATIONS', approvals: 'FOUNDER CONTROL', messages: 'MESSAGE DRAFTS', business: 'BUSINESS SETUP', departments: 'ROLE AUTHORITY', governance: 'CONTROL & EVIDENCE' };
let csrf = '';
let authenticated = false;
let setupTokenRequired = false;
let setupReady = true;
let data = { overview: null, leads: [], tasks: [], approvals: [], roles: [], keys: [], audit: [], decisions: [], constitution: null, profile: null, services: [], messageDrafts: [] };
let taskFilter = 'all';
let noticeTimer;

function notice(message, type = 'info') {
  const box = $('#notice');
  box.hidden = false;
  box.className = `notice${type === 'error' ? ' error' : ''}`;
  box.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { box.hidden = true; }, 6500);
}
async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string') {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (authenticated && options.method && options.method !== 'GET') headers.set('x-csrf-token', csrf);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
function showAuth(configured, errorMessage = '') {
  authenticated = false;
  csrf = '';
  $('#workspace').hidden = true;
  const root = $('#auth-root');
  root.hidden = false;
  const setup = !configured;
  root.innerHTML = `<section class="auth-card" aria-labelledby="auth-title">
    <div class="auth-brand"><span class="brand-mark" aria-hidden="true">V</span><span><strong>VANTAGE-ARS</strong><small>FOUNDER OFFICE</small></span></div>
    <p class="eyebrow">PRIVATE BUSINESS WORKSPACE</p>
    <h1 id="auth-title">${setup ? 'Set up founder access' : 'Welcome back'}</h1>
    <p>${setup ? 'Create the owner account that controls this workspace. Use a unique passphrase of at least 16 characters.' : 'Sign in to your private workspace.'}</p>
    <form id="auth-form" class="auth-form">
      ${setup ? '<label class="field">Your name<input name="name" required minlength="2" maxlength="100" autocomplete="name"></label>' : ''}
      ${setup && setupTokenRequired ? '<label class="field">One-time setup token<input name="setup_token" type="password" required autocomplete="off"></label>' : ''}
      <label class="field">Email address<input name="email" type="email" required maxlength="254" autocomplete="username"></label>
      <label class="field">${setup ? 'Passphrase' : 'Password'}<input name="password" type="password" required minlength="${setup ? '16' : '1'}" maxlength="256" autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
      ${setup && !setupReady ? '<div class="auth-error" role="alert">First-owner setup is disabled. Configure OWNER_SETUP_TOKEN on the server first.</div>' : ''}
      ${errorMessage ? `<div class="auth-error" role="alert">${esc(errorMessage)}</div>` : ''}
      <button class="primary-button" type="submit" ${setup && !setupReady ? 'disabled' : ''}>${setup ? 'Create owner account' : 'Sign in'}</button>
    </form>
    <div class="auth-foot">Local-first storage · Owner-only access · No paid services required</div>
  </section>`;
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const result = await request(setup ? '/api/setup' : '/api/login', { method: 'POST', body });
      csrf = result.csrf;
      authenticated = true;
      root.hidden = true;
      $('#workspace').hidden = false;
      setOwner(result.owner);
      await loadWorkspace();
    } catch (error) {
      button.disabled = false;
      showAuth(!setup || error.status === 409, error.message);
    }
  });
}
function setOwner(owner) {
  $('#owner-name').textContent = owner?.name || 'Founder';
  $('#owner-email').textContent = owner?.email || '';
  const initials = (owner?.name || 'Founder').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  $('.avatar').textContent = initials;
}
function empty(message) { return `<div class="empty-state">${esc(message)}</div>`; }
function label(kind, mapping) { return mapping[kind] || String(kind || '—').replaceAll('_', ' '); }
function statusTag(status, type = 'neutral') { return `<span class="tag tag-${type}">${esc(status)}</span>`; }
function renderMetrics(metrics) {
  const metricsToShow = [
    ['Enquiries', metrics.enquiries, 'in customer pipeline'],
    ['Sales queue', metrics.sales_queue, 'owner-approved handoffs'],
    ['Customers', metrics.customers, 'recorded outcomes'],
    ['Need approval', metrics.pending_approvals, 'waiting for your decision'],
    ['Open tasks', metrics.open_tasks, 'across departments']
  ];
  $('#metrics').innerHTML = metricsToShow.map(([name, value, note]) => `<article class="metric-card"><span>${esc(name)}</span><strong>${Number(value) || 0}</strong><small>${esc(note)}</small></article>`).join('');
  $('#nav-leads').textContent = metrics.enquiries;
  $('#nav-tasks').textContent = metrics.open_tasks;
  $('#nav-approvals').textContent = metrics.pending_approvals;
  $('#nav-messages').textContent = metrics.message_drafts?.pending_review || 0;
}
function renderBusiness(profile, services) {
  const form = $('#business-form');
  for (const key of ['name', 'domain', 'offering', 'target_customers', 'service_area']) form.elements[key].value = profile?.[key] || '';
  const list = $('#service-list');
  list.innerHTML = services.length ? services.map(item => `<article class="service-row"><div><strong>${esc(item.title)}</strong><p>${esc(item.description || 'No details entered.')}</p><small>${item.price_cents === null ? 'Price not set' : esc(moneyFmt(item.price_cents))} · ZAR</small></div><label class="task-actions"><span class="sr-only">Catalogue status</span><select data-service-status="${esc(item.id)}" aria-label="Catalogue status for ${esc(item.title)}"><option value="draft" ${item.status === 'draft' ? 'selected' : ''}>Draft</option><option value="available" ${item.status === 'available' ? 'selected' : ''}>Available internally</option><option value="paused" ${item.status === 'paused' ? 'selected' : ''}>Paused</option></select></label></article>`).join('') : empty('No service entries yet. Add only services you really offer.');
}
function renderMessageDrafts(items) {
  const leadSelect = $('#message-form select[name="lead_id"]');
  leadSelect.innerHTML = data.leads.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(label(item.stage, stageNames))}</option>`).join('');
  $('#message-form button[type="submit"]').disabled = data.leads.length === 0;
  const list = $('#message-draft-list');
  list.innerHTML = items.length ? items.map(item => {
    const lead = data.leads.find(row => row.id === item.lead_id);
    const pending = item.status === 'pending_review';
    return `<article class="message-draft"><div class="message-draft-head"><div><strong>${esc(lead?.name || 'Enquiry')}</strong><small>${esc(label(item.channel, {}))} · ${esc(item.requested_role)} · ${esc(dateTimeFmt(item.created_at))}</small></div>${statusTag(label(item.status, { pending_review: 'Needs review', reviewed: 'Reviewed, not sent', changes_requested: 'Changes requested' }), pending ? 'warn' : 'neutral')}</div>${item.subject ? `<h4>${esc(item.subject)}</h4>` : ''}<p>${esc(item.body)}</p>${item.review ? `<small>Founder note: ${esc(item.review.note)}</small>` : ''}${pending ? `<div class="approval-actions"><button class="approve-button" data-message-review="${esc(item.id)}" data-message-status="reviewed">Mark reviewed</button><button class="reject-button" data-message-review="${esc(item.id)}" data-message-status="changes_requested">Request changes</button></div>` : '<small>Delivery disabled · this draft has not been sent</small>'}</article>`;
  }).join('') : empty('No message drafts. Drafts prepared for an enquiry will appear here for your review.');
}
function renderStackApproval(items) {
  const pending = items.filter(item => item.status === 'pending').slice(0, 4);
  return pending.length ? pending.map(item => `<div class="stack-row"><div class="stack-main"><strong>${esc(item.summary)}</strong><small>${esc(label(item.kind, approvalNames))} · ${esc(item.requested_role)} · ${esc(dateTimeFmt(item.created_at))}</small></div><span class="tag tag-warn">Review</span></div>`).join('') : empty('No requests are waiting for your decision.');
}
function renderLeadTable(leads) {
  $('#lead-count').textContent = `${leads.length} ${leads.length === 1 ? 'record' : 'records'}`;
  if (!leads.length) { $('#lead-table').innerHTML = empty('No enquiries yet. Add a real enquiry to start the pipeline.'); return; }
  $('#lead-table').innerHTML = `<table class="data-table"><thead><tr><th>Contact</th><th>Organization</th><th>Contact details</th><th>Enquiry</th><th>Stage</th><th>Received</th></tr></thead><tbody>${leads.map(lead => `<tr><td>${esc(lead.name)}</td><td>${esc(lead.organization || '—')}</td><td>${esc([lead.email, lead.phone].filter(Boolean).join(' · ') || '—')}</td><td class="lead-details">${esc(lead.details || '—')}</td><td><span class="stage-chip stage-${esc(lead.stage)}">${esc(label(lead.stage, stageNames))}</span></td><td>${esc(dateFmt(lead.created_at))}</td></tr>`).join('')}</tbody></table>`;
}
function renderTasks(tasks) {
  const visible = tasks.filter(task => taskFilter === 'all' || (taskFilter === 'done' ? task.status === 'done' : task.status !== 'done'));
  if (!visible.length) { $('#task-list').innerHTML = empty(tasks.length ? 'No tasks match this filter.' : 'No tasks yet. Add real work for a department.'); return; }
  $('#task-list').innerHTML = visible.map(task => `<article class="task-row"><div><h4>${esc(task.title)}</h4>${task.description ? `<p>${esc(task.description)}</p>` : ''}<div class="task-meta"><span class="tag tag-neutral">${esc(task.department)}</span><span class="tag tag-neutral">${esc(task.due_date ? dateFmt(`${task.due_date}T12:00:00`) : 'No due date')}</span><span class="tag ${task.status === 'done' ? 'tag-good' : 'tag-neutral'}">${esc(label(task.status, taskNames))}</span></div></div><label class="task-actions"><span class="sr-only">Update status</span><select data-task-status="${esc(task.id)}" aria-label="Update task status">${['open', 'in_progress', 'done'].map(status => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${esc(label(status, taskNames))}</option>`).join('')}</select></label></article>`).join('');
}
function renderApprovals(items) {
  if (!items.length) { $('#approval-list').innerHTML = empty('The approval inbox is clear. Requests submitted through scoped role credentials will appear here.'); return; }
  $('#approval-list').innerHTML = items.map(item => {
    const lead = data.leads.find(record => record.id === item.lead_id);
    const pending = item.status === 'pending';
    const amount = item.amount_cents === null ? '' : `<span>${esc(moneyFmt(item.amount_cents))} · proposed spend</span>`;
    const leadInfo = lead ? `<span>Lead: ${esc(lead.name)} · ${esc(label(lead.stage, stageNames))}</span>` : '';
    const outcome = item.proposed_outcome ? `<span>Proposed outcome: ${esc(label(item.proposed_outcome, stageNames))}</span>` : '';
    const decided = item.decision ? `<span>${esc(item.decision.by)} · ${esc(dateTimeFmt(item.decision.at))}</span><span>${esc(item.decision.rationale)}</span>` : '';
    return `<article class="approval-card ${pending ? 'pending' : ''}"><div class="approval-top"><div><span class="approval-kind">${esc(label(item.kind, approvalNames))}</span><h3>${esc(item.summary)}</h3><p>${esc(item.rationale)}</p></div>${statusTag(label(item.status, { pending: 'Needs review', approved: 'Approved', rejected: 'Rejected' }), pending ? 'warn' : item.status === 'approved' ? 'good' : 'danger')}</div><div class="approval-meta"><span>Requested by ${esc(item.requested_role)}</span><span>${esc(dateTimeFmt(item.created_at))}</span>${amount}${leadInfo}${outcome}${decided}</div>${pending ? `<div class="approval-actions"><button class="approve-button" data-approval="${esc(item.id)}" data-choice="approve">Approve</button><button class="reject-button" data-approval="${esc(item.id)}" data-choice="reject">Reject</button></div>` : ''}</article>`;
  }).join('');
}
function renderRoles(items) {
  const roleSelect = $('#task-form select[name="department"]');
  const credentialSelect = $('#credential-form select[name="role"]');
  roleSelect.innerHTML = items.map(role => `<option value="${esc(role.id)}">${esc(role.name)}</option>`).join('');
  credentialSelect.innerHTML = items.map(role => `<option value="${esc(role.id)}">${esc(role.name)}</option>`).join('');
  $('#role-grid').innerHTML = items.map(role => `<article class="role-card"><div class="role-top"><h3>${esc(role.name)}</h3><span class="credential-state ${role.credential_active ? '' : 'inactive'}">${role.credential_active ? 'Credential active · no worker' : 'No credential · no worker'}</span></div><p>${esc(role.purpose)}</p><h4>Can do</h4><ul>${role.permissions.map(item => `<li>${esc(item)}</li>`).join('')}</ul><h4>Stops at</h4><ul>${role.boundaries.map(item => `<li>${esc(item)}</li>`).join('')}</ul></article>`).join('');
}
function renderCredentials(items) {
  $('#credential-list').innerHTML = items.length ? items.map(key => `<div class="credential-row"><div><strong>${esc(key.role)} · ${esc(key.id.slice(0, 16))}</strong><small>Issued ${esc(dateTimeFmt(key.created_at))}${key.revoked_at ? ` · Revoked ${esc(dateTimeFmt(key.revoked_at))}` : ''}</small></div>${key.revoked_at ? '<span class="tag tag-neutral">Revoked</span>' : `<button class="revoke-button" data-revoke="${esc(key.id)}">Revoke</button>`}</div>`).join('') : empty('No role credentials have been issued.');
}
function renderGovernance(constitution, decisions, audit) {
  const signatures = constitution.ratification?.signatures?.length || 0;
  $('#constitution-version').textContent = `v${constitution.version} · ${signatures >= (constitution.ratification?.threshold || Infinity) ? 'ratified' : 'formal ratification pending'}`;
  $('#constitution-preamble').textContent = constitution.preamble;
  $('#provisions').innerHTML = constitution.provisions.map(item => `<div class="provision"><strong>${esc(item.id)} · ${esc(item.title)}</strong><span>${esc(item.enforcement.replaceAll('_', ' '))} · ${esc(item.text)}</span></div>`).join('');
  $('#decision-list').innerHTML = decisions.length ? decisions.slice(0, 10).map(item => `<div class="stack-row"><div class="stack-main"><strong>${esc(item.action?.type || 'Governance evaluation')} · ${esc(item.status)}</strong><small>${esc(item.agent_id)} · ${esc(dateTimeFmt(item.timestamp))} · External execution: none</small></div>${statusTag(item.status, item.status === 'blocked' ? 'danger' : 'neutral')}</div>`).join('') : empty('No decision records have been submitted.');
  $('#audit-list').innerHTML = audit.length ? audit.map(item => `<div class="audit-row"><strong>${esc(item.type)}</strong><small>${esc(dateTimeFmt(item.timestamp))}</small><code title="${esc(item.hash)}">${esc(item.hash)}</code></div>`).join('') : empty('Audit activity will appear when real workspace changes are recorded.');
}
function renderOverview(view) {
  const metrics = view.metrics;
  renderMetrics(metrics);
  $('#system-posture').textContent = view.service.status === 'ready' ? 'Protected' : view.service.status;
  $('#posture-detail').textContent = metrics.audit_integrity ? 'Audit chain intact · owner control active' : 'Audit chain needs review';
  $('#overview-approvals').innerHTML = renderStackApproval(view.recent_approvals);
  $('#overview-leads').innerHTML = view.recent_leads.length ? view.recent_leads.slice(0, 5).map(lead => `<div class="stack-row"><div class="stack-main"><strong>${esc(lead.name)}</strong><small>${esc(label(lead.stage, stageNames))} · ${esc(dateFmt(lead.created_at))}</small></div><span class="stage-chip stage-${esc(lead.stage)}">${esc(label(lead.stage, stageNames))}</span></div>`).join('') : empty('No enquiries recorded.');
  $('#overview-tasks').innerHTML = view.recent_tasks.filter(task => task.status !== 'done').length ? view.recent_tasks.filter(task => task.status !== 'done').slice(0, 5).map(task => `<div class="stack-row"><div class="stack-main"><strong>${esc(task.title)}</strong><small>${esc(task.department)} · ${esc(task.due_date ? dateFmt(`${task.due_date}T12:00:00`) : 'No due date')}</small></div><span class="tag tag-neutral">${esc(label(task.status, taskNames))}</span></div>`).join('') : empty('No open tasks.');
  const links = view.integrations;
  const setReady = (selector, ready, connectedLabel = 'Connected') => { $(selector).textContent = ready ? connectedLabel : 'Not connected'; };
  setReady('#ready-ai', links.ai_provider);
  setReady('#ready-comms', links.email && links.calendar, links.email && links.calendar ? 'Connected' : links.email || links.calendar ? 'Partly connected' : 'Not connected');
  setReady('#ready-finance', links.payments && links.accounting, links.payments && links.accounting ? 'Connected' : links.payments || links.accounting ? 'Partly connected' : 'Not connected');
  setReady('#ready-website', links.website_lead_intake, 'Routed to app');
  const run = view.runtime.last_staff_run;
  $('#run-staff').hidden = !links.ai_provider;
  $('#staff-last-run').textContent = !links.ai_provider ? 'Not connected' : run ? `Last run ${dateTimeFmt(run.at)}` : 'Active, no run yet';
}
function switchView(name) {
  if (!viewNames[name]) return;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#section-label').textContent = viewNames[name];
  const titles = { overview: 'Founder office', customers: 'Enquiries & sales', work: 'Work queue', approvals: 'Founder approvals', messages: 'Message drafts', business: 'Business & services', departments: 'Departments & access', governance: 'Governance & audit' };
  $('#page-title').textContent = name === 'overview' ? `${greeting()}, ${$('#owner-name').textContent.split(' ')[0]}` : titles[name];
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-ZA', { hour: 'numeric', hour12: false, timeZone: 'Africa/Johannesburg' }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (viewNames[name]) switchView(name);
});
async function loadWorkspace() {
  try {
    const [overview, leads, tasks, approvals, roles, keys, audit, decisions, constitution, profile, services, messageDrafts] = await Promise.all([
      request('/api/overview'), request('/api/leads'), request('/api/tasks'), request('/api/approvals'), request('/api/roles'), request('/api/agent-keys'), request('/api/audit?limit=30'), request('/api/decisions'), request('/api/constitution'), request('/api/business-profile'), request('/api/services'), request('/api/message-drafts')
    ]);
    data = { overview, leads, tasks, approvals, roles, keys, audit, decisions, constitution, profile, services, messageDrafts };
    renderOverview(overview);
    renderLeadTable(leads);
    renderTasks(tasks);
    renderApprovals(approvals);
    renderRoles(roles);
    renderCredentials(keys);
    renderGovernance(constitution, decisions, audit);
    renderBusiness(profile, services);
    renderMessageDrafts(messageDrafts);
    setOwner(overview.owner);
    const current = viewNames[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
    switchView(current);
    $('#today').textContent = new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeZone: 'Africa/Johannesburg' }).format(new Date());
  } catch (error) {
    if (error.status === 401) { showAuth(true, 'Your session has expired. Sign in again.'); return; }
    notice(error.message, 'error');
  }
}
function messageReviewDialog(item, status) {
  const form = $('#message-review-form');
  form.elements.id.value = item.id;
  form.elements.status.value = status;
  $('#message-review-copy').textContent = `${item.channel.toUpperCase()} · ${item.subject || 'Message draft'}\n\n${item.body}\n\nReviewing this draft never sends it.`;
  $('#message-review-confirm').textContent = status === 'reviewed' ? 'Mark reviewed' : 'Request changes';
  $('#message-review-confirm').className = status === 'reviewed' ? 'primary-button' : 'reject-button';
  $('#message-review-dialog').showModal();
}
function approvalDialog(item, choice) {
  const dialog = $('#approval-dialog');
  const form = $('#approval-form');
  form.elements.id.value = item.id;
  form.elements.decision.value = choice;
  $('#approval-dialog-title').textContent = choice === 'approve' ? 'Approve request' : 'Reject request';
  $('#approval-dialog-summary').textContent = `${label(item.kind, approvalNames)} — ${item.summary}\n${item.rationale}${item.amount_cents !== null ? `\nAmount: ${moneyFmt(item.amount_cents)} (authorization record only)` : ''}`;
  $('#approval-confirm').textContent = choice === 'approve' ? 'Approve request' : 'Reject request';
  $('#approval-confirm').className = choice === 'approve' ? 'primary-button' : 'reject-button';
  dialog.showModal();
}
async function handleForm(form, endpoint, successMessage, onSuccess) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form).entries());
    const result = await request(endpoint, { method: 'POST', body });
    form.reset();
    if (onSuccess) onSuccess(result);
    notice(successMessage);
    await loadWorkspace();
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
}

const requestStages = { sales_handoff: ['marketing_review'], customer_offer: ['sales_working'], customer_commitment: ['sales_working'], customer_outcome: ['sales_working'], customer_risk: ['customer'] };
function refreshRequestForm() {
  const kind = $('#request-kind').value;
  const stages = requestStages[kind];
  const select = $('#request-lead');
  const pendingIds = new Set(data.approvals.filter(item => item.status === 'pending' && item.kind === kind).map(item => item.lead_id));
  const eligible = stages ? data.leads.filter(lead => stages.includes(lead.stage) && !pendingIds.has(lead.id)) : [];
  select.innerHTML = eligible.length ? eligible.map(lead => `<option value="${esc(lead.id)}">${esc(lead.name)}${lead.organization ? ' · ' + esc(lead.organization) : ''}</option>`).join('') : '<option value="">No eligible lead at the required stage</option>';
  select.required = Boolean(stages);
  $('#request-lead-field').hidden = !stages;
  $('#request-amount-field').hidden = kind !== 'spend';
  $('#request-amount').required = kind === 'spend';
  $('#request-outcome-field').hidden = kind !== 'customer_outcome';
}
$('#new-approval').addEventListener('click', () => {
  $('#request-kind').innerHTML = Object.entries(approvalNames).map(([value, name]) => `<option value="${esc(value)}">${esc(name)}</option>`).join('');
  refreshRequestForm();
  $('#request-dialog').showModal();
});
$('#request-kind').addEventListener('change', refreshRequestForm);
$('#request-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const body = { kind: values.kind, summary: values.summary, rationale: values.rationale };
  if (requestStages[values.kind]) {
    if (!values.lead_id) { notice('There is no eligible lead at the stage this request requires.', 'error'); return; }
    body.lead_id = values.lead_id;
  }
  if (values.kind === 'spend') {
    const amount = String(values.amount || '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { notice('Enter a positive amount with up to two decimal places.', 'error'); return; }
    body.amount_cents = Math.round(Number(amount) * 100);
  }
  if (values.kind === 'customer_outcome') body.proposed_outcome = values.proposed_outcome;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/approvals', { method: 'POST', body });
    form.reset();
    $('#request-dialog').close();
    notice('Request added to the approval inbox.');
    await loadWorkspace();
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#run-staff').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await request('/api/staff/run', { method: 'POST', body: {} });
    notice(result.ran ? `Staff run finished: ${result.drafts} draft(s), ${result.tasks} task(s), ${result.handoffs} handoff request(s)${result.errors ? `, ${result.errors} error(s)` : ''}.` : result.reason, result.ran ? 'info' : 'error');
    await loadWorkspace();
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#new-lead').addEventListener('click', () => $('#lead-dialog').showModal());
$('#lead-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget, '/api/leads', 'Enquiry recorded.', () => $('#lead-dialog').close()); });
$('#task-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget, '/api/tasks', 'Task added to the work queue.'); });
$('#business-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget, '/api/business-profile', 'Business profile saved.'); });
$('#service-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const price = form.elements.price.value.trim();
  if (price && !/^\d+(?:\.\d{1,2})?$/.test(price)) { notice('Enter a price with up to two decimal places.', 'error'); return; }
  const body = Object.fromEntries(new FormData(form).entries());
  body.price_cents = price ? Math.round(Number(price) * 100) : null;
  delete body.price;
  const submit = async () => {
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try { await request('/api/services', { method: 'POST', body }); form.reset(); notice('Service added to the internal catalogue.'); await loadWorkspace(); }
    catch (error) { notice(error.message, 'error'); }
    finally { button.disabled = false; }
  };
  submit();
});
$('#message-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget, '/api/message-drafts', 'Message draft queued for founder review. Nothing was sent.'); });
$('#message-review-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  handleForm(form, `/api/message-drafts/${encodeURIComponent(form.elements.id.value)}/review`, 'Message draft review recorded. Nothing was sent.', () => $('#message-review-dialog').close());
});
$('#credential-form').addEventListener('submit', event => { event.preventDefault(); handleForm(event.currentTarget, '/api/agent-keys', 'Role credential issued. Copy it now; it will not be shown again.', result => {
  const box = $('#credential-secret');
  box.hidden = false;
  box.replaceChildren();
  const strong = document.createElement('strong'); strong.textContent = 'Copy this credential now';
  const secret = document.createElement('p'); secret.textContent = result.secret;
  const note = document.createElement('small'); note.textContent = 'The secret is stored as a hash and cannot be displayed again. Anyone holding it can act within this role’s limits.';
  const actions = document.createElement('div'); actions.className = 'secret-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy credential'; copy.dataset.copySecret = 'true';
  const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = 'Hide'; hide.dataset.hideSecret = 'true';
  actions.append(copy, hide); box.append(strong, secret, note, actions);
}); });
$('#approval-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const dialog = $('#approval-dialog');
  handleForm(form, `/api/approvals/${encodeURIComponent(id)}/decision`, 'Your decision has been recorded.', () => dialog.close());
});
$('#verify-audit').addEventListener('click', async event => {
  try {
    const result = await request('/api/audit/verify');
    const box = $('#audit-result');
    box.hidden = false;
    box.className = `audit-result${result.valid ? '' : ' failed'}`;
    box.textContent = result.valid ? `Audit chain verified · ${result.entries} records · ${result.head ? `head ${result.head.slice(0, 16)}` : 'no records yet'}` : `Audit verification failed at record ${result.broken_entry}`;
    event.currentTarget.textContent = result.valid ? 'Chain verified' : 'Verification failed';
  } catch (error) { notice(error.message, 'error'); }
});
$('#download-backup').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const backup = await request('/api/backup/export');
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href; link.download = `vantage-ars-backup-${new Date().toISOString().replaceAll(':', '-')}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    notice('Verified workspace backup downloaded. Store it securely.');
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#restore-backup').addEventListener('change', async event => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 32 * 1024 * 1024) { notice('Backup file is larger than 32 MB.', 'error'); input.value = ''; return; }
  if (!window.confirm('Restore this backup? It replaces the current workspace data. A local pre-restore recovery copy will be saved first.')) { input.value = ''; return; }
  try {
    const backup = JSON.parse(await file.text());
    const result = await request('/api/backup/restore', { method: 'POST', body: backup });
    notice(`Backup restored. ${result.audit_entries} audit records are present; a pre-restore copy was saved locally.`);
    await loadWorkspace();
  } catch (error) { notice(error.message, 'error'); }
  finally { input.value = ''; }
});
$('#reload').addEventListener('click', loadWorkspace);
$('#sign-out').addEventListener('click', async () => {
  try { await request('/api/logout', { method: 'POST', body: {} }); }
  catch (error) { notice(error.message, 'error'); return; }
  authenticated = false;
  showAuth(true);
});
$('#task-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-task-filter]');
  if (!button) return;
  taskFilter = button.dataset.taskFilter;
  $$('#task-filters [data-task-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderTasks(data.tasks);
});
$('#workspace').addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) { switchView(nav.dataset.view); return; }
  const goto = event.target.closest('[data-goto]');
  if (goto) { switchView(goto.dataset.goto); return; }
  const close = event.target.closest('[data-close]');
  if (close) { $(`#${close.dataset.close}`).close(); return; }
  const approvalButton = event.target.closest('[data-approval]');
  if (approvalButton) {
    const item = data.approvals.find(record => record.id === approvalButton.dataset.approval);
    if (item) approvalDialog(item, approvalButton.dataset.choice);
    return;
  }
  const messageButton = event.target.closest('[data-message-review]');
  if (messageButton) {
    const item = data.messageDrafts.find(record => record.id === messageButton.dataset.messageReview);
    if (item) messageReviewDialog(item, messageButton.dataset.messageStatus);
    return;
  }
  const revoke = event.target.closest('[data-revoke]');
  if (revoke) {
    if (!window.confirm('Revoke this role credential? Any worker using it will lose API access immediately.')) return;
    try { await request(`/api/agent-keys/${encodeURIComponent(revoke.dataset.revoke)}/revoke`, { method: 'POST', body: {} }); notice('Credential revoked.'); await loadWorkspace(); }
    catch (error) { notice(error.message, 'error'); }
    return;
  }
  if (event.target.closest('[data-copy-secret]')) {
    const secret = $('#credential-secret p')?.textContent || '';
    try { await navigator.clipboard.writeText(secret); notice('Credential copied. Store it securely.'); }
    catch { notice('Clipboard access is unavailable. Select and copy the credential manually.', 'error'); }
    return;
  }
  if (event.target.closest('[data-hide-secret]')) $('#credential-secret').hidden = true;
});
$('#workspace').addEventListener('change', async event => {
  const serviceStatus = event.target.closest('[data-service-status]');
  if (serviceStatus) {
    const service = data.services.find(item => item.id === serviceStatus.dataset.serviceStatus);
    if (!service) return;
    try {
      await request(`/api/services/${encodeURIComponent(service.id)}`, { method: 'POST', body: { title: service.title, description: service.description, price_cents: service.price_cents, status: serviceStatus.value } });
      notice('Internal catalogue status updated.'); await loadWorkspace();
    } catch (error) { notice(error.message, 'error'); await loadWorkspace(); }
    return;
  }
  const select = event.target.closest('[data-task-status]');
  if (!select) return;
  try {
    await request(`/api/tasks/${encodeURIComponent(select.dataset.taskStatus)}/status`, { method: 'POST', body: { status: select.value } });
    notice('Task status updated.');
    await loadWorkspace();
  } catch (error) { notice(error.message, 'error'); await loadWorkspace(); }
});
$$('[data-close]').forEach(button => button.addEventListener('click', event => $(`#${event.currentTarget.dataset.close}`).close()));

async function boot() {
  try {
    const state = await request('/api/session');
    setupTokenRequired = state.setup_token_required;
    setupReady = state.setup_ready;
    if (!state.authenticated) { showAuth(state.configured); return; }
    authenticated = true;
    csrf = state.csrf;
    setOwner(state.owner);
    $('#workspace').hidden = false;
    $('#auth-root').hidden = true;
    await loadWorkspace();
  } catch (error) {
    $('#auth-root').hidden = false;
    $('#auth-root').innerHTML = `<section class="auth-card"><div class="auth-brand"><span class="brand-mark">V</span><span><strong>VANTAGE-ARS</strong><small>FOUNDER OFFICE</small></span></div><h1>Workspace unavailable</h1><p>${esc(error.message)}</p><div class="auth-foot">Start the local service and refresh this page.</div></section>`;
  }
}
boot();
