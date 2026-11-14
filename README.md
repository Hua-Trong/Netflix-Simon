# Netflix Simon v1.4 — Public Panel, Owner-only Vault

Changes compared to v1.3:

- `/panel`: any user can invoke it in a guild or bot DM.
- Button `🎁 Netflix Free (PC/Phone)`: any user can request a link by DM.
- `/add`, `/remove`, `/list`: only the Discord user ID set in `DISCORD_OWNER_ID` may run them. This is enforced inside the HTTP endpoint even if a command appears to other users.
- All four slash commands are registered for guild (`contexts: [0]`) and bot DM (`contexts: [1]`).
- Upstash Redis keys are unchanged from v1.3: existing entries are preserved.

## Upgrade

1. Replace `api/interactions.js` and `scripts/register-command.js` in the GitHub repository.
2. Commit to `main`. Vercel should deploy the new API automatically.
3. From GitHub Actions run `Register Discord Commands` once again to update slash-command contexts.
4. Verify `DISCORD_OWNER_ID` on Vercel is your Discord account ID, keep `DISCORD_TOKEN`, `UPSTASH_REDIS_REST_TOKEN` private.
5. Test `/panel` and the button from another account, then try `/list` from that account: it should be denied. Test `/add`, `/remove`, `/list` from your account in server and in the bot's DM.

Do not store authentication tokens, cookies, passwords, or restricted Netflix access URLs in the shared vault. Store only ordinary HTTPS links you may distribute. Public links can be given to anyone who clicks the button, including users in other servers where the application is installed.
