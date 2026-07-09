# TikTok Streak Keeper 🔥

Keep your TikTok streaks alive automatically. Once a day, this sends a single emoji
(no text, just 🔥) to each friend on your list, using GitHub Actions as free hosting.
Nothing runs on your computer. Your PC can be off. It just works.

- **Free.** GitHub's free tier covers this ~30x over.
- **No password needed.** It uses your browser session cookies, stored as an encrypted GitHub secret only you can access.
- **Low-key.** Runs once a day at a randomized time, types with human-like delays, sends one emoji per friend.

## Setup (about 5 minutes)

**1. Fork this repo** (top right). Your fork can stay public or you can make it private, either works.

**2. Add your friends.** Edit `config.json` in your fork and put in your friends'
TikTok @usernames (without the @). You can also change the emoji.

```json
{
  "emoji": "🔥",
  "friends": ["bestie123", "cooldude456"]
}
```

Note: you can only DM mutual friends (you follow each other). Same rule as the app.

**3. Give it your TikTok session:**
   - Install the free [Cookie-Editor](https://cookie-editor.com/) browser extension.
   - Log in at [tiktok.com](https://www.tiktok.com) and check that DMs work in your browser.
   - While on tiktok.com, open Cookie-Editor, hit **Export → JSON** (copies to clipboard).
   - In your fork: **Settings → Secrets and variables → Actions → New repository secret**.
     Name it `TIKTOK_COOKIES`, paste the JSON, save.

**4. Turn it on and test.** Go to the **Actions** tab, enable workflows if GitHub asks,
pick **daily-streak**, and hit **Run workflow**. Wait a minute or two. Green check =
your friends just got the emoji. Red X = open the run and check the logs and the
screenshots artifact to see what happened.

That's it. It now runs every day on its own.

## Picking your send time

The schedule is in `.github/workflows/streak.yml`. Default is 10:00 UTC. If you want
it just after midnight your time (fresh streak day), convert your local 00:15 to UTC
at [crontab.guru](https://crontab.guru) and edit the cron line. Any daily time works,
since one message per calendar day is all a streak needs.

Optional: set a repo variable `TZ_ID` (Settings → Secrets and variables → Actions →
Variables) to your timezone like `Europe/Berlin` so the browser matches where you live.

## Maintenance

Basically none. When TikTok eventually expires your session (typically after weeks or
months), the run fails with "Session expired" and GitHub emails you. Fix: re-export
cookies (step 3) and update the secret. One minute.

Two things to know:
- On public forks, GitHub pauses scheduled workflows after 60 days without repo
  activity. It emails you first, and one click re-enables it. Private forks don't have
  this, but their Actions minutes are limited (still way more than this needs).
- Your friends have to message back for streaks to survive. This keeps *your* half alive.

## Disclaimer

This is an unofficial tool that automates your own account through the regular TikTok
website. That's against TikTok's terms of service, so use it at your own risk. Sending
a few messages a day to real friends is about as low-risk as automation gets, but
nobody can promise TikTok won't ever mind. Your cookies never leave your fork's
encrypted secrets. Don't share them with anyone or paste them anywhere public.

## Local test (optional)

```bash
npm install && npx playwright install chromium
# save your cookie export as cookies.json (gitignored)
node streak.js
```
