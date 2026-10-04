#!/usr/bin/env python3
"""
Static site builder for VANTAGE (Build Order step 2 dependency).

Renders every branches/*/content/*.md file whose frontmatter status is
"ready-to-publish" into a static HTML page under ./public, ready for the
Cloudflare Pages deploy step in .github/workflows/pages-deploy.yml.

Deliberately simple: no framework, no JS build step, one template. Content
authoring stays in Markdown + frontmatter; this script never edits content,
it only renders it.

Usage:
    python3 scripts/build_site.py             # render ready-to-publish content to ./public
    python3 scripts/build_site.py --dry-run    # list what would be rendered, write nothing
    python3 scripts/build_site.py --all        # render everything regardless of status (local preview)
"""
import re
import sys
import shutil
from datetime import datetime, timezone
from pathlib import Path

try:
    import markdown as md_lib
except ImportError:
    md_lib = None

try:
    import yaml
except ImportError:
    yaml = None

ROOT = Path(__file__).resolve().parent.parent
BRANCHES_DIR = ROOT / "branches"
PUBLIC_DIR = ROOT / "public"
SITE_TITLE = "VANTAGE"

FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---\s*\n(.*)$', re.S)

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title} | {site_title}</title>
<meta name="description" content="{description}" />
<style>
  :root{{ --bg:#0b0f16; --panel:#121826; --text:#e7edf5; --text-dim:#8fa0b8; --accent:#2dd4ff; }}
  *{{box-sizing:border-box;}}
  body{{margin:0; font-family:Georgia,'Times New Roman',serif; background:var(--bg); color:var(--text); line-height:1.65;}}
  .wrap{{max-width:720px; margin:0 auto; padding:48px 24px 96px;}}
  a{{color:var(--accent);}}
  h1{{font-family:system-ui,sans-serif; font-size:34px; line-height:1.25; margin-bottom:8px;}}
  h2{{font-family:system-ui,sans-serif; font-size:24px; margin-top:40px;}}
  h3{{font-family:system-ui,sans-serif; font-size:19px; margin-top:28px;}}
  .meta{{font-family:system-ui,sans-serif; color:var(--text-dim); font-size:13px; margin-bottom:36px;}}
  code{{background:var(--panel); padding:2px 6px; border-radius:4px; font-size:0.9em;}}
  pre{{background:var(--panel); padding:16px; border-radius:8px; overflow-x:auto;}}
  .site-nav{{font-family:system-ui,sans-serif; padding:20px 24px; border-bottom:1px solid #1c2b45;}}
  .site-nav a{{text-decoration:none; font-weight:600;}}
  footer{{font-family:system-ui,sans-serif; color:var(--text-dim); font-size:12px; margin-top:60px; text-align:center;}}
</style>
</head>
<body>
<nav class="site-nav"><a href="/">{site_title}</a></nav>
<div class="wrap">
  <h1>{title}</h1>
  <div class="meta">{meta_line}</div>
  {body}
</div>
<footer>&copy; {year} {site_title}</footer>
</body>
</html>
"""

INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{site_title}</title>
</head>
<body style="font-family:system-ui,sans-serif; max-width:720px; margin:48px auto; padding:0 24px; background:#0b0f16; color:#e7edf5;">
<h1>{site_title}</h1>
<ul>
{items}
</ul>
</body>
</html>
"""


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    return re.sub(r'-+', '-', text).strip('-')


def parse_frontmatter(text):
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_raw, body = m.group(1), m.group(2)
    if yaml:
        try:
            fm = yaml.safe_load(fm_raw) or {}
        except Exception:
            fm = {}
    else:
        # minimal fallback parser: key: "value" or key: value lines
        fm = {}
        for line in fm_raw.splitlines():
            if ':' not in line:
                continue
            k, v = line.split(':', 1)
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm, body


def render_markdown(body):
    if md_lib:
        return md_lib.markdown(body, extensions=['extra', 'sane_lists'])
    # very small fallback: paragraphs only, no real markdown support
    paras = [f"<p>{p.strip()}</p>" for p in body.split("\n\n") if p.strip()]
    return "\n".join(paras)


def find_content_files():
    if not BRANCHES_DIR.exists():
        return []
    return sorted(BRANCHES_DIR.glob("*/content/*.md")) + sorted(
        BRANCHES_DIR.glob("*/clusters/*/content/*.md")
    )


def main():
    dry_run = "--dry-run" in sys.argv
    render_all = "--all" in sys.argv

    files = find_content_files()
    if not files:
        print("No content files found under branches/*/content/ — nothing to build.")
        return

    to_render = []
    skipped = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        fm, body = parse_frontmatter(text)
        status = fm.get("status", "idea")
        if render_all or status == "ready-to-publish":
            to_render.append((path, fm, body))
        else:
            skipped.append((path, status))

    print(f"Found {len(files)} content file(s). {len(to_render)} will render "
          f"({'--all mode' if render_all else 'status == ready-to-publish'}), "
          f"{len(skipped)} skipped.")
    for path, status in skipped:
        print(f"  skip: {path.relative_to(ROOT)} (status={status!r})")

    if not to_render:
        print("\nNothing to render yet. Set frontmatter `status: ready-to-publish` "
              "on a draft once the CEO/Editor has cleared it, or pass --all for a local preview.")
        return

    if dry_run:
        print("\n--dry-run: not writing to ./public.")
        for path, fm, _ in to_render:
            title = fm.get("title", path.stem)
            slug = slugify(fm.get("target_keyword") or title)
            print(f"  would render: {path.relative_to(ROOT)} -> public/{slug}/index.html")
        return

    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    PUBLIC_DIR.mkdir(parents=True)

    index_items = []
    for path, fm, body in to_render:
        title = fm.get("title", path.stem)
        description = fm.get("meta_description", "")
        slug = slugify(fm.get("target_keyword") or title)
        page_dir = PUBLIC_DIR / slug
        page_dir.mkdir(parents=True, exist_ok=True)

        html_body = render_markdown(body)
        word_count = fm.get("word_count", "")
        meta_bits = [b for b in [
            f"{word_count} words" if word_count else None,
            f"branch: {fm.get('branch', '')}" if fm.get('branch') else None,
        ] if b]

        page_html = PAGE_TEMPLATE.format(
            title=title,
            site_title=SITE_TITLE,
            description=description,
            meta_line=" · ".join(meta_bits),
            body=html_body,
            year=datetime.now(timezone.utc).year,
        )
        (page_dir / "index.html").write_text(page_html, encoding="utf-8")
        index_items.append(f'<li><a href="/{slug}/">{title}</a></li>')
        print(f"  wrote: public/{slug}/index.html  (from {path.relative_to(ROOT)})")

    (PUBLIC_DIR / "index.html").write_text(
        INDEX_TEMPLATE.format(site_title=SITE_TITLE, items="\n".join(index_items)),
        encoding="utf-8",
    )
    print(f"\nBuilt {len(to_render)} page(s) + index into ./public.")


if __name__ == "__main__":
    main()
