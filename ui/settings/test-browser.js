/* test-browser.js — the one headless Chromium every Settings shot and page test launches (lane dm-settings,
 * 2026-10-08).
 *
 * WHY: every harness hard-coded ms-playwright/chromium-1234, and that build is gone from this machine
 * (removed 2026-10-05), so each one failed with "no chromium at ...". launch() uses that path while it
 * exists and otherwise lets playwright-core pick its own installed build.
 *
 * THEME: MANTLE_THEME=dark|light puts <html data-theme> on every page of every context the browser opens,
 * then fires the 'mantle-theme' event, the way the theme plumbing does in the real window (the dark
 * mode brief's test override). Unset = the page is left alone, so light runs are exactly what they were.
 *
 *   const browser = await require('../test-browser.js').launch(chromium);
 */
'use strict';
const fs = require('fs');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const THEME = /^(dark|light)$/.test(process.env.MANTLE_THEME || '') ? process.env.MANTLE_THEME : null;

/* runs in the page before its own scripts: <html> does not exist yet, so it is set the moment it does */
function applyTheme(theme) {
  const put = () => {
    const el = document.documentElement;
    if (!el || el.dataset.theme === theme) return !!el;
    el.dataset.theme = theme;
    return true;
  };
  if (!put()) {
    const mo = new MutationObserver(() => { if (put()) mo.disconnect(); });
    mo.observe(document, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    put();
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } }));
  });
}

async function themed(ctx) {
  if (THEME) await ctx.addInitScript(applyTheme, THEME);
  return ctx;
}

async function launch(chromium, opts) {
  // lowcpu.js (line 1 of every harness) queues each launch behind the machine-wide one-browser lock for up
  // to 8 minutes; playwright's own 3-minute launch timeout would give up on a queued launch first
  const o = Object.assign({ headless: true, timeout: 9 * 60 * 1000 }, opts || {});
  if (fs.existsSync(CHROME)) o.executablePath = CHROME;
  const browser = await chromium.launch(o);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (co) => themed(await newContext(co));
  browser.newPage = async (co) => {
    const ctx = await browser.newContext(co);
    const page = await ctx.newPage();
    page.close = ((close) => async (...a) => { await close(...a); await ctx.close(); })(page.close.bind(page));
    return page;
  };
  return browser;
}

module.exports = { launch, THEME, CHROME };
