# Vantage-ARS

Founder-controlled workspace for the Vantage-ARS business profile and service catalogue, enquiries, department tasks, customer message drafts, founder approvals, scoped role access, decision records, and a hash-linked audit trail. The project uses Node.js 22 and the standard library and starts with no invented business records.

Author: Juan-louw Greyling <juanlouw.greyling@gmail.com>

## Run

```sh
npm start
```

Open `http://127.0.0.1:8080` to view the public services and enquiry page. Open `http://127.0.0.1:8080/office/` to create or sign in to the private owner workspace. The first owner password must be at least 16 characters. The service binds to localhost by default and writes its private data file under `data/` with restrictive file permissions.

`HOST`, `PORT`, and `DATA_DIR` can be set by the operator. Use one server process per data directory. Session cookies are process-local, so a service restart requires signing in again. The application intentionally has no default account or seeded records.

For a production-mode first-owner setup, set a unique `OWNER_SETUP_TOKEN` in the server environment before opening the workspace. The token is required once to create the first owner; remove it from the environment after setup.

## Operating boundary

The workspace enforces department-scoped access for Reception, Marketing, Sales, Finance & Accounting, Technical, Operations, and Administration. The owner configures the real business profile and service catalogue. Marketing cannot move an enquiry into Sales without owner approval. Sales offers, commitments, customer outcomes, customer-risk actions, production changes, and all proposed spending require owner approval. Any positive spend is recorded in ZAR cents.

Message drafts can be created for real enquiries and reviewed by the owner. Reviews do not send messages; there is no delivery endpoint. On Cloudflare the app has Reception and Marketing AI staff (see AI staff below); it has no email, calendar, payment, accounting, hosting, or domain integration. Role credentials authorize scoped API access for external workers. External actions stay unavailable. Approval records document founder decisions but do not send communications, spend money, deploy changes, or post accounting entries. The decision evaluator records governance decisions only and never executes external actions.

The root URL is the new public Vantage-ARS site; `/office/` is the private workspace. The public `POST /api/lead` endpoint accepts URL-encoded website enquiries, applies a process-local IP rate limit and honeypot, records the message as enquiry details, and sends no reply. The form collects an email and details; no automated response or external mail delivery is configured.

## Cloudflare deployment

The root `wrangler.toml` targets the existing `vantage-api` Worker name and routes both `vantage-ars.co.za` and `www.vantage-ars.co.za` to it. Worker static assets serve the public page and office UI. The API runs in a singleton SQLite-backed Durable Object; all workspace updates and audit records are saved transactionally in its private storage. `/office/` remains the owner workspace.

Use Wrangler with a Cloudflare account that has access to the zone and Worker. Deploy the Worker, create a one-time setup secret, then deploy the secret version:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put OWNER_SETUP_TOKEN
```

Enter a unique random value when Wrangler prompts for the secret. After deployment, visit `https://vantage-ars.co.za/office/` and use that value once to create the owner account. Remove the secret with `npx wrangler secret delete OWNER_SETUP_TOKEN` after setup; setup will then remain closed because an owner account already exists. Do not put secrets in `wrangler.toml`, source code, or chat.

This configuration replaces the testing Worker code and its Paddle, Workers AI, and D1 bindings. The app does not currently use Paddle or AI, and its workspace is stored in the Durable Object database. Keep verified JSON backups outside Cloudflare as described below. Cloudflare Workers Free allows 10 ms CPU per request; the current scrypt password hashing is likely to exceed that limit, so use Workers Paid for office account setup and sign-in. The Paid plan currently starts at USD $5/month, with additional usage charges above the included allowances. [Check Cloudflare pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/) before enabling substantial public traffic.

The previous testing `ADMIN_SECRET` is not used by this app. Once the new Worker has deployed, remove that obsolete secret from the `vantage-api` Worker in Cloudflare and rotate any other secrets that were exposed during setup.

## AI staff (Cloudflare Workers AI)

`wrangler.toml` binds Workers AI (`AI`) and runs a cron every 15 minutes. Owners can also press **Run all departments now** on the overview. Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Customer text is passed as untrusted data, and services the AI names must exist in the catalogue. No department sends messages, quotes unlisted prices, spends, deploys, or sets a customer outcome.

- **Reception (AI):** acknowledgement drafts for new enquiries.
- **Marketing (AI):** qualifies against the catalogue, moves the enquiry to marketing review, records a task and decision, and requests your Sales handoff only for a good fit.
- **Sales (AI):** for leads you approved into the Sales queue, moves them to working, adds a next-step task, drafts a follow-up with no prices, and requests a customer-offer approval using catalogue prices.
- **Finance, Technical, Operations, Administration (rule-based):** create tasks from real records: approved spend and new customers, approved production changes and open incidents, overdue tasks and decisions or drafts waiting over 24 hours, customer files and closed-enquiry archiving. Each record is handled once.

Workers AI has a daily free allowance; check Cloudflare pricing before heavy use.

## Optional Docker deployment

The Docker Compose/Caddy setup remains available for a separately hosted Node deployment. It serves both domains from a VPS after DNS points there and ports 80/443 are open. It is not used by the Cloudflare Worker deployment above. For Docker, run `docker compose up -d --build` after setting `OWNER_SETUP_TOKEN` in the deployment environment, configure the owner at `/office/`, and remove the token afterward.

The audit chain detects record edits that do not also rebuild the chain. It is stored on the same machine as the application and is not a write-once audit service or protection against an administrator who can rewrite the data file. The included production configuration supplies HTTPS termination and persistent Docker volumes, but it is not a substitute for monitoring and an independently protected audit store.

Use **Governance & audit → Download verified backup** to export the workspace JSON. It contains customer data and password/credential hashes; protect it like a secret and store a copy on a separate trusted device. Restore accepts only a valid versioned backup for the same owner and a valid audit chain. Before replacing current data, the server writes a mode-restricted pre-restore copy into `DATA_DIR`; restore then appends a restore event to the imported audit chain. Keep separate off-device backups: the pre-restore copy is not protection against loss of the machine or its data directory.

## API

Owner workspace endpoints require an authenticated session and CSRF token for changes. Department endpoints require a scoped bearer credential.

- `GET /api/health`, `GET /api/ready`, `GET /api/session`
- `GET /api/overview`, `/api/leads`, `/api/tasks`, `/api/approvals`, `/api/roles`, `/api/agents`
- `GET /api/business-profile`, `/api/services`, `/api/message-drafts`
- `GET /api/backup/export`, `POST /api/backup/restore` (owner only; restore body maximum 32 MB)
- `POST /api/business-profile`, `POST /api/services`, `POST /api/services/:id`
- `POST /api/lead` (public URL-encoded enquiry intake, served by the Cloudflare Worker)
- `POST /api/leads`, `POST /api/tasks`, `POST /api/message-drafts`, `POST /api/message-drafts/:id/review`, `POST /api/approvals`, `POST /api/approvals/:id/decision`
- `POST /api/agent-keys`, `POST /api/agent-keys/:id/revoke`
- `GET /api/audit`, `GET /api/audit/verify`, `GET /api/constitution`, `GET /api/decisions`
- Scoped department routes under `/api/agent/`, including service/profile reads and customer message draft creation for Reception, Marketing, and Sales
