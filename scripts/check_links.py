#!/usr/bin/env python3
"""
Affiliate Link Health Check (Affiliate Ops' weekly duty — see agents/affiliate-ops.md).

Scans branches/*/content/*.md for outbound links, checks their HTTP status,
and flags anything broken or redirecting somewhere unexpected. Never edits
content and never joins/removes an affiliate program on its own — a broken
or suspicious link just becomes a decision_queue entry for the CEO.

Usage:
    python3 scripts/check_links.py            # scan + write findings to data.json
    python3 scripts/check_links.py --dry-run   # scan + print findings, write nothing
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data.json"
BRANCHES_DIR = ROOT / "branches"

MD_LINK_RE = re.compile(r'\[[^\]]*\]\((https?://[^)\s]+)\)')
BARE_URL_RE = re.compile(r'(?<![(\[])\bhttps?://[^\s)<>"\']+')

TIMEOUT_SECONDS = 10
USER_AGENT = "VantageLinkCheck/1.0 (+https://github.com/leonydis138/vantage)"


def find_content_files():
    if not BRANCHES_DIR.exists():
        return []
    return sorted(BRANCHES_DIR.glob("*/content/*.md")) + sorted(
        BRANCHES_DIR.glob("*/clusters/*/content/*.md")
    )


def extract_links(text):
    links = set(MD_LINK_RE.findall(text))
    links |= set(BARE_URL_RE.findall(text))
    # strip trailing markdown punctuation that sometimes rides along
    cleaned = set()
    for link in links:
        cleaned.add(link.rstrip(').,;:!?'))
    return cleaned


def check_url(url):
    """Returns (status, final_url, error) — status is an int or None on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return resp.status, resp.geturl(), None
    except urllib.error.HTTPError as e:
        # some servers 405/403 on HEAD but are fine on GET — retry once
        try:
            req_get = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
            with urllib.request.urlopen(req_get, timeout=TIMEOUT_SECONDS) as resp:
                return resp.status, resp.geturl(), None
        except urllib.error.HTTPError as e2:
            return e2.code, url, str(e2)
        except Exception as e2:
            return None, url, str(e2)
    except Exception as e:
        return None, url, str(e)


def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_data(data):
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    dry_run = "--dry-run" in sys.argv

    files = find_content_files()
    if not files:
        print("No content files found under branches/*/content/ — nothing to check.")
        return

    all_findings = []  # list of dicts: file, url, status, final_url, error, category
    checked_count = 0
    broken_count = 0
    redirect_count = 0

    for path in files:
        text = path.read_text(encoding="utf-8")
        links = extract_links(text)
        if not links:
            continue
        rel_path = path.relative_to(ROOT)
        for url in sorted(links):
            checked_count += 1
            status, final_url, error = check_url(url)
            category = "ok"
            if status is None:
                category = "broken"
                broken_count += 1
            elif status >= 400:
                category = "broken"
                broken_count += 1
            elif final_url and final_url.rstrip('/') != url.rstrip('/'):
                category = "redirect"
                redirect_count += 1

            print(f"[{category.upper():8}] {rel_path}: {url} -> status={status} final={final_url}")

            if category != "ok":
                all_findings.append({
                    "file": str(rel_path),
                    "url": url,
                    "status": status,
                    "final_url": final_url,
                    "error": error,
                    "category": category,
                })

    print(f"\nChecked {checked_count} link(s) across {len(files)} file(s). "
          f"{broken_count} broken, {redirect_count} redirected.")

    if not all_findings:
        print("No issues found — nothing added to the decision queue.")
        return

    if dry_run:
        print("\n--dry-run: not writing to data.json.")
        return

    data = load_data()
    data.setdefault("decision_queue", [])
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # one combined entry per run rather than one per broken link, so the
    # queue doesn't get spammed — CEO can drill into activity_feed/logs for detail.
    broken = [f for f in all_findings if f["category"] == "broken"]
    redirected = [f for f in all_findings if f["category"] == "redirect"]

    if broken:
        detail_lines = [f"{f['file']}: {f['url']} (status={f['status']})" for f in broken[:10]]
        more = f" (+{len(broken) - 10} more)" if len(broken) > 10 else ""
        data["decision_queue"].append({
            "id": f"dq_linkcheck_broken_{now.replace(':', '').replace('-', '')}",
            "type": "affiliate_program_review",
            "title": f"{len(broken)} broken affiliate/outbound link(s) found",
            "detail": "; ".join(detail_lines) + more,
            "requires": "ceo_approval",
            "created_at": now,
        })

    if redirected:
        detail_lines = [f"{f['file']}: {f['url']} -> {f['final_url']}" for f in redirected[:10]]
        more = f" (+{len(redirected) - 10} more)" if len(redirected) > 10 else ""
        data["decision_queue"].append({
            "id": f"dq_linkcheck_redirect_{now.replace(':', '').replace('-', '')}",
            "type": "affiliate_program_review",
            "title": f"{len(redirected)} affiliate/outbound link(s) now redirecting",
            "detail": "Redirects can mean a program changed its tracking URL, or was cancelled. "
                      "Worth a manual check before trusting these links still earn commission. "
                      + "; ".join(detail_lines) + more,
            "requires": "ceo_approval",
            "created_at": now,
        })

    data.setdefault("activity_feed", []).insert(0, {
        "timestamp": now,
        "agent": "Affiliate Ops",
        "action": f"Weekly link check: {checked_count} link(s) scanned, "
                  f"{broken_count} broken, {redirect_count} redirected. "
                  f"{'Flagged for CEO review.' if all_findings else 'All clear.'}",
    })
    data["meta"]["generated_at"] = now

    save_data(data)
    print(f"\nWrote {len(broken) + len(redirected)} decision_queue entr{'y' if len(broken)+len(redirected)==1 else 'ies'} to data.json.")


if __name__ == "__main__":
    main()
