# Netflix Simon v1.5 — cookie format reports (metadata only)

Upgrade from v1.4 by replacing **only** `api/interactions.js` and `scripts/register-command.js` in GitHub. Keep your current Vercel project, GitHub Actions workflow, Upstash and environment variables.

## Commands (DM and server)

- `/panel` and its **Netflix Free** button: public; continue sending **approved ordinary HTTPS links**, not cookie-derived login tokens.
- `/add name url [description] [tier]`: owner only; add a safe HTTPS link.
- `/upload file`: owner only; accept a `.txt` attachment (128 KB max), inspect *Netscape cookie file formatting only* and save a report to Redis.
- `/stats`: owner only; aggregate stored file-format report counts.
- `/list`: owner only; show links and report IDs.
- `/remove id`: owner only; delete a link or report.

## Important security and functional boundaries

The `/upload` command **does not store the original file or cookie values**, does not contact Netflix, does not test whether a session is LIVE/DEAD, and does not generate login links or NFToken. A syntactically valid, unexpired cookie is **not proof it works**. Only harmless metadata is kept in Redis. The file is still transmitted to Discord as an attachment: **redact session values before uploading**, even for testing. The parser reads attachments in memory then discards their contents. Do not upload account credentials or live session tokens.

Redis keys `netflix-simon:v1.3:links` and `netflix-simon:v1.3:last` remain unchanged; new reports use `netflix-simon:v1.5:cookie-reports`. `PERSONAL_LINKS_JSON` continues as fallback when Redis is not configured, as in v1.4.

## Deploy

1. Commit both source files to your GitHub repository `main` branch.
2. Confirm Vercel redeploys and `https://netflix-simon.vercel.app/api/interactions` shows `version: "1.5"`.
3. Run **GitHub Actions → Register Discord Commands → Run workflow** to register `/upload` and `/stats`.
4. Restart Discord if the slash command cache has not refreshed.
5. Test with a deliberately fake/redacted Netscape-format `.txt` file, then `/stats`, `/list`, `/remove`.

No new secrets required. All management commands enforce `DISCORD_OWNER_ID` inside the API.
