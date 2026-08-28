import net from 'net';
import { CDPConnection } from './CDPConnection.js';
import { Interceptor } from './Interceptor.js';

const NETWORK_PROFILES = {
    offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    'slow-3g': { offline: false, latency: 400, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8 },
    'fast-3g': { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
    wifi: { offline: false, latency: 2, downloadThroughput: 30 * 1024 * 1024 / 8, uploadThroughput: 15 * 1024 * 1024 / 8 },
    none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
};

function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** Handle to a live DOM element, backed by a CDP RemoteObject (objectId). */
export class DOMElementHandle {
    constructor(dom, objectId) {
        this.dom = dom;
        this.objectId = objectId;
    }

    /**
     * Run `pageFunction(element, ...args)` in the page. The element is passed as
     * the first argument (Puppeteer convention), not bound to `this`.
     */
    async evaluate(pageFunction, ...args) {
        const decl = `function(...a){ return (${pageFunction.toString()}).apply(null, [this].concat(a)); }`;
        const res = await this.dom._callOn(this.objectId, decl, args, true);
        return res.value;
    }

    /** Synthetic click — dispatched by the engine, so it can't miss or be occluded. */
    async click() {
        await this.dom._callOn(
            this.objectId,
            'function(){ this.scrollIntoView({block:"center",inline:"center"}); this.click(); }',
            [], false
        );
        return this;
    }

    /** Real touch tap at the element's viewport center (Input.dispatchTouchEvent). */
    async tap() {
        await this.scrollIntoView();
        const box = await this.boundingBox();
        if (!box) throw new Error('Element has no bounding box (not visible?)');
        const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
        await this.dom.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
        await this.dom.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return this;
    }

    async type(text, options = {}) {
        await this.focus();
        if (options.clear !== false) {
            await this.evaluate((el) => {
                if ('value' in el) { el.value = ''; }
                else if (el.isContentEditable) { el.textContent = ''; }
            });
        }
        await this.dom.cdp('Input.insertText', { text });
        // Frameworks (React et al.) listen for these rather than the raw keystrokes.
        await this.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return this;
    }

    async fill(text) { return this.type(text, { clear: true }); }

    async focus() {
        await this.evaluate((el) => el.focus());
        return this;
    }

    async text() {
        return this.evaluate((el) => el.innerText ?? el.textContent ?? el.value ?? '');
    }

    async innerHTML() { return this.evaluate((el) => el.innerHTML); }
    async outerHTML() { return this.evaluate((el) => el.outerHTML); }
    async getAttribute(name) { return this.evaluate((el, n) => el.getAttribute(n), name); }
    async getProperty(name) { return this.evaluate((el, n) => el[n], name); }

    async boundingBox() {
        return this.evaluate((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return null;
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
    }

    async isVisible() {
        return this.evaluate((el) => {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
    }

    async scrollIntoView() {
        await this.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
        return this;
    }

    async $(selector) {
        const res = await this.dom._callOn(
            this.objectId, 'function(s){ return this.querySelector(s); }', [selector], false
        );
        if (!res.objectId || res.subtype === 'null') return null;
        return new DOMElementHandle(this.dom, res.objectId);
    }

    /** Screenshot just this element (CDP clip); returns a Buffer, writes `path` if given. */
    async screenshot(path) {
        await this.scrollIntoView();
        const box = await this.boundingBox();
        if (!box) throw new Error('Element has no bounding box');
        const { data } = await this.dom.cdp('Page.captureScreenshot', {
            format: 'png',
            clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
        });
        const buf = Buffer.from(data, 'base64');
        if (path) {
            const { writeFile } = await import('fs/promises');
            await writeFile(path, buf);
        }
        return buf;
    }

    async dispose() {
        await this.dom.cdp('Runtime.releaseObject', { objectId: this.objectId }).catch(() => {});
    }
}

function fnDecl(pageFunction) {
    return typeof pageFunction === 'function' ? pageFunction.toString() : `function(){ return (${pageFunction}); }`;
}

/**
 * The `page.dom` namespace — drives the inside of a Chrome/Chromium tab over
 * CDP (querySelector, evaluate, click, type, navigation). Attaches lazily on
 * first use. Chrome's own chrome (omnibox, tabs, permission dialogs) is outside
 * the render surface and stays on the accessibility-tree API via `page`.
 */
export class ChromeDOM {
    /**
     * @param {Object} [options]
     * @param {string} [options.package]       package whose DevTools socket to use (else auto-detected)
     * @param {string} [options.socket]        explicit DevTools socket name, bypassing detection
     * @param {number} [options.port]          fixed local port (default: a free one)
     * @param {number} [options.socketTimeout] ms to wait for the socket to appear
     * @param {(t:Object)=>boolean} [options.targetFilter] choose a specific target
     */
    constructor(page, options = {}) {
        this.page = page;
        this.device = page.device;
        this._options = { socketTimeout: 10000, ...options };
        this._conn = null;
        this._port = null;
        this._socket = null;
        this._target = null;
    }

    get isConnected() { return !!this._conn && !this._conn._closed; }
    get connection() { return this._conn; }

    async ensureConnected() {
        if (this.isConnected) return this;
        await this._attach();
        return this;
    }

    /**
     * Launch Chrome (opening `url` if given) via ADB, then attach. Needed when
     * Chrome isn't running yet — a bare `page.dom` call requires an open tab for
     * the DevTools socket to exist.
     */
    async launch(url, options = {}) {
        const pkg = this._options.package || 'com.android.chrome';
        const adb = this.device.adb;
        if (url) {
            await adb.shell(`am start -a android.intent.action.VIEW -d '${url}' ${pkg}`);
        } else {
            await adb.startApp(pkg).catch(() => adb.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`));
        }
        await this.device.wait(options.launchWait ?? 2500);
        await this.ensureConnected();
        if (url) {
            const current = await this.url().catch(() => '');
            if (!current || (!current.startsWith(url) && current !== url)) {
                await this.goto(url, options).catch(() => {});
            }
        }
        return this;
    }

    async _attach() {
        const adb = this.device.adb;

        let pkg = this._options.package;
        if (!pkg) {
            const cur = await adb.getCurrentActivity().catch(() => null);
            pkg = cur?.package || null;
        }

        // Chrome only exposes the socket once a tab is live, so poll for it.
        let socket = this._options.socket || null;
        const deadline = Date.now() + this._options.socketTimeout;
        while (!socket && Date.now() < deadline) {
            socket = await adb.findDevtoolsSocket(pkg);
            if (socket) break;
            await new Promise(r => setTimeout(r, 500));
        }
        if (!socket) {
            throw new Error(
                'No Chrome DevTools socket found (chrome_devtools_remote). ' +
                'Open Chrome with a tab and ensure USB debugging is enabled.'
            );
        }
        this._socket = socket;

        const port = this._options.port || await findFreePort();
        await adb.removeForward(port);
        await adb.forward(port, `localabstract:${socket}`);
        this._port = port;

        const pages = (await CDPConnection.list(port)).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (!pages.length) throw new Error('Chrome exposes no page targets (open a tab first)');

        let target;
        if (this._options.targetFilter) {
            target = pages.find(this._options.targetFilter);
            if (!target) throw new Error('No CDP target matched targetFilter');
        } else {
            // Chrome lists the active tab first, and only it answers commands —
            // background tabs are frozen. Never pick by URL scheme.
            target = pages[0];
        }
        this._target = target;
        this._conn = await this._openTarget(target, port);
        return this;
    }

    async _openTarget(target, port) {
        const wsUrl = target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+\//i, `ws://127.0.0.1:${port}/`);
        const conn = new CDPConnection(wsUrl);
        await conn.connect();
        // Foreground first, else a frozen tab won't answer the enables.
        await conn.send('Page.bringToFront', {}, 5000).catch(() => {});
        await conn.send('Page.enable', {}, 5000).catch(() => {});
        await conn.send('DOM.enable', {}, 5000).catch(() => {});
        await conn.send('Runtime.enable', {}, 5000).catch(() => {});
        return conn;
    }

    /** Raw CDP command (auto-connects). */
    async cdp(method, params = {}) {
        await this.ensureConnected();
        return this._conn.send(method, params);
    }

    async _callOn(objectId, functionDeclaration, args = [], returnByValue = true) {
        await this.ensureConnected();
        const { result, exceptionDetails } = await this._conn.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration,
            arguments: args.map(a => ({ value: a })),
            returnByValue,
            awaitPromise: true,
            userGesture: true
        });
        if (exceptionDetails) throw cdpError(exceptionDetails);
        return result;
    }

    async $(selector) {
        await this.ensureConnected();
        const { result } = await this._conn.send('Runtime.evaluate', {
            expression: `document.querySelector(${JSON.stringify(selector)})`,
            returnByValue: false
        });
        if (!result.objectId || result.subtype === 'null') return null;
        return new DOMElementHandle(this, result.objectId);
    }

    async $$(selector) {
        await this.ensureConnected();
        const { result } = await this._conn.send('Runtime.evaluate', {
            expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
            returnByValue: false
        });
        if (!result.objectId) return [];
        const props = await this._conn.send('Runtime.getProperties', {
            objectId: result.objectId, ownProperties: true
        });
        const handles = [];
        for (const p of props.result) {
            if (p.enumerable && p.value && p.value.objectId) {
                handles.push(new DOMElementHandle(this, p.value.objectId));
            }
        }
        await this._conn.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
        return handles;
    }

    async $eval(selector, pageFunction, ...args) {
        const el = await this.$(selector);
        if (!el) throw new Error(`$eval: no element for selector "${selector}"`);
        try { return await el.evaluate(pageFunction, ...args); }
        finally { await el.dispose(); }
    }

    async $$eval(selector, pageFunction, ...args) {
        await this.ensureConnected();
        const expr = `(${fnDecl(pageFunction)}).apply(null, [Array.from(document.querySelectorAll(${JSON.stringify(selector)}))].concat(${JSON.stringify(args)}))`;
        const { result, exceptionDetails } = await this._conn.send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true
        });
        if (exceptionDetails) throw cdpError(exceptionDetails);
        return result.value;
    }

    async evaluate(pageFunction, ...args) {
        await this.ensureConnected();
        const expr = typeof pageFunction === 'function'
            ? `(${pageFunction.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`
            : String(pageFunction);
        const { result, exceptionDetails } = await this._conn.send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
        });
        if (exceptionDetails) throw cdpError(exceptionDetails);
        return result.value;
    }

    async waitForSelector(selector, options = {}) {
        const timeout = options.timeout ?? 30000;
        const visible = options.visible === true;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = await this.$(selector);
            if (el) {
                if (!visible || await el.isVisible()) return el;
                await el.dispose();
            }
            await new Promise(r => setTimeout(r, options.polling ?? 100));
        }
        throw new Error(`dom.waitForSelector: "${selector}" not found after ${timeout}ms`);
    }

    async waitForFunction(pageFunction, options = {}, ...args) {
        const timeout = options.timeout ?? 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const val = await this.evaluate(pageFunction, ...args).catch(() => null);
            if (val) return val;
            await new Promise(r => setTimeout(r, options.polling ?? 100));
        }
        throw new Error(`dom.waitForFunction did not become truthy after ${timeout}ms`);
    }

    async click(selector, options = {}) {
        const el = await this.waitForSelector(selector, options);
        try { return await (options.tap ? el.tap() : el.click()); }
        finally { if (options.keepHandle !== true) await el.dispose(); }
    }

    async type(selector, text, options = {}) {
        const el = await this.waitForSelector(selector, options);
        try { return await el.type(text, options); }
        finally { await el.dispose(); }
    }

    async fill(selector, text, options = {}) {
        return this.type(selector, text, { ...options, clear: true });
    }

    async getText(selector) {
        const el = await this.$(selector);
        if (!el) return null;
        try { return await el.text(); } finally { await el.dispose(); }
    }

    async goto(url, options = {}) {
        await this.ensureConnected();
        const waitUntil = options.waitUntil ?? 'load';
        const timeout = options.timeout ?? 30000;
        const loaded = waitUntil === 'none'
            ? Promise.resolve()
            : this._conn.once(waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired', timeout).catch(() => {});
        await this._conn.send('Page.navigate', { url });
        await loaded;
        return this;
    }

    async reload(options = {}) {
        await this.ensureConnected();
        const loaded = this._conn.once('Page.loadEventFired', options.timeout ?? 30000).catch(() => {});
        await this._conn.send('Page.reload', {});
        await loaded;
        return this;
    }

    async url() { return this.evaluate(function () { return document.location.href; }); }
    async title() { return this.evaluate(function () { return document.title; }); }
    async content() { return this.evaluate(function () { return document.documentElement.outerHTML; }); }

    /** Screenshot straight from the renderer; returns a Buffer and optionally writes `options.path`. */
    async screenshot(options = {}) {
        await this.ensureConnected();
        const { data } = await this._conn.send('Page.captureScreenshot', {
            format: options.format ?? 'png',
            ...(options.quality ? { quality: options.quality } : {}),
            captureBeyondViewport: options.fullPage === true
        });
        const buf = Buffer.from(data, 'base64');
        if (options.path) {
            const { writeFile } = await import('fs/promises');
            await writeFile(options.path, buf);
        }
        return buf;
    }

    async targets() {
        if (!this._port && !this._options.port) await this.ensureConnected();
        return (await CDPConnection.list(this._port)).filter(t => t.type === 'page');
    }

    async switchTarget(predicate) {
        const pages = await this.targets();
        const target = pages.find(predicate);
        if (!target) throw new Error('switchTarget: no matching page target');
        if (this._conn) this._conn.close();
        this._conn = await this._openTarget(target, this._port);
        this._target = target;
        return this;
    }

    // ── Request interception (CDP Fetch) ──

    /** Intercept requests matching `pattern` (glob/regex); the handler gets a Route. */
    async route(pattern, handler) {
        await this.ensureConnected();
        if (!this._interceptor) this._interceptor = new Interceptor(this._conn);
        await this._interceptor.route(pattern, handler);
        return this;
    }

    async block(patterns) {
        await this.ensureConnected();
        if (!this._interceptor) this._interceptor = new Interceptor(this._conn);
        await this._interceptor.block(patterns);
        return this;
    }

    async unroute(pattern) {
        if (this._interceptor) await this._interceptor.unroute(pattern);
        return this;
    }

    // ── Cookies & storage ──

    async cookies() {
        return (await this.cdp('Network.getCookies')).cookies;
    }

    async setCookie(cookie) {
        await this.cdp('Network.setCookie', cookie);
        return this;
    }

    async clearCookies() {
        await this.cdp('Network.clearBrowserCookies');
        return this;
    }

    /** Snapshot a web storage area as a plain object. `type`: 'local' | 'session'. */
    async storage(type = 'local') {
        const key = type === 'session' ? 'sessionStorage' : 'localStorage';
        return this.evaluate((k) => {
            const store = window[k], out = {};
            for (let i = 0; i < store.length; i++) { const n = store.key(i); out[n] = store.getItem(n); }
            return out;
        }, key);
    }

    async setStorage(entries, type = 'local') {
        const key = type === 'session' ? 'sessionStorage' : 'localStorage';
        await this.evaluate((k, obj) => {
            for (const [n, v] of Object.entries(obj)) window[k].setItem(n, v);
        }, key, entries);
        return this;
    }

    // ── Console & page errors ──

    /** Stream console output; returns an unsubscribe fn. Each entry: {type,text,args}. */
    async onConsole(cb) {
        await this.cdp('Runtime.enable');
        const handler = (p) => cb({
            type: p.type,
            text: (p.args || []).map(a => a.value ?? a.description ?? '').join(' '),
            args: p.args
        });
        this._conn.on('Runtime.consoleAPICalled', handler);
        return () => this._conn.removeListener('Runtime.consoleAPICalled', handler);
    }

    /** Stream uncaught page exceptions; returns an unsubscribe fn. */
    async onPageError(cb) {
        await this.cdp('Runtime.enable');
        const handler = (p) => cb(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'error');
        this._conn.on('Runtime.exceptionThrown', handler);
        return () => this._conn.removeListener('Runtime.exceptionThrown', handler);
    }

    // ── Emulation ──

    /** Throttle the network. `profile`: 'offline'|'slow-3g'|'fast-3g'|'wifi'|'none' or a raw conditions object. */
    async emulateNetwork(profile) {
        const conditions = typeof profile === 'string' ? NETWORK_PROFILES[profile] : profile;
        if (!conditions) throw new Error(`Unknown network profile: ${profile}`);
        await this.cdp('Network.enable');
        await this.cdp('Network.emulateNetworkConditions', conditions);
        return this;
    }

    async emulateDevice({ width, height, deviceScaleFactor = 3, mobile = true, userAgent } = {}) {
        if (width && height) {
            await this.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
        }
        if (userAgent) await this.cdp('Emulation.setUserAgentOverride', { userAgent });
        return this;
    }

    async setGeolocation({ latitude, longitude, accuracy = 10 }) {
        await this.cdp('Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
        return this;
    }

    async setTimezone(timezoneId) {
        await this.cdp('Emulation.setTimezoneOverride', { timezoneId });
        return this;
    }

    async clearEmulation() {
        await this.cdp('Emulation.clearDeviceMetricsOverride').catch(() => {});
        await this.cdp('Emulation.clearGeolocationOverride').catch(() => {});
        return this;
    }

    // ── Coverage ──

    /** Begin precise JS (and optionally CSS) coverage collection. */
    async startCoverage({ js = true, css = true } = {}) {
        this._coverage = { js, css };
        if (js) {
            await this.cdp('Profiler.enable');
            await this.cdp('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
        }
        if (css) {
            await this.cdp('CSS.enable').catch(() => {});
            await this.cdp('CSS.startRuleUsageTracking').catch(() => {});
        }
        return this;
    }

    /** Stop coverage; returns per-script/stylesheet used-vs-total byte tallies. */
    async stopCoverage() {
        const out = { js: [], css: [] };
        if (this._coverage?.js) {
            const { result } = await this.cdp('Profiler.takePreciseCoverage');
            await this.cdp('Profiler.stopPreciseCoverage').catch(() => {});
            for (const script of result) {
                let used = 0, total = 0;
                for (const fn of script.functions) for (const r of fn.ranges) {
                    const len = r.endOffset - r.startOffset;
                    total = Math.max(total, r.endOffset);
                    if (r.count > 0) used += len;
                }
                out.js.push({ url: script.url, usedBytes: used, totalBytes: total });
            }
        }
        if (this._coverage?.css) {
            const { ruleUsage } = await this.cdp('CSS.stopRuleUsageTracking').catch(() => ({ ruleUsage: [] }));
            out.css = ruleUsage;
        }
        this._coverage = null;
        return out;
    }

    async close({ removeForward = true } = {}) {
        if (this._interceptor) { await this._interceptor.disable().catch(() => {}); this._interceptor = null; }
        if (this._conn) { this._conn.close(); this._conn = null; }
        if (removeForward && this._port) {
            await this.device.adb.removeForward(this._port).catch(() => {});
        }
    }
}

function cdpError(exceptionDetails) {
    const d = exceptionDetails.exception?.description
        || exceptionDetails.exception?.value
        || exceptionDetails.text
        || 'Evaluation failed';
    return new Error(`CDP evaluation error: ${d}`);
}
