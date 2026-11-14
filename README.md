# Netflix Simon v1.3 — Discord managed link vault

A drop-in upgrade for the existing private Discord bot on Vercel. The project processes interactions via HTTP (no permanent Gateway connection required). It stores ordinary, non-sensitive HTTPS links in Upstash Redis.

## What changed

- `/add name:... url:... [description:...] [tier:...]` — owner-only, ephemeral success response; adds a link to Redis.
- `/list` — owner-only, ephemeral listing of item IDs and names (never exposes URLs).
- `/remove id:...` — owner-only, ephemeral deletion.
- `/panel` — owner-only, posts the existing red button. Existing `netflix_simon_get_link_v1` buttons remain compatible.
- Button sends a random link via DM and avoids immediately repeating the last ID when there are 2+ links. This anti-repeat is best-effort, not atomic under simultaneous clicks.
- The `DISCORD_OWNER_ID` check remains in place for **all commands and button interactions**. Server administrators who aren't the owner cannot use the bot even if they install it.

## Update GitHub

Replace these **two** files in your existing repo, preserving exact paths:

1. `api/interactions.js`
2. `scripts/register-command.js`

Other files (e.g. `package.json`, `.github/workflows/register-command.yml`, `vercel.json`) are unchanged. Commit to `main` and verify Vercel has deployed that commit. Health check: `https://netflix-simon.vercel.app/api/interactions` should return `version: 1.3`.

## Create a persistent Upstash Redis database

1. Open https://console.upstash.com/redis and create a Redis database under your Upstash account (check the available pricing/quota before choosing a plan).
2. In the database page, copy the **REST URL** and **REST Token** (not the Readonly Token).
3. In Vercel → netflix-simon → Environment Variables → add the following to Production (and Preview only if you need it):
   - `UPSTASH_REDIS_REST_URL` — e.g. `https://...upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN` — REST token
4. **Redeploy** the Production deployment after changing environment variables.
5. Keep existing `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` and `DISCORD_OWNER_ID`.

`PERSONAL_LINKS_JSON` is still supported **only as fallback when Redis is not configured** (button only). When Redis is configured, it is the sole source of links, so `/list` will initially be empty. Add links with `/add`. You can remove `PERSONAL_LINKS_JSON` after verifying your Redis vault.

**Do not store credentials, cookies, login/session tokens or session-bearing URLs.** The app rejects URL usernames/passwords, fragments and common sensitive query parameter names, but this is not a complete secret scanner. Use only ordinary HTTPS links you own or may share. No Netflix login automation or session creation is included.

## Register global slash commands

After committing, go to the repo's **Actions → Register Discord Commands → Run workflow → main**. Existing GitHub repository secrets must contain:

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`

The updated register script performs a **bulk overwrite of all global application commands** with `/panel`, `/add`, `/remove`, and `/list`. Do not use it if you need to preserve other global commands without first adding them to the script. No `DISCORD_GUILD_ID` is required.

Only Discord administrators can invoke these commands by default (`default_member_permissions: '8'`), and the handler also checks `DISCORD_OWNER_ID`. The owner can grant themselves appropriate permissions on their server.

## Try it

1. Type `/add` and fill `name` and `url` using a harmless URL such as `https://example.com/guide`.
2. Run `/list` to find the ID.
3. Run `/panel` if you need the panel; existing panel buttons also remain usable.
4. Press the button and check your DM.
5. Run `/remove id:<ID from list>` to delete a link.

If a command fails, check **Vercel Logs** for database errors; do not share private tokens or sensitive URLs from logs. Redis and Discord access errors are intentionally logged without full URLs/credentials.

## Notes

- Vercel Functions cannot safely use local files as persistent storage; Redis persists across deployments.
- DB charges/usage are separate from Vercel's limits. Check Upstash's current quota.
- If multiple people press the button at almost exactly the same moment, anti-repeat is not guaranteed.
- Upstash Redis supports commands via HTTP REST with an Authorization bearer token: https://upstash.com/docs/redis/features/restapi
