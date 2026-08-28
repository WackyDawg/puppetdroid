/**
 * API reverse-engineering example.
 *
 * Captures real HTTP(S) traffic — URLs, methods, status, headers, POST data
 * and decoded response bodies — while you drive a Chrome tab or a debuggable
 * WebView. Uses the CDP Network domain, so HTTPS is decoded with no proxy /
 * CA certificate. Native (non-WebView) traffic isn't visible to CDP and falls
 * back to best-effort logcat scraping.
 *
 * Run: node examples/api-reverse-engineering.js
 */
import { Puppetdroid } from '../src/index.js';

async function main() {
    const device = await Puppetdroid.connect();

    // Make sure a Chrome tab exists so the DevTools socket is up.
    await device.adb.shell(`am start -a android.intent.action.VIEW -d 'about:blank' com.android.chrome`);
    await device.page.waitForTimeout(2500);

    const analysis = await device.networkMonitor.monitorAction(
        async () => {
            const dom = device.page.dom;
            // A public JSON API to demonstrate body capture.
            await dom.goto('https://jsonplaceholder.typicode.com/');
            await dom.evaluate(async () => {
                await fetch('https://jsonplaceholder.typicode.com/users').then(r => r.json());
                await fetch('https://jsonplaceholder.typicode.com/posts?userId=1').then(r => r.json());
                await fetch('https://jsonplaceholder.typicode.com/comments/1').then(r => r.json());
            });
            await device.page.waitForTimeout(1500);
        },
        {
            targetDomains: ['jsonplaceholder.typicode.com'],
            targetKeywords: ['users', 'posts', 'comments', 'api'],
            captureResponses: true
        }
    );

    console.log('\n── Discovered endpoints ──');
    analysis.data.apiEndpoints.forEach(u => console.log('  •', u));

    console.log('\n── Requests (method / status / type) ──');
    for (const r of analysis.data.requests) {
        console.log(`  ${r.method} ${r.status ?? '-'} [${r.type}] ${r.url}`);
        if (r.responseBody) console.log('     ↳', r.responseBody.replace(/\s+/g, ' ').slice(0, 100));
    }

    console.log(`\nSummary: ${analysis.summary.cdpRequests} requests, ` +
        `${analysis.data.jsonResponses.length} JSON bodies, ` +
        `${analysis.data.domains.length} domain(s)`);

    // Persist the full capture (headers, bodies, timing) for offline analysis.
    const file = await device.networkMonitor.exportToFile('api-analysis.json');
    console.log('Saved', file);

    process.exit(0);
}

main().catch((err) => { console.error('Failed:', err); process.exit(1); });
