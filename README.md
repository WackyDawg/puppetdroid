# Puppetdroid

> **The Puppeteer for Android.** Control real devices with familiar web-automation syntax — plus Chrome/WebView DOM over CDP, live network capture, an AI screen-control agent, and VirtualMaster VM management.

Puppetdroid drives Android through **three layers that compose freely**:

| Layer | Reaches | Backed by |
|---|---|---|
| **Accessibility** (`page.*`, `element.*`) | any app's UI | ADB + `uiautomator` |
| **Chrome DOM** (`page.dom.*`, `page.webview()`) | inside Chrome & debuggable WebViews | Chrome DevTools Protocol |
| **AI vision** (`device.ai()`, `device.agent()`) | anything on screen | screenshot + vision LLM |

```js
import Puppetdroid from 'puppetdroid'

const device = await Puppetdroid.connect()
const page = await device.launch('com.android.settings')

await page.click({ text: 'Network & internet' })
await page.type({ resourceId: 'search_src_text' }, 'wifi')
console.log(await page.getAllText())
```

---

## Requirements

- **Node.js ≥ 18** for the core; **≥ 21** for the CDP and AI layers (they use the global `WebSocket`/`fetch`).
- `adb` on your `PATH`, with **USB debugging** enabled on the device.
- Optional, auto-detected, gracefully skipped when absent: `scrcpy`, `frida`, `mitmdump`, `tesseract`.
- AI features read an API key from the environment (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`). **Keys are never stored by the library.**

## Install

```bash
npm install puppetdroid
```

## Connect

```js
import Puppetdroid from 'puppetdroid'

const device = await Puppetdroid.connect()               // default device
const device = await Puppetdroid.connect('emulator-5554') // by serial / ip:port
const list   = await Puppetdroid.devices()
```

---

## 1 · App automation (accessibility)

```js
const page = await device.launch('com.example.app')

await page.click({ resourceId: 'login_button' })
await page.type({ resourceId: 'email' }, 'me@example.com')
await page.waitForSelector({ text: 'Welcome' })
await page.scroll('down')

const el = await page.$({ text: 'Continue' })
await el.click()
await el.screenshot('continue.png')     // crops the element from a full capture
```

Selectors accept `{ resourceId, text, contains, contentDesc, className }`. `page`
exposes the Puppeteer-style surface: `$`, `$$`, `waitForSelector`, `click`,
`type`, `scroll`, `swipe`, `goBack/goHome`, `getAllText`, and more.

## 2 · Chrome & WebView (CDP)

Real DOM automation inside a Chrome tab or **debuggable** WebView — connects
lazily, auto-forwarding the DevTools socket.

```js
const { page, dom } = await Puppetdroid.launchChrome('https://example.com')
await dom.type('#email', 'me@x.com')
await dom.click('#login')
await page.clickByText('Allow')                       // native dialog (accessibility)
const rows = await dom.$$eval('table tr', els => els.map(r => r.innerText))
await dom.screenshot({ path: 'page.png' })

// Read a debuggable WebView's DOM directly:
const wv = await page.webview('com.some.hybrid.app')
console.log(await wv.title(), await wv.content())
```

`device.readScreen()` reads text from **any** screen, falling back through
accessibility → debuggable WebView (CDP) → OCR:

```js
const { text, method } = await device.readScreen()          // { text, method: 'accessibility' | 'webview-cdp' | ... }
const gms = await device.readScreen({ ocr: 'ai' })          // OCR a locked WebView (needs an API key)
```

## 3 · Network capture (real HTTP/S)

```js
const analysis = await device.networkMonitor.monitorAction(async () => {
  await device.page.dom.goto('https://shop.example.com')
  await device.page.dom.click('#search')
}, { targetDomains: ['example.com'], captureResponses: true })

analysis.data.apiEndpoints    // discovered URLs
analysis.data.requests        // method, url, status, headers, POST data, response bodies
analysis.data.jsonResponses   // decoded JSON
await device.networkMonitor.exportToFile('api.json')
```

Captures real wire traffic (HTTPS decoded, no proxy) for Chrome, Custom Tabs and
debuggable WebViews. Native-only screens fall back to logcat scraping; pass
`package:` to bind capture to one app's WebView.

## 4 · Request interception & mocking

```js
await dom.route('**/api/pricing', route => route.fulfill({ json: { price: 0 } }))
await dom.route('**/track',       route => route.abort())
await dom.block(['*.png', '*/analytics.js'])
```

## 5 · Session, storage, console, emulation, coverage

```js
await dom.cookies();            await dom.setStorage({ token: 'abc' })
await dom.onConsole(e => console.log(e.type, e.text))
await dom.emulateNetwork('slow-3g')
await dom.setGeolocation({ latitude: 6.5244, longitude: 3.3792 })
const cov = await (await dom.startCoverage()).stopCoverage()
```

## 6 · Screenshots, recording, visual diff

```js
await element.screenshot('el.png')                    // native element crop
await domHandle.screenshot('el.png')                  // web element clip (CDP)
await device.startRecording('demo.mp4', { timeLimit: 30 }); await device.recorder.stop()
await device.visualDiff('before.png', 'after.png', { output: 'diff.png' })
```

Powered by a zero-dependency PNG codec (decode / crop / encode / diff).

## 7 · Logcat streaming & assertions

```js
const lc = device.logcat()
lc.on('entry', e => console.log(e.priority, e.tag, e.message))
await lc.start({ priority: 'W', match: /ANR/ })

import { expect } from 'puppetdroid'
await expect(page).toBeVisible({ text: 'Welcome' })
await expect(dom).not.toHaveText('Error')
```

## 8 · AI vision & screen control

```js
const ai = device.ai({ provider: 'gemini' })          // or 'claude' / 'openai' / auto
await ai.ocr()                                         // LLM transcription
await ai.tap('the blue Add to Cart button')            // locate by description → tap
const items = await ai.extract('list every product name and price')

// Goal-driven agent — observes the screen and drives the device:
const result = await device.agent({ provider: 'claude', maxSteps: 15 })
  .run('open Settings and enable Airplane mode')
```

The agent's action space is bounded (`tap`/`type`/`swipe`/`key`/`wait`/`done` —
never shell), with a `maxSteps` cap and a `confirm(action)` veto hook.

## 9 · Native device controls

```js
await device.system.grantAllPermissions('com.some.app')
await device.system.wifi(true); await device.system.airplaneMode(true)
await device.system.getNotifications()
await device.system.wake(); await device.system.unlock('1234')
await device.system.setBrightness(150)
```

## 10 · Security & reverse-engineering

```js
await device.intents.getExportedComponents(pkg)        // attack surface
const crashes = await device.intents.fuzz(pkg)         // malformed-intent fuzzing
await device.frida.bypassSSLPinning(pkg)               // needs frida
const flows = await device.mitmproxy.monitorAction(fn) // native traffic; needs mitmdump + CA
```

## 11 · VirtualMaster VM control

Drive VirtualMaster ("dual space" / clone) VM hosts — start, shut down, restart,
create — and control the guest VMs as their own devices.

```js
const host = await Puppetdroid.connect('1210715446001626')   // the phone running VirtualMaster
const vm = host.virtualMaster({ guestSerial: '192.168.1.105:10000' })

await vm.restart()                       // shutdown → wait → start → wait for boot
const guest = await vm.guestDevice()     // a Puppetdroid device bound to the VM itself
await guest.launch('com.android.chrome')
```

## 12 · Codegen & pixel vision

```js
const rec = device.recordScript(); await rec.start()   // record taps → a Puppetdroid script
const script = rec.stop()

await device.vision.tapText('Checkout')                // offline OCR tap (needs tesseract)
await device.vision.tapImage('button.png')             // template match
```

---

## Examples

Runnable scripts live in [`examples/`](./examples): `chrome-cdp-example.js`,
`api-reverse-engineering.js`, `virtualmaster-control.js`. Full per-method notes
are in [`FEATURES.md`](./FEATURES.md).

## Author

Built by **wackydawg** — <https://github.com/wackydawg>

Issues and PRs welcome at <https://github.com/wackydawg/puppetdroid>.

## License

MIT © wackydawg
