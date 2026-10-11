# Deploy Vantage-ARS to Cloudflare (step by step)

You run these on your own computer, in a terminal. This project cannot deploy itself.

1. Install Node.js 22 or newer from https://nodejs.org (choose the LTS or Current installer).
2. Unzip Vantage-Ars.zip to a folder, e.g. `Vantage-Ars`.
3. Open a terminal in that folder.
   - Windows: open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
   - Mac: right-click the folder, choose "New Terminal at Folder".
4. Run these one at a time:

```
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put OWNER_SETUP_TOKEN
```

   - `wrangler login` opens your browser; sign in to Cloudflare and click Allow.
   - `secret put` asks for a value: type a long random password and press Enter. Keep it; you need it once.
5. Go to https://vantage-ars.co.za/office/ and create the owner account using that token.
6. Afterwards remove the token: `npx wrangler secret delete OWNER_SETUP_TOKEN`
7. The AI staff needs the Workers Paid plan for sign-in hashing (see README). Add real services under Business & services, then press "Run all departments now".

## Deploying from GitHub Actions instead

`.github/workflows/deploy.yml` runs the tests and then deploys on every push to `main`.
In your GitHub repository go to Settings > Secrets and variables > Actions and add:

- `CLOUDFLARE_API_TOKEN`: create at dash.cloudflare.com > My Profile > API Tokens > "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers & Pages overview page.

Never commit `data/vantage-ars.json`, `.env`, or any text file containing keys or credentials.
The owner setup token is set once in Cloudflare (`npx wrangler secret put OWNER_SETUP_TOKEN`), not in GitHub.
