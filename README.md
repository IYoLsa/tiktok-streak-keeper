# tiktok streak keeper

sends one emoji a day to your tiktok friends so your streaks don't die. runs on github actions so it's completely free and your pc doesn't need to be on. made this because i kept losing streaks every time i was busy for a day.

no password needed, it uses your browser cookies. they go in an encrypted secret on your own fork, nobody else can see them (including me).

## setup

1. fork this repo
2. edit `config.json`, put your friends usernames in (the @ handles without the @). change the emoji too if you want
3. get your cookies:
   - install the Cookie-Editor extension (chrome or firefox)
   - log into tiktok.com and make sure dms work
   - while on tiktok.com click the extension and hit Export > JSON
   - in your fork: Settings > Secrets and variables > Actions > New repository secret. name it `TIKTOK_COOKIES` and paste
4. go to the Actions tab, enable workflows if it asks, open daily-streak and hit Run workflow to test

if the run goes green, check your dms, the messages are there. if it's red, open the run and look at the logs, there's also screenshots in the artifacts.

that's it, it runs on its own every day now. default time is 10:00 utc, to change it edit the cron line in `.github/workflows/streak.yml` (crontab.guru if you don't speak cron). i run mine right after midnight so the message lands as soon as the new day starts.

## stuff to know

- you can only dm mutuals, same rule as the app
- streaks need both sides to message, this only keeps your half alive, if your friend ghosts the streak dies anyway lol
- cookies expire after a while (weeks or months, depends). the run fails, github emails you, you just export fresh cookies and update the secret. takes a minute
- on public forks github pauses scheduled workflows after 60 days of no repo activity. they email you first and it's one click to re-enable. private forks don't have this
- automating your account is against tiktok tos. realistically a couple messages a day to actual friends is nothing, i've had zero issues, but it's your account and your call

## run it locally

```
npm install
npx playwright install chromium
node streak.js
```

put your cookie export in `cookies.json` first (it's gitignored so you can't accidentally commit it)
