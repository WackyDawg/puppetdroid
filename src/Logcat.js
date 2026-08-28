import { EventEmitter } from 'events';

const PRIORITIES = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*?):\s?(.*)$/;

/**
 * Streamed logcat reader (a real `adb logcat` pipe, not the polling the network
 * monitor falls back to). Parses the threadtime format into structured entries
 * and emits `line` / `entry` events; matched-only entries also emit `match`.
 */
export class Logcat extends EventEmitter {
    constructor(device) {
        super();
        this.device = device;
        this._proc = null;
        this._filters = null;
    }

    get isRunning() { return !!this._proc; }

    /**
     * @param {Object} [options]
     * @param {string} [options.priority]  minimum level: V|D|I|W|E|F
     * @param {string[]} [options.tags]    only these log tags
     * @param {RegExp|string} [options.match] keep entries whose message matches
     * @param {boolean} [options.clear=true] flush the buffer before streaming
     */
    async start(options = {}) {
        if (this._proc) throw new Error('logcat already running');
        this._filters = {
            minPriority: PRIORITIES[options.priority] ?? 0,
            tags: options.tags || null,
            match: options.match ? (options.match instanceof RegExp ? options.match : new RegExp(options.match)) : null
        };
        if (options.clear !== false) await this.device.adb.shell('logcat -c').catch(() => {});

        this._proc = this.device.adb.spawnStream(['logcat', '-v', 'threadtime'], (line) => this._onLine(line));
        return this;
    }

    _onLine(line) {
        this.emit('line', line);
        const entry = this._parse(line);
        if (!entry) return;
        if (PRIORITIES[entry.priority] < this._filters.minPriority) return;
        if (this._filters.tags && !this._filters.tags.includes(entry.tag)) return;
        this.emit('entry', entry);
        if (this._filters.match && this._filters.match.test(entry.message)) this.emit('match', entry);
    }

    _parse(line) {
        const m = line.match(LINE_RE);
        if (!m) return null;
        return { time: m[1], pid: +m[2], tid: +m[3], priority: m[4], tag: m[5].trim(), message: m[6] };
    }

    /** Collect matching entries for `durationMs`, then stop and resolve them. */
    async collect(durationMs, options = {}) {
        const entries = [];
        const key = options.match ? 'match' : 'entry';
        await this.start(options);
        this.on(key, (e) => entries.push(e));
        await this.device.wait(durationMs);
        this.stop();
        return entries;
    }

    stop() {
        if (this._proc) { this._proc.kill(); this._proc = null; }
        this.removeAllListeners();
    }
}
