import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const COMPOSER = '[data-e2e="message-input-area"]';
const EDITOR = '[role="textbox"][contenteditable="true"]';
const diagnostics = new WeakMap();

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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid cookie JSON; values omitted.");
  }
  const list = Array.isArray(parsed) ? parsed : parsed.cookies;
  if (!Array.isArray(list)) throw new Error("Cookie export must contain an array.");
  const sameSiteMap = {
    no_restriction: "None",
    lax: "Lax",
    strict: "Strict",
  };
  return list
    .filter((c) => c.domain && /(^|\.)tiktok\.com$/i.test(c.domain.replace(/^\./, "")))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: Number.isFinite(c.expirationDate ?? c.expires)
        ? Math.floor(c.expirationDate ?? c.expires)
        : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: sameSiteMap[String(c.sameSite).toLowerCase()] || "Lax",
    }));
}

class BotFailure extends Error {
  constructor(code, stage, state) {
    super(code);
    this.code = code;
    this.stage = stage;
    this.state = state;
    this.submissionAttempted = false;
  }
}

function observePage(page) {
  const counts = { httpErrors: {}, failedRequests: 0, pendingRequests: 0, scriptErrors: 0 };
  diagnostics.set(page, counts);
  const pending = new Set();
  const relevant = (request) => ["document", "script", "xhr", "fetch"].includes(request.resourceType());
  page.on("request", (request) => {
    if (relevant(request)) pending.add(request);
    counts.pendingRequests = pending.size;
  });
  page.on("requestfinished", (request) => {
    pending.delete(request);
    counts.pendingRequests = pending.size;
  });
  page.on("requestfailed", (request) => {
    if (relevant(request)) counts.failedRequests++;
    pending.delete(request);
    counts.pendingRequests = pending.size;
  });
  page.on("response", (response) => {
    if (relevant(response.request()) && response.status() >= 400) {
      counts.httpErrors[response.status()] = (counts.httpErrors[response.status()] || 0) + 1;
    }
  });
  page.on("pageerror", () => counts.scriptErrors++);
}

async function readState(page) {
  const state = await page.evaluate(({ composer, editor }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visibleNodes = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    const areas = visibleNodes(composer);
    const editors = areas.flatMap((area) => [area, ...area.querySelectorAll(editor)])
      .filter((element) => element.matches(editor) && visible(element));
    const controls = visibleNodes('[role="alert"], [role="dialog"], #loginContainer, [class*="TUXToastProvider"], [data-e2e="dm-new-chat-bottom"]');
    const controlText = controls.map((element) => element.innerText || "").join("\n");
    const route = /\/login(?:\/|$)/.test(location.pathname) ? "login"
      : /\/messages(?:\/|$)/.test(location.pathname) ? "messages"
      : /^\/@/.test(location.pathname) ? "profile" : "other";
    return {
      route,
      readyState: document.readyState,
      authenticatedInbox: visibleNodes('[data-e2e="nav-profile"]').length > 0
        && visibleNodes('[data-e2e="dm-new-conversation-list"]').length > 0,
      conversationSelected: visibleNodes('[data-e2e="chat-uniqueid"]').length === 1,
      login: route === "login" || visibleNodes('[data-e2e="top-login-button"], #header-login-button, #top-right-login-button, #top-right-action-bar-login-button, #login-modal-title').length > 0,
      challenge: visibleNodes('iframe[src*="captcha"], iframe[src*="verify"]').length > 0
        || /captcha|verify (?:that )?you(?:'re| are) human|security verification/i.test(controlText),
      restricted: /cannot send|can't send|unable to send|messages? (?:are |is )?disabled|messaging unavailable|message requests? limit/i.test(controlText),
      errorNotice: /something went wrong|try again|failed|couldn.t send/i.test(controlText),
      overlays: visibleNodes('.TUXModal-overlay, [aria-modal="true"]').length,
      composerCount: areas.length,
      editorCount: editors.length,
      editorKinds: editors.map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") === "textbox" ? "textbox" : "other",
        editable: element.getAttribute("contenteditable") === "true",
        disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      })),
      otherEditorCount: visibleNodes('textarea, input[type="text"], [contenteditable]').filter((element) => !element.closest(composer)).length,
      iframeCount: visibleNodes("iframe").length,
    };
  }, { composer: COMPOSER, editor: EDITOR });
  return { ...state, network: diagnostics.get(page) };
}

function stateFailure(state, stage) {
  if (state.challenge) return new BotFailure("security_challenge", stage, state);
  if (state.login) return new BotFailure("authentication_required", stage, state);
  if (state.restricted) return new BotFailure("messaging_restricted", stage, state);
  if (state.errorNotice) return new BotFailure("ui_error_notice", stage, state);
  return null;
}

