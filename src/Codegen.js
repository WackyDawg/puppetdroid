/**
 * Records touches via `getevent` and emits a runnable puppetdroid script. For each
 * tap it hit-tests the UI hierarchy and prefers a stable selector (resource-id,
 * then text/content-desc), falling back to raw coordinates.
 *
 * Constraints worth knowing: taps and long-presses are captured; text entry
 * (soft keyboard) and swipes are only approximated, and the raw→screen scaling
 * assumes a single multitouch device. Treat the output as a strong first draft.
 */
export class Codegen {
    constructor(device, options = {}) {
        this.device = device;
        this.options = options;
        this._proc = null;
        this._steps = [];
        this._touch = null;
        this._scale = null;
    }

    async start() {
        const size = await this.device.getScreenSize();
        this._scale = await this._resolveTouchDevice(size);
        this._steps = [];

        const dev = this._scale.device ? ` ${this._scale.device}` : '';
        this._proc = this.device.adb.spawnStream(['shell', `getevent -lt${dev}`], (line) => this._onEvent(line));
        return this;
    }

    async _resolveTouchDevice(size) {
        // Parse `getevent -lp` for the node exposing ABS_MT_POSITION_X/Y and its max.
        const dump = await this.device.adb.shell('getevent -lp').catch(() => '');
        const blocks = dump.split(/add device/);
        for (const block of blocks) {
            const path = (block.match(/\/dev\/input\/event\d+/) || [])[0];
            const maxX = block.match(/ABS_MT_POSITION_X[^]*?max\s+(\d+)/);
            const maxY = block.match(/ABS_MT_POSITION_Y[^]*?max\s+(\d+)/);
            if (path && maxX && maxY) {
                return { device: path, maxX: +maxX[1], maxY: +maxY[1], width: size.width, height: size.height };
            }
        }
        // Fall back to screen-space coordinates (already 1:1 on many devices).
        return { device: null, maxX: size.width, maxY: size.height, width: size.width, height: size.height };
    }

    _onEvent(line) {
        const parts = line.trim().split(/\s+/);
        const code = parts[parts.length - 2];
        const valueHex = parts[parts.length - 1];
        const value = parseInt(valueHex, 16);

        if (code === 'ABS_MT_POSITION_X') { (this._touch ||= {}).x = value; }
        else if (code === 'ABS_MT_POSITION_Y') { (this._touch ||= {}).y = value; }
        else if (code === 'BTN_TOUCH') {
            if (valueHex === 'DOWN') { this._touch = { ...(this._touch || {}), t0: Date.now() }; }
            else if (valueHex === 'UP') { this._commitTap(); }
        }
    }

    async _commitTap() {
        const t = this._touch;
        this._touch = null;
        if (!t || t.x == null || t.y == null) return;
        const x = Math.round(t.x / this._scale.maxX * this._scale.width);
        const y = Math.round(t.y / this._scale.maxY * this._scale.height);
        const held = Date.now() - (t.t0 || Date.now());

        const step = await this._resolveStep(x, y, held).catch(() => null);
        this._steps.push(step || `  await page.tap(${x}, ${y});`);
    }

    async _resolveStep(x, y, held) {
        const xml = await this.device.adb.getUIHierarchy();
        const hit = this._hitTest(xml, x, y);
        const action = held > 600 ? 'longPress' : 'click';
        if (hit?.resourceId) return `  await page.${action}({ resourceId: '${hit.resourceId}' });`;
        if (hit?.text) return `  await page.${action}({ text: ${JSON.stringify(hit.text)} });`;
        if (hit?.desc) return `  await page.${action}({ contentDesc: ${JSON.stringify(hit.desc)} });`;
        return held > 600 ? `  await page.longPress(${x}, ${y});` : `  await page.tap(${x}, ${y});`;
    }

    /** Smallest node whose bounds contain (x,y), preferring identifiable ones. */
    _hitTest(xml, x, y) {
        let best = null, bestArea = Infinity;
        for (const m of xml.matchAll(/<node[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*\/?>/g)) {
            const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
            if (x < x1 || x > x2 || y < y1 || y > y2) continue;
            const area = (x2 - x1) * (y2 - y1);
            if (area > bestArea) continue;
            const tag = m[0];
            best = {
                resourceId: (tag.match(/resource-id="([^"]+)"/) || [])[1] || '',
                text: (tag.match(/ text="([^"]+)"/) || [])[1] || '',
                desc: (tag.match(/content-desc="([^"]+)"/) || [])[1] || ''
            };
            bestArea = area;
        }
        return best;
    }

    /** Stop recording and return the generated script text. */
    stop() {
        if (this._proc) { this._proc.kill(); this._proc = null; }
        return [
            "import { Puppetdroid } from 'puppetdroid';",
            '',
            'const device = await Puppetdroid.connect();',
            'const page = device.page;',
            '',
            ...this._steps,
            ''
        ].join('\n');
    }
}
