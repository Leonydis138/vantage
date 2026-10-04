#!/data/data/com.termux/files/usr/bin/bash
# Move a Termux Cloudflare Worker project to GitHub with auto-deploy
set -e

REPO_NAME="${1:-$(basename "$PWD")}"
BRANCH="main"

echo "=== 1. Installing git and gh ==="
pkg install -y git gh >/dev/null 2>&1 || true

echo "=== 2. GitHub authentication ==="
if ! gh auth status >/dev/null 2>&1; then
  gh auth login --hostname github.com --git-protocol https --web
fi

echo "=== 3. Initializing local repo ==="
[ -d .git ] || git init -b "$BRANCH"
git add .
git commit -m "Initial commit from Termux" 2>/dev/null || echo "Nothing new to commit"

echo "=== 4. Creating GitHub repository ==="
# Creates under your account; use --org <name> to target an org
if ! gh repo view "$REPO_NAME" >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
else
  git remote get-url origin >/dev/null 2>&1 || \
    git remote add origin "$(gh repo view "$REPO_NAME" --json sshUrl -q .sshUrl)"
  git push -u origin "$BRANCH"
fi

echo "=== 5. Writing GitHub Actions workflow ==="
mkdir -p .github/workflows
cat > .github/workflows/deploy.yml <<'YAML'
name: Deploy Worker

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    name: Deploy
    steps:
      - uses: actions/checkout@v6
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
YAML

git add .github/workflows/deploy.yml
git commit -m "Add GitHub Actions deploy workflow" || true
git push origin "$BRANCH"

echo "=== 6. Setting Cloudflare secrets (optional) ==="
read -rp "Set Cloudflare secrets now? [y/N] " SET_SECRETS
if [[ "$SET_SECRETS" =~ ^[Yy]$ ]]; then
  read -rsp "Cloudflare API Token: " CF_TOKEN; echo
  read -rsp "Cloudflare Account ID: " CF_ACCOUNT; echo
  gh secret set CLOUDFLARE_API_TOKEN --body "$CF_TOKEN"
  gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CF_ACCOUNT"
  echo "Secrets set."
fi

echo
echo "Done. Repo: $(gh repo view --json url -q .url)"
echo "Push to '$BRANCH' triggers a deploy. Watch it under the Actions tab."
