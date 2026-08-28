# Puppetdroid — Features & Capabilities

Puppetdroid is *Puppeteer for Android*. It drives real devices through three layers
that compose freely:

| Layer | Reaches | Backed by |
|---|---|---|
| **Accessibility** (`page.*`, `element.*`) | any app's UI tree | ADB + `uiautomator` |
| **Chrome DOM** (`page.dom.*`) | inside Chrome/WebView tabs | Chrome DevTools Protocol |
| **AI vision** (`device.ai()`, `device.agent()`) | anything on screen | screenshot + vision LLM |

Everything below is additive to the original accessibility API.

### Requirements

- **Node ≥ 21** (the CDP and AI layers use the global `WebSocket`/`fetch`).
- `adb` on `PATH`, USB debugging enabled.
- Optional external tools, each auto-detected and gracefully skipped if absent:
  `frida`, `mitmdump`, `tesseract`.
- AI features need an API key in the environment (`GEMINI_API_KEY`,
  `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`). No keys are stored in the library.

---

## 1. Chrome / WebView automation — `page.dom`

Real DOM automation inside a Chrome tab or debuggable WebView over CDP. Connects
lazily on first use (auto-forwards `chrome_devtools_remote` to a free port,
attaches to the active tab). Chrome's own chrome — omnibox, tabs, permission
dialogs — stays on the accessibility API via `page.*`.

```js
const { page, dom } = await Puppetdroid.launchChrome('https://example.com');
await dom.type('#email', 'me@x.com');
await dom.click('#login');
await page.clickByText('Allow');            // native permission dialog (accessibility)
await dom.waitForSelector('.dashboard', { visible: true });
```

| Method | Purpose |
|---|---|
| `dom.goto(url, {waitUntil, timeout})` / `reload()` | navigate the tab |
| `dom.$(sel)` / `dom.$$(sel)` | querySelector / All → element handle(s) |
| `dom.$eval(sel, fn, …)` / `dom.$$eval(sel, fn, …)` | run fn(el[, args]) in page |
| `dom.evaluate(fn, …args)` | run arbitrary JS, returns a JSON value |
| `dom.click(sel, {tap})` / `type(sel, text)` / `fill(sel, text)` | interact (waits) |
| `dom.waitForSelector(sel, {visible})` / `waitForFunction(fn)` | waits |
| `dom.getText(sel)` / `title()` / `url()` / `content()` | read |
| `dom.screenshot({path, fullPage})` | renderer screenshot (Buffer) |
| `dom.targets()` / `switchTarget(pred)` | multi-tab control |
| `dom.close()` | drop the connection + forward |

**Element handles** (`DOMElementHandle`): `click()` (synthetic), `tap()` (real
touch), `type(text)`, `fill(text)`, `text()`, `getAttribute()`, `boundingBox()`,
`isVisible()`, `scrollIntoView()`, `$(sel)`, `screenshot(path)`, `evaluate(fn)`.

> Convention: `element.evaluate((el, ...args) => …)` receives the element as the
> first argument (Puppeteer-style), not as `this`.

---

## 2. Network capture — real HTTP(S)

Captures actual wire traffic (HTTPS decoded, no proxy) off the CDP Network domain
for Chrome tabs, Chrome Custom Tabs, and debuggable WebViews. Native-only screens
(OkHttp with no WebView) fall back to best-effort logcat scraping.

```js
const analysis = await device.networkMonitor.monitorAction(async () => {
  const dom = device.page.dom;
  await dom.goto('https://shop.example.com');
  await dom.click('#search');
}, { targetDomains: ['example.com'], captureResponses: true });

analysis.data.apiEndpoints;    // discovered URLs
analysis.data.requests;        // structured: method, url, status, headers, bodies
analysis.data.jsonResponses;   // decoded JSON bodies
await device.networkMonitor.exportToFile('api.json');
```

Each request record: `method, url, status, mimeType, requestHeaders,
responseHeaders, postData, responseBody, type, remoteAddress`, timing. Filter
with `targetDomains` / `ignoreDomains` / `targetKeywords` / `ignoreKeywords`.
Pass `package:` to bind capture to a specific app's WebView only.

---

