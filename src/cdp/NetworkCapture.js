/**
 * Records real HTTP(S) traffic off the CDP Network domain — method, URL, status,
 * headers, POST data, and decoded response bodies — for one page/webview target.
 * Sees the actual wire (HTTPS included), unlike logcat scraping.
 */
export class NetworkCapture {
    /**
     * @param {Object} [options]
     * @param {(rec:Object)=>boolean} [options.filter]  keep the request?
     * @param {boolean} [options.captureResponses=true] fetch response bodies
     * @param {number}  [options.maxBodyBytes=2000000]  skip bodies larger than this
     */
    constructor(connection, options = {}) {
        this.conn = connection;
        this.options = {
            captureResponses: options.captureResponses !== false,
            maxBodyBytes: options.maxBodyBytes ?? 2_000_000,
            filter: options.filter || (() => true),
            label: options.label || null
        };
        this._byId = new Map();
        this._records = [];
        this._handlers = [];
        this._started = false;
    }

    async start() {
        if (this._started) return;
        this._started = true;

        await this.conn.send('Network.enable', {
            maxResourceBufferSize: 100_000_000,
            maxTotalBufferSize: 200_000_000
        }).catch(() => {});

        this._on('Network.requestWillBeSent', (p) => this._onRequest(p));
        this._on('Network.responseReceived', (p) => this._onResponse(p));
        this._on('Network.loadingFinished', (p) => this._onFinished(p));
        this._on('Network.loadingFailed', (p) => this._onFailed(p));
    }

    _on(event, fn) {
        this.conn.on(event, fn);
        this._handlers.push([event, fn]);
    }

    _onRequest(p) {
        const req = p.request || {};
        // A redirect reuses the id: flush the prior hop first.
        if (p.redirectResponse && this._byId.has(p.requestId)) {
            this._complete(p.requestId, { redirected: true, response: p.redirectResponse });
        }
        this._byId.set(p.requestId, {
            requestId: p.requestId,
            label: this.options.label,
            type: p.type,                         // Document, XHR, Fetch, Script, ...
            method: req.method,
            url: req.url,
            requestHeaders: req.headers || {},
            postData: req.postData || null,
            hasPostData: !!req.hasPostData,
            initiator: p.initiator?.type,
            wallTime: p.wallTime,
            status: null,
            statusText: null,
            mimeType: null,
            responseHeaders: null,
            remoteAddress: null,
            fromCache: false,
            responseBody: null,
            failed: false
        });
    }

    _onResponse(p) {
        const rec = this._byId.get(p.requestId);
        if (!rec) return;
        const r = p.response || {};
        rec.status = r.status;
        rec.statusText = r.statusText;
        rec.mimeType = r.mimeType;
        rec.responseHeaders = r.headers || {};
        rec.remoteAddress = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : null;
        rec.fromCache = !!r.fromDiskCache;
        rec.encodedDataLength = r.encodedDataLength;
    }

    async _onFinished(p) {
        const rec = this._byId.get(p.requestId);
        if (!rec) return;
        rec.encodedDataLength = p.encodedDataLength ?? rec.encodedDataLength;
        if (this.options.captureResponses && this._wantsBody(rec)) {
            try {
                const { body, base64Encoded } = await this.conn.send(
                    'Network.getResponseBody', { requestId: p.requestId }, 10000
                );
                rec.responseBody = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
                rec.base64 = base64Encoded;
            } catch (_) {
                // body evicted / unavailable — leave null
            }
        }
        this._complete(p.requestId);
    }

    _onFailed(p) {
        const rec = this._byId.get(p.requestId);
        if (!rec) return;
        rec.failed = true;
        rec.errorText = p.errorText;
        rec.canceled = p.canceled;
        this._complete(p.requestId);
    }

    _wantsBody(rec) {
        if (rec.status === 204 || rec.status === 304) return false;
        if (rec.encodedDataLength && rec.encodedDataLength > this.options.maxBodyBytes) return false;
        return true;
    }

    _complete(requestId, extra = {}) {
        const rec = this._byId.get(requestId);
        if (!rec) return;
        this._byId.delete(requestId);
        Object.assign(rec, extra);
        if (this.options.filter(rec)) this._records.push(rec);
    }

    /** Records completed so far (plus any still in flight). */
    getRequests() {
        const inflight = Array.from(this._byId.values()).filter(r => this.options.filter(r));
        return [...this._records, ...inflight];
    }

    stop() {
        for (const [event, fn] of this._handlers) this.conn.removeListener(event, fn);
        this._handlers = [];
        this._started = false;
        return this.getRequests();
    }
}
