# Netflix Simon v1.2

This is a drop-in update for the existing Vercel project. Replace only `api/interactions.js` in your GitHub repository. Keep `package.json`, `vercel.json`, and `scripts/register-command.js` unchanged.

## Vercel environment variables

Keep `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_OWNER_ID` as previously configured.

Update `PERSONAL_LINKS_JSON` to a JSON array of your own, non-sensitive HTTPS links:

```json
[
  {
    "name": "Liên kết A",
    "url": "https://example.com/a",
    "description": "Ghi chú cho mục A",
    "tier": "Cá nhân"
  },
  {
    "name": "Liên kết B",
    "url": "https://example.com/b",
    "description": "Ghi chú cho mục B",
    "tier": "Dự phòng"
  }
]
```

The bot chooses an entry at random each time. It does not store secrets, issue Netflix sessions, automate logins, or create expiring links. Do not store passwords, cookies, access tokens, or Netflix session URLs in this variable.

After saving Vercel variables, redeploy the Production deployment. Test the health endpoint at `https://netflix-simon.vercel.app/api/interactions` (should show `version: 1.2`). Run `/panel` again to publish the updated embed, then click the button.

The button ID and command name have not changed. Existing buttons continue to work after redeployment. The owner-only check remains in place.
