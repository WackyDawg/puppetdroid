/**
 * Chrome DevTools Protocol (CDP) example.
 *
 * puppetdroid normally drives Android through the accessibility tree over ADB.
 * For Chrome (or any Chromium browser) you can additionally control the
 * *inside* of a tab with real DOM automation — querySelector, evaluate,
 * click, type, navigation — via `page.dom`, which speaks CDP over an
 * auto-forwarded `chrome_devtools_remote` socket.
 *
 * The two layers compose:
 *   • page.dom.*  → inside the web page (CDP / DOM)
 *   • page.*      → Chrome's own UI: omnibox, tabs, permission dialogs
 *                   (ADB / accessibility tree — CDP can't see these)
 *
 * Requires: USB debugging on, and Node >= 21 (built-in WebSocket).
 *
 * Run: node examples/chrome-cdp-example.js
 */
import { Puppetdroid } from '../src/index.js';

async function main() {
    // Launch Chrome straight to a URL and get a CDP-ready DOM handle.
    const { device, page, dom } = await Puppetdroid.launchChrome('https://example.com');

    // ── Inside the page: real DOM automation (CDP) ──
    console.log('URL      :', await dom.url());
    console.log('Title    :', await dom.title());

    const heading = await dom.$('h1');
    console.log('Heading  :', await heading.text());

    const links = await dom.$$('a');
    console.log('Links    :', links.length);
    for (const a of links) console.log('   →', await a.getAttribute('href'));

    // Evaluate arbitrary JS in the page (args are serialized in).
    const ua = await dom.evaluate(() => navigator.userAgent);
    console.log('UA       :', ua);

    // Navigate + interact: fill a form, click a button, wait for a condition.
    await dom.goto('https://duckduckgo.com/');
    await dom.type('input[name="q"]', 'puppetdroid android automation');
    // Prefer dom.click (synthetic, reliable). Use { tap: true } for real touch.
    await dom.click('input[type="submit"], button[type="submit"]').catch(() => {});
    await dom.waitForFunction(() => document.querySelectorAll('a').length > 5, { timeout: 10000 })
        .catch(() => console.log('   (results wait skipped)'));

    // A real page screenshot straight from the renderer (not the device screen).
    await dom.screenshot({ path: 'chrome-page.png' });
    console.log('Saved     chrome-page.png');

    // ── Chrome's native UI still uses the ADB / accessibility path ──
    // e.g. the foreground activity, permission dialogs, the tab switcher:
    console.log('Activity :', await page.title());
    // await page.clickByText('Allow');   // a permission dialog, via accessibility

    await dom.close();          // closes CDP + removes the port forward
    console.log('Done.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Example failed:', err);
    process.exit(1);
});
