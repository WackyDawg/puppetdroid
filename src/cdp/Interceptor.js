/** Glob (`*`) or substring pattern → RegExp. */
function toRegExp(pattern) {
    if (pattern instanceof RegExp) return pattern;
    if (pattern.includes('*')) {
        const rx = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${rx}$`);
    }
    return new RegExp(pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')); // substring
}

/** A paused request handed to a route handler (Playwright-ish surface). */
class Route {
    constructor(interceptor, event) {
        this._ip = interceptor;
        this._id = event.requestId;
        this._handled = false;
        this.request = {
            url: event.request.url,
            method: event.request.method,
            headers: event.request.headers || {},
            postData: event.request.postData || null,
            resourceType: event.resourceType
        };
    }

    async continue(overrides = {}) {
        this._done();
        const params = { requestId: this._id };
        if (overrides.url) params.url = overrides.url;
        if (overrides.method) params.method = overrides.method;
        if (overrides.postData) params.postData = Buffer.from(overrides.postData).toString('base64');
        if (overrides.headers) params.headers = Object.entries(overrides.headers).map(([name, value]) => ({ name, value: String(value) }));
        await this._ip.conn.send('Fetch.continueRequest', params).catch(() => {});
    }

    async fulfill({ status = 200, headers = {}, body = '', json } = {}) {
        this._done();
        if (json !== undefined) {
            body = JSON.stringify(json);
            headers = { 'content-type': 'application/json', ...headers };
        }
        await this._ip.conn.send('Fetch.fulfillRequest', {
            requestId: this._id,
            responseCode: status,
            responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
            body: Buffer.from(body).toString('base64')
        }).catch(() => {});
    }

    async abort(errorReason = 'Failed') {
        this._done();
        await this._ip.conn.send('Fetch.failRequest', { requestId: this._id, errorReason }).catch(() => {});
    }

    _done() {
        if (this._handled) throw new Error('Route already handled');
        this._handled = true;
    }
}

/**
 * Request interception over the CDP Fetch domain: block, redirect, mock or
 * mutate requests. Rules are matched in insertion order; the first match wins,
 * and an unmatched request is continued untouched.
 */
export class Interceptor {
    constructor(connection) {
        this.conn = connection;
        this._rules = [];      // { re, handler }
        this._enabled = false;
        this._onPaused = (e) => this._handle(e);
    }

    async _ensureEnabled() {
        if (this._enabled) return;
        this._enabled = true;
        this.conn.on('Fetch.requestPaused', this._onPaused);
        await this.conn.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    }

    async route(pattern, handler) {
        await this._ensureEnabled();
        this._rules.push({ re: toRegExp(pattern), handler });
    }

    async block(patterns) {
        const list = Array.isArray(patterns) ? patterns : [patterns];
        for (const p of list) await this.route(p, (route) => route.abort('BlockedByClient'));
    }

    async unroute(pattern) {
        const re = toRegExp(pattern).source;
        this._rules = this._rules.filter(r => r.re.source !== re);
    }

    async _handle(event) {
        const route = new Route(this, event);
        const rule = this._rules.find(r => r.re.test(route.request.url));
        if (!rule) return this.conn.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        try {
            await rule.handler(route);
            if (!route._handled) await route.continue();
        } catch (_) {
            if (!route._handled) await route.continue();
        }
    }

    async disable() {
        if (!this._enabled) return;
        this.conn.removeListener('Fetch.requestPaused', this._onPaused);
        this._rules = [];
        this._enabled = false;
        await this.conn.send('Fetch.disable').catch(() => {});
    }
}
