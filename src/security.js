import crypto from 'node:crypto';
import { snapshot, transact, id } from './store.js';
import { setting } from './runtime-config.js';

const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const isProduction = () => setting('NODE_ENV') === 'production';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [scheme, saltHex, keyHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/.test(saltHex || '') || !/^[a-f0-9]{128}$/.test(keyHex || '')) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
export function issueSession(owner) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { owner, csrf, expires: Date.now() + SESSION_MS });
  return { sid, csrf };
}
function cookieMap(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const i = part.indexOf('=');
    if (i < 0) return [part, ''];
    try { return [part.slice(0, i), decodeURIComponent(part.slice(i + 1))]; }
    catch { return [part.slice(0, i), '']; }
  }));
}
export function sessionFor(req) {
  const sid = cookieMap(req.headers.cookie).vrs_session;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expires <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}
export function requireCsrf(req) {
  const session = sessionFor(req);
  const token = req.headers['x-csrf-token'];
  if (!session || typeof token !== 'string' || token.length !== session.csrf.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf))) return false;
  return true;
}
export function setSessionCookie(res, sid) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_MS / 1000}`];
  if (isProduction()) flags.push('Secure');
  res.setHeader('set-cookie', `vrs_session=${encodeURIComponent(sid)}; ${flags.join('; ')}`);
}
export function clearSessionCookie(res) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProduction()) flags.push('Secure');
  res.setHeader('set-cookie', `vrs_session=; ${flags.join('; ')}`);
}
export function destroySession(req) {
  const session = sessionFor(req);
  if (session) sessions.delete(session.sid);
}
export function saveOwner({ name, email, passwordHash }) {
  return transact('owner.configured', { email }, draft => {
    if (draft.owner) throw new Error('Owner access has already been configured');
    draft.owner = { id: id('owner'), name, email, password_hash: passwordHash, created_at: new Date().toISOString() };
    return { id: draft.owner.id, name, email };
  });
}
export function ownerSummary() {
  const owner = snapshot().owner;
  return owner ? { id: owner.id, name: owner.name, email: owner.email } : null;
}
export function checkAgentKey(token) {
  if (typeof token !== 'string' || token.length > 256) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const key = snapshot().agentKeys.find(item => !item.revoked_at && item.token_hash === hash);
  return key ? { id: key.id, role: key.role } : null;
}
export function mintAgentKey(role) {
  const secret = `vrs_${role}_${crypto.randomBytes(32).toString('base64url')}`;
  const record = { id: id('key'), role, token_hash: crypto.createHash('sha256').update(secret).digest('hex'), created_at: new Date().toISOString(), revoked_at: null };
  transact('agent.credential.created', { key_id: record.id, role }, draft => {
    draft.agentKeys.unshift(record);
    return record.id;
  });
  return { id: record.id, role, secret, created_at: record.created_at };
}
export function revokeAgentKey(keyId) {
  const found = snapshot().agentKeys.find(item => item.id === keyId && !item.revoked_at);
  if (!found) return null;
  return transact('agent.credential.revoked', { key_id: keyId, role: found.role }, draft => {
    const item = draft.agentKeys.find(key => key.id === keyId);
    item.revoked_at = new Date().toISOString();
    return { id: item.id, role: item.role, revoked_at: item.revoked_at };
  });
}
