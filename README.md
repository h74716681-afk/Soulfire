# SOULFIRE ESPORTS — New Codespaces ZIP

Mobile-friendly Free Fire tournament portal with 13 individually illustrated categories, player accounts, separate SOUL COINS wallets, match scheduling, organizer tools, and automatic virtual match-result rewards.

## Run in a new GitHub repository / Codespaces

1. Upload this ZIP to your new repository and extract it into the repository root.
2. Open the Codespaces terminal and run:

```bash
npm install
cp .env.example .env
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('hex')); console.log('ADMIN_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

3. Copy the two generated values into `.env` (replace the placeholder values).
4. Set `WHATSAPP_NUMBER` to your organizer WhatsApp number in international format, digits only, e.g. `91XXXXXXXXXX`.
5. Start the site:

```bash
npm start
```

Open port **3000** from the Codespaces Ports tab.

## What's included

- All 13 categories, each with its own wallpaper and matching circular category avatar/PFP.
- Gmail-based email/password player account, unique player ID, Free Fire UID, profile avatar, and an individual SOUL COINS wallet per player.
- Wallet balance and coin transaction history.
- Buy Coins page links players to the organizer on WhatsApp. The organizer searches by Gmail, player ID, player name, or Free Fire UID and can add or remove virtual coins manually.
- Match scheduling is category-specific. BR Full Map is automatically set to 48 players; 1v1/2v2/3v3/4v4 categories get their matching player capacity.
- BR Full Map: per-kill reward = entry fee − 2; maximum reward pool = (entry fee × 48) − 20. Admin selects 0–48 kills for every registered player. Submit appears only after all registered players have a kill value. If calculated rewards exceed the maximum pool, rewards are proportionally scaled to the cap.
- CS/LW: automatic winning reward per winning player = (entry fee × 2) − 10. Admin selects WIN/LOSE for each registered player. Exactly half the players must be marked winners. Submit appears only after all players are selected.
- Result editor, wallet controls, and all admin actions are protected by the server-side `ADMIN_KEY`.
- Match rewards are credited to each player's own wallet and recorded in transaction history.

## Important real-money restriction

This build keeps real-money coin purchases, cash withdrawals, cash prizes, and paid-entry staking disabled. SOUL COINS in this build are virtual wallet points only. Do not turn on real-money transactions until the exact business model has been reviewed by an Indian gaming-law professional and you have written approval from the relevant payment/banking providers. The software does not verify bank or UPI payments.

## Security

- Never share `.env` or your `ADMIN_KEY`.
- Do not commit `.env`, `data/`, or `node_modules/` to GitHub.
- Back up `data/soulfire.db` regularly. This database stores account and wallet records.
- Never ask players for UPI PINs, OTPs, card PINs, or bank passwords.
