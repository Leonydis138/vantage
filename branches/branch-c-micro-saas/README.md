# Branch C — Micro-SaaS

First tool: VoIP bandwidth / subnet / SLA calculator. Free to use, Paddle/Stripe-gated Pro upgrade, plus affiliate placements for relevant hardware/hosting.

## Status
`Maintenance` — not yet built. See Build Order step 4.

## Structure (once built)
```
frontend/     static calculator UI
worker/       Cloudflare Worker backend (100k req/day free tier)
README.md     deploy notes, live URL, Paddle product IDs
```

## Planned free vs. pro split
- **Free:** full calculator functionality, no login.
- **Pro (Paddle/Stripe):** saved calculations, PDF export, bulk/batch mode — final list TBD with CEO.

## Dependencies
- Paddle/Stripe KYC completed (human-only step).
- Cloudflare Worker route configured.