## 3. Request interception & mocking — `dom.route`

Block, redirect, mock, or mutate requests via the CDP Fetch domain (first
matching rule wins; unmatched requests pass through).

```js
await dom.route('**/api/pricing', route => route.fulfill({ json: { price: 0 } }));
await dom.route('**/track',       route => route.abort());
await dom.block(['*.png', '*/analytics.js']);
await dom.unroute('**/api/pricing');
```

`Route`: `continue({url, method, headers, postData})`, `fulfill({status,
headers, body, json})`, `abort(reason)`, plus `route.request`. Cross-origin mocks
need an `access-control-allow-origin` header.

---

## 4. Session, storage, console, emulation, coverage — `page.dom`

```js
await dom.cookies();                          // Network.getCookies
await dom.setCookie({ url, name, value });
await dom.storage('local');                   // localStorage → object
await dom.setStorage({ token: 'abc' }, 'local');

const off = await dom.onConsole(e => console.log(e.type, e.text));
await dom.onPageError(err => console.log(err));

await dom.emulateNetwork('slow-3g');          // offline | slow-3g | fast-3g | wifi | none
await dom.emulateDevice({ width, height, userAgent });
await dom.setGeolocation({ latitude, longitude });
await dom.setTimezone('Africa/Lagos');

await dom.startCoverage({ js: true, css: true });
// … exercise the page …
const cov = await dom.stopCoverage();         // per-script used/total bytes
```

---

## 5. Screenshots, recording, visual diff

```js
await element.screenshot('el.png');           // native: crops a full-screen capture
await domHandle.screenshot('el.png');         // web: CDP element clip
const img = await device.captureImage();      // decoded { width, height, data(RGBA) }

const rec = device.recorder;                  // (or device.startRecording(...))
await device.startRecording('demo.mp4', { timeLimit: 30, bitRate: 4000000 });
await device.recorder.stop();                 // pulls the mp4

await device.visualDiff('before.png', 'after.png', { output: 'diff.png' });
// → { diffCount, diffRatio, sizeMismatch }; diff.png highlights changes in red
```

Backed by a zero-dependency PNG codec (`utils/png.js`: decode/encode/crop/diff,
8-bit RGB/RGBA). Screen recording uses `screenrecord` (mp4, ~180s cap, killed with
SIGINT so the file finalizes).

---

## 6. Logcat streaming — `device.logcat()`

A real streamed `adb logcat` pipe (not polling), parsed into structured entries.

```js
const lc = device.logcat();
lc.on('entry', e => console.log(e.priority, e.tag, e.message));
lc.on('match', e => …);                       // when options.match matches
await lc.start({ priority: 'W', tags: ['ActivityManager'], match: /ANR/ });
// or, one-shot:
const entries = await device.logcat().collect(3000, { priority: 'I' });
```

Entry: `{ time, pid, tid, priority, tag, message }`.

---

## 7. Assertions — `expect`

Auto-retrying (web-first) assertions over a `Page` or `ChromeDOM`.

```js
import { expect } from 'puppetdroid';
await expect(page).toHaveElement({ resourceId: 'login' });
await expect(page).toBeVisible({ text: 'Welcome' });
await expect(dom, { timeout: 8000 }).toHaveTitle('Dashboard');
await expect(dom).not.toHaveText('Error');
```

Matchers: `toHaveElement`, `toBeVisible`, `toHaveText(sel?, text)`,
`toHaveTitle`, `toHaveURL`; each supports `.not`.

---

## 8. AI vision & control

### Providers
`createProvider('gemini' | 'claude' | 'openai', { apiKey?, model? })`, or auto-detect
from whichever key is in the environment. One interface:
`complete({ prompt, image, json, maxTokens })`. Keys are never stored.

### `device.ai()` — vision OCR, locate, extract

```js
const ai = device.ai({ provider: 'gemini' });
await ai.ocr();                               // LLM transcription of the screen
await ai.tap('the blue Add to Cart button');  // locate by description → tap
await ai.type('the search field', 'headphones');
const rows = await ai.extract('list every product name and price');
await ai.ask('is there an error dialog?');
await ai.exists('a captcha');
```

