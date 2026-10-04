# Scripts

Automation scripts referenced by `.github/workflows/*`:

- `allocator.py` — **implemented.** Weekly scoring per the formula in `docs/build-spec.md`: `score = revenue_growth_30d*0.5 + traffic_growth_30d*0.3 + conversion_rate*0.2`. Reads/writes `data.json` in place. Growth is computed against the previous run's snapshot (stored in `data.json` → `meta._allocator_prev_snapshot`), so it doesn't need an external analytics call to run. Skips quota/status changes entirely for any branch with zero traffic/clicks/revenue (no real signal yet — avoids punishing a branch just because it hasn't launched). Never sets quota to 0 (floor is 1/week) and never archives — a drop to `Maintenance` status only logs a `kill_recommendation` decision_queue entry for CEO visibility. Run `python3 scripts/allocator.py --dry-run` to preview without writing.
- `check_links.py` — **implemented.** Scans every `branches/*/content/*.md` for outbound links, HEAD/GET-checks each one, and flags broken (4xx/5xx/unreachable) or redirected links as `decision_queue` entries (type `affiliate_program_review`) — batched into one entry per category per run, not one per link. Never edits content and never joins/drops a program itself. Run weekly via `.github/workflows/link-check.yml` (Mondays 07:00 UTC, right after the Allocator), or manually any time.
- `build_site.py` — **implemented.** Renders every content file with frontmatter `status: ready-to-publish` into static HTML under `./public` (one page per file, plus an index), using a single shared template — no framework, no JS build step. Skips anything not marked `ready-to-publish` so a draft never accidentally goes live. Runs on every push to `main` via `.github/workflows/pages-deploy.yml`; the actual Cloudflare Pages publish step stays commented out until `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets exist (`dq_001`).

Test locally any time:
```
python3 scripts/allocator.py --dry-run
python3 scripts/check_links.py --dry-run
python3 scripts/build_site.py --dry-run     # or --all for a local preview ignoring status
```

Both `check_links.py` and `build_site.py` use only the Python standard library plus `markdown` and `pyyaml` (`pip install markdown pyyaml` if running locally outside the GitHub Action, which installs them automatically).
