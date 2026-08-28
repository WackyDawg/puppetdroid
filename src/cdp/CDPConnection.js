import { EventEmitter } from 'events';

/**
 * Minimal Chrome DevTools Protocol client over a single target WebSocket.
 * Zero-dependency — relies on the global `WebSocket`/`fetch`, so it needs Node >= 21.
 */
export class CDPConnection extends EventEmitter {
    static async list(port, host = '127.0.0.1') {
        const res = await fetch(`http://${host}:${port}/json/list`);
        if (!res.ok) throw new Error(`CDP /json/list failed: HTTP ${res.status}`);
        return res.json();
    }

    static async version(port, host = '127.0.0.1') {
        const res = await fetch(`http://${host}:${port}/json/version`);
        if (!res.ok) throw new Error(`CDP /json/version failed: HTTP ${res.status}`);
        return res.json();
    }

    constructor(webSocketDebuggerUrl) {
        super();
        this.setMaxListeners(0);
        this.url = webSocketDebuggerUrl;
        this.ws = null;
        this._id = 0;
        this._pending = new Map();
        this._closed = false;
    }

    connect(timeout = 15000) {
        if (typeof WebSocket === 'undefined') {
            throw new Error('Global WebSocket is unavailable — the CDP feature needs Node >= 21.');
        }
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;

            const timer = setTimeout(() => {
                reject(new Error(`CDP WebSocket connect timed out after ${timeout}ms`));
                try { ws.close(); } catch (_) { /* ignore */ }
            }, timeout);

            ws.addEventListener('open', () => {
                clearTimeout(timer);
                resolve(this);
            });
            ws.addEventListener('error', (ev) => {
                clearTimeout(timer);
                if (!this._closed) reject(new Error(`CDP WebSocket error: ${ev.message || 'unknown'}`));
            });
            ws.addEventListener('close', () => {
                this._closed = true;
                for (const { reject: rej } of this._pending.values()) rej(new Error('CDP connection closed'));
                this._pending.clear();
                this.emit('disconnect');
            });
            ws.addEventListener('message', (ev) => this._onMessage(ev.data));
        });
    }

    _onMessage(data) {
        let msg;
        try {
            msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        } catch (_) {
            return;
        }
        if (msg.id !== undefined && this._pending.has(msg.id)) {
            const { resolve, reject } = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
            else resolve(msg.result);
        } else if (msg.method) {
            // Re-emit under the method name and a catch-all 'event' channel.
            this.emit(msg.method, msg.params);
            this.emit('event', msg);
        }
    }

    send(method, params = {}, timeout = 30000) {
        if (this._closed || !this.ws) return Promise.reject(new Error('CDP connection is not open'));
        const id = ++this._id;
        const payload = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`CDP command "${method}" timed out after ${timeout}ms`));
            }, timeout);

            this._pending.set(id, {
                resolve: (r) => { clearTimeout(timer); resolve(r); },
                reject: (e) => { clearTimeout(timer); reject(e); }
            });

            try {
                this.ws.send(payload);
            } catch (err) {
                clearTimeout(timer);
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    /** Resolve with a single event's params, or reject on timeout. */
    once(eventName, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener(eventName, handler);
                reject(new Error(`Timed out waiting for CDP event "${eventName}" (${timeout}ms)`));
            }, timeout);
            const handler = (params) => {
                clearTimeout(timer);
                resolve(params);
            };
            super.once(eventName, handler);
        });
    }

    close() {
        this._closed = true;
        if (this.ws) {
            try { this.ws.close(); } catch (_) { /* ignore */ }
        }
    }
}
