# VANTAGE — How To Run (Plain Guide)

## What this is
An autonomous-ish revenue system. You (CEO) trigger "thinking" runs; mechanical/repetitive work (scoring, formatting, link-checking) can run on a schedule for free via GitHub Actions. Nothing customer-facing sends without your approval.

## One-time human setup (do these before anything else)
1. **Register the domain** (~$10-15/yr) — any registrar, point it at Cloudflare.
2. **Cloudflare account** — free — connect the domain, enable Pages + Workers + Web Analytics.
3. **GitHub account** — free — this repo lives here, Actions run here (2,000 free minutes/month).
4. **Google Search Console** — free — verify the domain once Pages is live.
5. **Bank account** for payouts (Paddle/Stripe will pay out here).
6. **Paddle** (recommended over Stripe for this — handles global VAT/tax automatically) — sign up, complete KYC. This is a real identity/business verification step, no way around it.
7. **Affiliate programs** — Scout will shortlist candidates (Awin, Impact, CJ, direct programs, possibly Amazon Associates SA — check eligibility first). You apply/approve each one from the Decision Queue; some require the KYC/bank info above.

## Running the system day to day
1. Open **Claude Code** (your existing subscription) pointed at this repo.
2. Check the **Decision Queue** in `dashboard/index.html` (open it locally or wherever it's hosted) *before* every run — approve/reject anything waiting.
3. Tell Claude Code which agent(s) to run, e.g.:
   - *"Run Scout for Branch A and Branch B, then update data.json."*
   - *"Run Writer on the next backlog item for Branch A."*
   - *"Run Allocator and Accountant, then Analyst/Reporter for this week's report."*
4. Claude Code reads the relevant `agents/*.md` prompt, does the work, writes files, commits, and pushes.
5. GitHub Actions handles the mechanical stuff on schedule (see `.github/workflows/`) — you don't need to trigger those manually.
6. Review the weekly report (`docs/reports/weekly-<date>.md`) and clear the Decision Queue again.

## Cadence (realistic)
- Daily: quick Decision Queue check (2 min).
- 2-4x/week: a real "thinking" run (Scout, Writer, or a batch of several agents) — 15-45 min of your attention, most of it is Claude Code working, not you typing.
- Weekly: Allocator + Accountant + Analyst/Reporter cycle (mostly automatic, you just review the output).

## What never happens without you
- Joining an affiliate program
- Sending anything to a customer/user
- Archiving a branch or niche
- Any spend beyond the ~$10-15/yr domain and whatever free tiers you've already signed up for

## What this system will not do
- Generate meaningful revenue in week one — it's a compounding content/tooling play.
- File your taxes — Accountant preps summaries, your human accountant files.
- Run with truly zero attention — you're the trigger and the approver, always.
