import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.env.DATA_DIR || 'data');
const file = path.join(root, 'vantage-ars.json');
const empty = {
  version: 2,
  owner: null,
  businessProfile: {
    name: 'Vantage-ARS', domain: 'vantage-ars.co.za',
    offering: 'Practical remote support for VoIP, networking, and IT infrastructure, with on-site work by arrangement. Scope, timing, and price are confirmed before work is agreed.',
    target_customers: 'People who run and support real systems.',
    service_area: 'Worldwide remote delivery; on-site work by arrangement.', currency: 'ZAR'
  },
  services: [],
  messageDrafts: [],
  leads: [],
  tasks: [],
  approvals: [],
  agentKeys: [],
  decisions: [],
  incidents: [],
  proposals: [],
  audit: [],
  counters: { decisions: 0, incidents: 0, proposals: 0, services: 0, messageDrafts: 0 }
};

let state = structuredClone(empty);
let persistence = null;

function normalize(loaded) {
  const next = { ...structuredClone(empty), ...(loaded || {}) };
  for (const key of Object.keys(empty)) {
    if (Array.isArray(empty[key]) && !Array.isArray(next[key])) next[key] = [];
  }
  next.counters = { ...empty.counters, ...(next.counters || {}) };
  next.businessProfile = { ...empty.businessProfile, ...(next.businessProfile || {}) };
  next.version = 2;
  return next;
}
function persistFile(next) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(next, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(root, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch {}
}
export function initializeFileStore() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  if (!fs.existsSync(file)) state = structuredClone(empty);
  else {
    if (!fs.lstatSync(file).isFile()) throw new Error('Workspace data path must be a regular file');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    state = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  persistence = { save: persistFile, savePreRestore: current => {
    const preRestore = `${file}.pre-restore-${new Date().toISOString().replaceAll(':', '-')}.json`;
    const fd = fs.openSync(preRestore, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(current)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return path.basename(preRestore);
  } };
}
export function initializeSqliteStore(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_restore_backups (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)');
  const row = sql.exec('SELECT data FROM workspace_state WHERE id = 1').toArray()[0];
  state = normalize(row ? JSON.parse(row.data) : null);
  persistence = {
    save: next => sql.exec('INSERT INTO workspace_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', JSON.stringify(next)),
    savePreRestore: current => {
      const backupId = `restore_${crypto.randomUUID()}`;
      sql.exec('INSERT INTO workspace_restore_backups (id, created_at, data) VALUES (?, ?, ?)', backupId, new Date().toISOString(), JSON.stringify(current));
      return backupId;
    }
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function persist(next) { (persistence?.save || persistFile)(next); }
function makeAudit(draft, type, payload) {
  const entry = {
    id: id('aud'),
    timestamp: new Date().toISOString(),
    type,
    payload: structuredClone(payload),
    previous_hash: draft.audit.at(-1)?.hash ?? null
  };
  entry.hash = digest(entry);
  draft.audit.push(entry);
}

export function transact(type, payload, operation) {
  const draft = structuredClone(state);
  const result = operation(draft);
  makeAudit(draft, type, payload);
  persist(draft);
  state = draft;
  return structuredClone(result);
}
export function snapshot() { return structuredClone(state); }
export function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
export { digest };
export function audit(type, payload) {
  return transact(type, payload, draft => draft.audit.at(-1) || null);
}
export function appendDecision(record) {
  return transact('decision', { decision_id: record.id, status: record.status }, draft => {
    draft.decisions.unshift(record);
    draft.counters.decisions++;
    return record;
  });
}
export function addIncident(incident) {
  return transact('incident.opened', { incident_id: incident.id, severity: incident.severity }, draft => {
    draft.incidents.unshift(incident);
    draft.counters.incidents++;
    return incident;
  });
}
export function resolveIncident(incidentId, outcome) {
  const current = state.incidents.find(x => x.id === incidentId);
  if (!current) return null;
  return transact('incident.resolved', { incident_id: incidentId }, draft => {
    const incident = draft.incidents.find(x => x.id === incidentId);
    Object.assign(incident, outcome, { resolved_at: new Date().toISOString() });
    return incident;
  });
}
export function addProposal(proposal) {
  return transact('constitution.proposal', { proposal_id: proposal.id }, draft => {
    draft.proposals.unshift(proposal);
    draft.counters.proposals++;
    return proposal;
  });
}
export function auditEntries(limit = 100) {
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  return state.audit.slice(-count).reverse().map(entry => ({ ...entry }));
}
export function verifyAudit(source = state) {
  let previous = null;
  for (const entry of source.audit) {
    const copy = { ...entry };
    delete copy.hash;
    if (entry.previous_hash !== previous || digest(copy) !== entry.hash) {
      return { valid: false, broken_entry: entry.id };
    }
    previous = entry.hash;
  }
  return { valid: true, entries: source.audit.length, head: previous };
}

export function restoreWorkspaceBackup(backup, ownerId) {
  if (!backup || backup.format !== 'vantage-ars-backup' || backup.version !== 1 || !backup.workspace || typeof backup.workspace !== 'object') {
    throw new Error('This is not a supported Vantage-ARS backup');
  }
  const restored = structuredClone(backup.workspace);
  if (restored.version !== 2) throw new Error('This backup uses an unsupported workspace version');
  if (!restored.owner || restored.owner.id !== ownerId) throw new Error('The backup must belong to the signed-in owner account');
  const arrays = ['services', 'messageDrafts', 'leads', 'tasks', 'approvals', 'agentKeys', 'decisions', 'incidents', 'proposals', 'audit'];
  if (arrays.some(key => !Array.isArray(restored[key])) || !restored.businessProfile || typeof restored.businessProfile !== 'object' || !restored.counters || typeof restored.counters !== 'object') {
    throw new Error('The backup workspace data is incomplete');
  }
  if (restored.agentKeys.some(key => !key || typeof key.id !== 'string' || !/^[a-f0-9]{64}$/.test(key.token_hash || '') || typeof key.role !== 'string')) {
    throw new Error('The backup contains an invalid role credential record');
  }
  for (const [collection, records] of Object.entries(Object.fromEntries(arrays.filter(key => key !== 'audit').map(key => [key, restored[key]])))) {
    if (records.some(record => !record || typeof record !== 'object' || typeof record.id !== 'string')) throw new Error(`The backup contains an invalid ${collection} record`);
  }
  const leadIds = new Set(restored.leads.map(lead => lead.id));
  if (restored.messageDrafts.some(item => !leadIds.has(item.lead_id)) || restored.approvals.some(item => item.lead_id && !leadIds.has(item.lead_id))) {
    throw new Error('The backup contains a reference to an enquiry that does not exist');
  }
  const auditCheck = verifyAudit(restored);
  if (!auditCheck.valid) throw new Error(`The backup audit chain is invalid at record ${auditCheck.broken_entry}`);
  const current = snapshot();
  const preRestoreCopy = persistence?.savePreRestore
    ? persistence.savePreRestore(current)
    : (() => {
      const preRestore = `${file}.pre-restore-${new Date().toISOString().replaceAll(':', '-')}.json`;
      const backupFd = fs.openSync(preRestore, 'wx', 0o600);
      try { fs.writeFileSync(backupFd, JSON.stringify(current)); fs.fsyncSync(backupFd); }
      finally { fs.closeSync(backupFd); }
      return path.basename(preRestore);
    })();
  makeAudit(restored, 'backup.restored', { restored_by: ownerId, source_audit_head: auditCheck.head, source_audit_entries: auditCheck.entries });
  persist(restored);
  state = restored;
  return { restored_at: restored.audit.at(-1).timestamp, audit_entries: restored.audit.length, pre_restore_copy: preRestoreCopy };
}
