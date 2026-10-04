import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { server, registerStaffRunner } from './src/server.js';
import { runStaff } from './src/staff.js';
import { initializeSqliteStore } from './src/store.js';
import { setRuntimeBindings } from './src/runtime-config.js';

const nodePort = 8080;
server.listen(nodePort);
registerStaffRunner(runStaff);

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

function secure(response, pathname) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  if (pathname === '/autonomous-office.html') headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'sha256-HlsC6U586bjxDsHd6uGG1h2ZLTlx6gqtf9yhGYVrRdc='; style-src 'self' 'sha256-0/CWAZ1ia+1j6CYGRI7mhDcv4FtFXRQnuQPb88LNPsM='; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (pathname === '/' || pathname === '/office/' || pathname === '/office' || pathname.endsWith('.html')) headers.set('cache-control', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export class VantageWorkspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeSqliteStore(ctx.storage.sql);
    setRuntimeBindings(env);
  }

  async fetch(request) {
    return handleAsNodeRequest(nodePort, request);
  }

  async runStaff(trigger) {
    return runStaff(trigger);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName('vantage-ars-workspace'));
    ctx.waitUntil(stub.runStaff('schedule'));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.WORKSPACE.idFromName('vantage-ars-workspace');
      return env.WORKSPACE.get(id).fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    if (url.pathname === '/' || url.pathname === '/index.html') url.pathname = '/site.html';
    else if (url.pathname === '/office' || url.pathname === '/office/') url.pathname = '/index.html';
    const assetRequest = new Request(url, { method: request.method, headers: request.headers });
    return secure(await env.ASSETS.fetch(assetRequest), new URL(request.url).pathname);
  }
};