async function failWithState(page, stage, fallback) {
  const state = await readState(page);
  const failure = stateFailure(state, stage);
  if (failure) throw failure;
  throw new BotFailure(fallback, stage, state);
}

async function waitForState(page, stage, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await readState(page);
    const failure = stateFailure(state, stage);
    if (failure) throw failure;
    if (await predicate(state)) return state;
    await sleep(250);
  }
  return null;
}

async function dismissOverlays(page) {
  const state = await readState(page);
  const failure = stateFailure(state, "overlay");
  if (failure) throw failure;
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

async function openConversation(page, username) {
  await page.goto(`https://www.tiktok.com/@${username}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(jitter(2500, 4500));
  await dismissOverlays(page);

  const profileTitle = page.locator('[data-e2e="user-subtitle"]:visible');
  if (!(await waitForState(page, "profile", async () => await profileTitle.count() === 1))) {
    await failWithState(page, "profile", "profile_identity_unavailable");
  }
  const profileMatches = async () => (await profileTitle.innerText()).trim().replace(/^@/, "").toLowerCase() === username.toLowerCase();
  if (!(await profileMatches())) {
    await failWithState(page, "profile", "profile_target_mismatch");
  }
  const msgBtn = page.locator('[data-e2e="message-button"]:visible');
  if (!(await waitForState(page, "profile", async () => await msgBtn.count() === 1))) {
    await failWithState(page, "profile", "profile_message_control_unavailable");
  }
  let chatPage = page;
  const onPopup = (popup) => {
    chatPage = popup;
    observePage(popup);
  };
  page.on("popup", onPopup);
  try {
    await msgBtn.click({ timeout: 10000 });
    const started = Date.now();
    const deadline = started + 10000;
    let opened = false;
    let retriedNavigation = false;
    while (Date.now() < deadline) {
      const state = await readState(chatPage).catch(() => null);
      if (state) {
        const failure = stateFailure(state, "open_dm");
        if (failure) throw failure;
        if (state.route === "messages" || state.composerCount > 0) {
          opened = true;
          break;
        }
        if (!retriedNavigation && chatPage === page && state.route === "profile"
          && state.readyState === "complete" && Date.now() - started >= 2000 && await profileMatches()) {
          retriedNavigation = true;
          await dismissOverlays(page);
          await msgBtn.click({ timeout: Math.max(1, deadline - Date.now()) });
        }
      }
      await sleep(250);
    }
    if (!opened) await failWithState(chatPage, "open_dm", "dm_navigation_not_observed");
    await dismissOverlays(chatPage);
    const ready = await waitForState(chatPage, "composer", async (state) =>
      state.composerCount === 1 && state.editorCount === 1 && !state.editorKinds[0].disabled
      && await recipientMatches(chatPage, username));
    if (!ready) {
      const state = await readState(chatPage);
      await failWithState(chatPage, "composer", !state.conversationSelected
        ? "dm_conversation_not_selected" : !(await recipientMatches(chatPage, username))
          ? "dm_recipient_mismatch" : "composer_missing_ambiguous_or_unsupported");
    }
    return chatPage;
  } catch (error) {
    const state = await readState(chatPage).catch(() => undefined);
    if (chatPage !== page) await chatPage.close().catch(() => {});
    if (error instanceof BotFailure) throw error;
    throw new BotFailure(error.name === "TimeoutError" ? "navigation_timeout" : "navigation_operation_failed", "open_dm", state);
  } finally {
    page.off("popup", onPopup);
  }
}

async function recipientMatches(page, username) {
  const recipient = page.locator('[data-e2e="chat-uniqueid"]:visible');
  return await recipient.count() === 1
    && (await recipient.innerText()).trim().replace(/^@/, "").toLowerCase() === username.toLowerCase();
}

async function outgoingEmojiCount(page, emoji) {
  return page.locator('[data-e2e="dm-new-message-list"] [data-e2e="dm-new-chat-item"]').evaluateAll((items, expected) =>
    items.filter((item) => {
      const row = item.querySelector('[data-area="Actions"]');
      return row && getComputedStyle(row).flexDirection === "row-reverse"
        && item.innerText.trim() === expected.trim()
        && ![...item.querySelectorAll('[data-e2e="dm-warning"]')].some((warning) => warning.innerText.trim());
    }).length, emoji);
}

async function sendEmoji(page, username, emoji) {
  Object.assign(diagnostics.get(page), { httpErrors: {}, failedRequests: 0, scriptErrors: 0 });
  let chatPage = page;
  let verificationPage = page;
  let stage = "open_dm";
  let submissionAttempted = false;
  try {
    chatPage = await openConversation(page, username);
    stage = "compose";
    const ready = await readState(chatPage);
    const input = chatPage.locator(`${COMPOSER} ${EDITOR}:visible`);
    const draft = await input.evaluate((element) => element.value ?? element.innerText ?? "");
    if (draft.trim()) throw new BotFailure("existing_draft_not_overwritten", "compose", ready);
    const before = await outgoingEmojiCount(chatPage, emoji);
    await input.fill(emoji);
    const entered = await input.evaluate((element) => element.value ?? element.innerText ?? "");
    if (entered.trim() !== emoji.trim()) throw new BotFailure("composer_rejected_text", "compose", ready);
    stage = "submit";
    const state = await readState(chatPage);
    const failure = stateFailure(state, "submit");
    if (failure) throw failure;
    if (!(await recipientMatches(chatPage, username))) throw new BotFailure("dm_recipient_mismatch", stage, state);
    const sendBtn = chatPage.locator('[data-e2e="dm-new-send-btn"]:visible');
    if (await sendBtn.count() !== 1 || !(await sendBtn.isEnabled())) {
      await failWithState(chatPage, "submit", "send_control_unavailable");
    }
    submissionAttempted = true;
    await input.press("Enter", { timeout: 10000 });
    stage = "confirmation";
    const appeared = await waitForState(chatPage, stage, async () => {
      const value = await input.evaluate((element) => element.value ?? element.innerText ?? "");
      return !value.trim() && await recipientMatches(chatPage, username)
        && await outgoingEmojiCount(chatPage, emoji) > before;
    });
    if (!appeared) await failWithState(chatPage, stage, "send_unverified_do_not_retry_automatically");
    stage = "persisted_confirmation";
    verificationPage = await openConversation(chatPage, username);
    const persisted = await waitForState(verificationPage, stage, async () =>
      await recipientMatches(verificationPage, username) && await outgoingEmojiCount(verificationPage, emoji) > before);
    if (!persisted) await failWithState(verificationPage, stage, "send_persistence_unverified_do_not_retry_automatically");
    console.log(`✓ ${username}: outgoing emoji persisted after reopening conversation`);
    return true;
  } catch (error) {
    if (error instanceof BotFailure) {
      error.submissionAttempted = submissionAttempted;
      throw error;
    }
    const failure = new BotFailure(submissionAttempted
      ? "send_unverified_do_not_retry_automatically" : "browser_operation_failed", stage,
      await readState(chatPage).catch(() => undefined));
    failure.submissionAttempted = submissionAttempted;
    throw failure;
  } finally {
    if (verificationPage !== page && verificationPage !== chatPage) await verificationPage.close().catch(() => {});
    if (chatPage !== page) await chatPage.close().catch(() => {});
  }
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
  observePage(page);

  let failures = 0;
  try {
    await page.goto("https://www.tiktok.com/messages", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(jitter(3000, 5000));
    await dismissOverlays(page);
    if (!(await waitForState(page, "session_preflight", (state) => state.route === "messages" && state.authenticatedInbox))) {
      await failWithState(page, "session_preflight", "authentication_unconfirmed_or_inbox_ui_unsupported");
    }
    console.log("Authenticated inbox UI observed; each recipient and composer will be checked before sending.");

    const friends = config.friends.filter((f) => !f.startsWith("friend_username"));
    if (!friends.length) {
      throw new Error("No friends configured. Edit config.json and replace the placeholder usernames.");
    }
    for (const friend of friends) {
      const ok = await sendEmoji(page, friend, config.emoji).catch((e) => {
        console.error(JSON.stringify(e instanceof BotFailure
          ? { friend, code: e.code, stage: e.stage, submissionAttempted: e.submissionAttempted, state: e.state }
          : { friend, code: "browser_operation_failed", errorType: e.name === "TimeoutError" ? "timeout" : "error" }));
        return false;
      });
      if (!ok) failures++;
      await sleep(jitter(4000, 12000));
    }
  } catch (err) {
    console.error(JSON.stringify(err instanceof BotFailure
      ? { code: err.code, stage: err.stage, state: err.state }
      : { code: "run_failed", errorType: err.name === "TimeoutError" ? "timeout" : "error" }));
    failures++;
  } finally {
    await browser.close();
  }

  if (failures > 0) process.exit(1);
  console.log("All streaks nudged 🔥");
}

main().catch(() => {
  console.error("Run failed before completion; raw error details omitted.");
  process.exitCode = 1;
});
