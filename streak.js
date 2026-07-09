// TikTok streak keeper — sends a single emoji (no text) to each friend in config.json
// via the tiktok.com web DM interface. Friends are @usernames: we open each profile
// and click its Message button, which is sturdier than matching nicknames in the chat list.
// Session comes from exported browser cookies: local cookies.json (testing) or the
// TIKTOK_COOKIES env var (CI).

import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "fs";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const SHOTS = "shots";
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

function loadCookies() {
  let raw;
  if (process.env.TIKTOK_COOKIES) {
    raw = process.env.TIKTOK_COOKIES;
  } else if (existsSync("cookies.json")) {
    raw = readFileSync("cookies.json", "utf8");
  } else {
    console.error("No cookies found. Provide TIKTOK_COOKIES env var or cookies.json");
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.cookies;
  const sameSiteMap = {
    no_restriction: "None",
    lax: "Lax",
    strict: "Strict",
  };
  return list
    .filter((c) => c.domain && c.domain.includes("tiktok"))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: sameSiteMap[String(c.sameSite).toLowerCase()] || "Lax",
    }));
}

async function firstVisible(page, selectors, timeoutEach = 4000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: timeoutEach });
      return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function dismissOverlays(page) {
  // TikTok shows app-promo / notification modals in .TUXModal-overlay that eat clicks
  for (let i = 0; i < 5; i++) {
    const overlay = page.locator(".TUXModal-overlay");
    if (!(await overlay.count())) return;
    const close = page
      .locator(
        '.TUXModal-overlay [aria-label*="lose" i], .TUXModal-overlay [data-e2e="modal-close-inner-button"], .TUXModal-overlay button:has-text("Not now"), .TUXModal-overlay button:has-text("Cancel")'
      )
      .first();
    if (await close.count()) {
      await close.click({ timeout: 3000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape");
    }
    await sleep(1000);
  }
}

async function sendEmoji(page, username, emoji) {
  await page.goto(`https://www.tiktok.com/@${username}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(jitter(2500, 4500));
  await dismissOverlays(page);

  // "Message" button appears on profiles of mutual friends
  const msgBtn = await firstVisible(page, [
    `[data-e2e="message-button"]`,
    `button:has-text("Message")`,
    `a[href*="/messages"]`,
  ]);
  if (!msgBtn) {
    console.error(`✗ ${username}: no Message button on profile (not mutuals? page changed?)`);
    await page.screenshot({ path: `${SHOTS}/no-msgbtn-${username}.png` });
    return false;
  }
  try {
    await msgBtn.click({ timeout: 10000 });
  } catch {
    await dismissOverlays(page);
    await msgBtn.click({ timeout: 10000 });
  }
  await sleep(jitter(2000, 4000));
  await dismissOverlays(page);

  const input = await firstVisible(page, [
    `[data-e2e="message-input-area"] [contenteditable="true"]`,
    `div[contenteditable="true"]`,
  ]);
  if (!input) {
    console.error(`✗ ${username}: message input not found`);
    await page.screenshot({ path: `${SHOTS}/no-input-${username}.png` });
    return false;
  }

  await input.click();
  await sleep(jitter(400, 900));
  await input.type(emoji, { delay: jitter(80, 160) });
  await sleep(jitter(500, 1200));

  const sendBtn = page.locator(`[data-e2e="message-send"]`).first();
  if (await sendBtn.count()) {
    await sendBtn.click();
  } else {
    await input.press("Enter");
  }
  await sleep(jitter(1000, 2000));
  await page.screenshot({ path: `${SHOTS}/sent-${username}.png` });
  console.log(`✓ ${username}: sent ${emoji}`);
  return true;
}

async function main() {
  const cookies = loadCookies();
  console.log(`Loaded ${cookies.length} TikTok cookies`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: process.env.TZ_ID || "UTC",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  let failures = 0;
  try {
    // Sanity check: are we actually logged in?
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(jitter(3000, 5000));
    await dismissOverlays(page);
    if (page.url().includes("/login")) {
      await page.screenshot({ path: `${SHOTS}/logged-out.png` });
      throw new Error(
        "Session expired — TikTok redirected to login. Re-export cookies and update the TIKTOK_COOKIES secret."
      );
    }

    const friends = config.friends.filter((f) => !f.startsWith("friend_username"));
    if (!friends.length) {
      throw new Error("No friends configured. Edit config.json and replace the placeholder usernames.");
    }
    for (const friend of friends) {
      const ok = await sendEmoji(page, friend, config.emoji).catch((e) => {
        console.error(`✗ ${friend}: ${e.message}`);
        return false;
      });
      if (!ok) failures++;
      await sleep(jitter(4000, 12000));
    }
  } catch (err) {
    console.error(err.message);
    await page.screenshot({ path: `${SHOTS}/error-${Date.now()}.png` }).catch(() => {});
    failures++;
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
  console.log("All streaks nudged 🔥");
}

main();