Coordinates are returned in device pixels (screencap == `input tap` space), so
taps land 1:1. Best for canvas/game/video UI not in the accessibility tree, or
human-style instructions.

### `device.agent()` — goal-driven screen control

```js
const result = await device.agent({ provider: 'claude', maxSteps: 15 })
  .run('open Settings and enable Airplane mode');
// { success, summary, steps }
```

Loop: screenshot → LLM picks one action → execute → repeat until `done`.
**Guardrails:** bounded mechanical action space (`tap`/`type`/`swipe`/`key`/
`wait`/`done` — never shell), `maxSteps` cap, `onStep(cb)` telemetry, and a
`confirm(action)` hook that can veto any step.

---

## 9. Native device controls — `device.system`

```js
await device.system.grantAllPermissions('com.some.app');   // returns granted list
await device.system.grantPermission(pkg, 'android.permission.CAMERA');
await device.system.wifi(true); await device.system.mobileData(false);
await device.system.airplaneMode(true); await device.system.bluetooth(false);
await device.system.getNotifications();                    // [{ pkg, title, text }]
await device.system.clearNotifications();
await device.system.wake(); await device.system.unlock('1234');
await device.system.setBrightness(150);
await device.system.isScreenOn();
```

(These sit alongside the existing `device.enableWifi/getBatteryLevel/installApp/…`.)

---

## 10. Security / reverse-engineering

### Intents & deep links — `device.intents`
```js
await device.intents.getExportedComponents(pkg);   // { activities, services, receivers, providers }
await device.intents.openDeepLink('myapp://path', pkg);
await device.intents.send({ component, action, data, extras, target: 'activity' });
const crashes = await device.intents.fuzz(pkg);     // fires malformed intents, reports FATAL crashes
```

### Frida — `device.frida`
```js
await device.frida.isAvailable();                   // needs `frida` on PATH + frida-server/gadget
const h = await device.frida.attach(pkg, scriptSource);   // or .spawn(pkg, src)
await device.frida.bypassSSLPinning(pkg);           // stock OkHttp/TrustManager bypass
h.stop();
```

### mitmproxy (native traffic) — `device.mitmproxy`
```js
const flows = await device.mitmproxy.monitorAction(async () => {
  await device.launch('com.some.native.app');
  // … drive via accessibility …
}, { port: 8080 });
// each flow: { method, url, status, reqHeaders, resHeaders, reqBody, resBody }
```
Routes device traffic through `adb reverse` (no LAN IP needed). Sees native
OkHttp/HttpURLConnection traffic CDP can't. Needs `mitmdump` on PATH and the
mitmproxy CA trusted on the device; can't defeat cert pinning (pair with
`frida.bypassSSLPinning`).

---

## 11. Vision fallback (pixel) — `device.vision`

Non-AI, offline fallbacks for UI not in the accessibility tree.

```js
await device.vision.isOcrAvailable();               // needs `tesseract`
await device.vision.tapText('Checkout');            // OCR → tap
const box = await device.vision.findText('Total');  // { text, x, y, centerX, … }
await device.vision.tapImage('button.png');         // downsampled template match
```

---

## 12. Codegen recorder — `device.recordScript()`

Records touches via `getevent` and emits a runnable puppetdroid script, preferring
stable selectors (resource-id → text → content-desc) with a coordinate fallback.

```js
const rec = device.recordScript();
await rec.start();
// … tap around the device by hand …
const script = rec.stop();                          // string of puppetdroid code
```

Captures taps and long-presses; text entry and swipes are approximated. Treat the
output as a strong first draft.

---

## Verification status

| Area | Status |
|---|---|
| Chrome DOM, network capture, interception, cookies/storage/console/emulation/coverage | ✅ verified on device |
| Element/DOM screenshots, visual diff, PNG codec, recording, logcat streaming, assertions | ✅ verified on device |
| `system.*` permissions/notifications/screen/brightness, `intents.getExportedComponents` | ✅ verified on device |
| AI pipeline (locate/tap/extract, agent loop) | ✅ verified with a mock provider (real LLM call needs your key) |
| Frida / mitmproxy / tesseract-OCR / codegen | ⚙️ built + dependency-gated (need the external tool / live target to exercise) |
