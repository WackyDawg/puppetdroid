import { spawn } from 'child_process';
import { writeFile, readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// mitmdump addon: append each response flow to a JSONL file. Kept inline so the
// feature is self-contained — no companion file to ship.
const ADDON = (outPath) => `
import json
from mitmproxy import http
def response(flow: http.HTTPFlow):
    try:
        body = flow.response.get_text(strict=False) if flow.response else None
    except Exception:
        body = None
    rec = {
        "method": flow.request.method, "url": flow.request.pretty_url,
        "status": flow.response.status_code if flow.response else None,
        "reqHeaders": dict(flow.request.headers), "resHeaders": dict(flow.response.headers) if flow.response else {},
        "reqBody": flow.request.get_text(strict=False), "resBody": body,
    }
    with open(${JSON.stringify(outPath)}, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\\n")
`;

/**
 * Full HTTP(S) capture for native apps via a mitmproxy man-in-the-middle. Routes
 * device traffic over `adb reverse` (so no LAN IP juggling) and parses mitmdump's
 * flows. Sees traffic CDP can't (native OkHttp/HttpURLConnection) but needs
 * `mitmdump` on PATH, the mitmproxy CA trusted on the device, and it can't defeat
 * certificate pinning (pair with Frida.bypassSSLPinning for that).
 */
export class Mitmproxy {
    constructor(device, options = {}) {
        this.device = device;
        this.binary = options.binary || 'mitmdump';
        this.port = options.port || 8080;
        this._proc = null;
        this._dir = null;
        this._flowFile = null;
        this._prevProxy = null;
    }

    async isAvailable() {
        return new Promise((resolve) => {
            const p = spawn(this.binary, ['--version']);
            p.on('error', () => resolve(false));
            p.on('close', (code) => resolve(code === 0));
        });
    }

    async start(options = {}) {
        if (!await this.isAvailable()) {
            throw new Error(`mitmdump not found (tried "${this.binary}"). Install with: pip install mitmproxy`);
        }
        this._dir = await mkdtemp(join(tmpdir(), 'puppetdroid-mitm-'));
        this._flowFile = join(this._dir, 'flows.jsonl');
        await writeFile(this._flowFile, '');
        const addonPath = join(this._dir, 'addon.py');
        await writeFile(addonPath, ADDON(this._flowFile));

        this._proc = spawn(this.binary, ['-q', '-p', String(this.port), '-s', addonPath, ...(options.args || [])]);
        this._proc.on('error', () => {});
        await this.device.wait(1500);

        // Route device proxy traffic to the PC through adb reverse.
        await this.device.adb.execute(`reverse tcp:${this.port} tcp:${this.port}`);
        this._prevProxy = await this.device.adb.shell('settings get global http_proxy').catch(() => '');
        await this.device.adb.shell(`settings put global http_proxy 127.0.0.1:${this.port}`);
        return this;
    }

    async stop() {
        await this.device.adb.shell('settings put global http_proxy :0').catch(() => {});
        if (this._prevProxy && this._prevProxy.trim() && this._prevProxy.trim() !== 'null') {
            await this.device.adb.shell(`settings put global http_proxy ${this._prevProxy.trim()}`).catch(() => {});
        }
        await this.device.adb.execute(`reverse --remove tcp:${this.port}`).catch(() => {});
        if (this._proc) { this._proc.kill('SIGINT'); this._proc = null; }
        await this.device.wait(500);

        const flows = await this._parseFlows();
        await rm(this._dir, { recursive: true, force: true }).catch(() => {});
        return flows;
    }

    async _parseFlows() {
        const raw = await readFile(this._flowFile, 'utf8').catch(() => '');
        return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }

    /** Capture native traffic across an action; returns the parsed flows. */
    async monitorAction(actionFn, options = {}) {
        await this.start(options);
        try { await actionFn(); } catch (e) { /* still return what we captured */ }
        return this.stop();
    }
}
