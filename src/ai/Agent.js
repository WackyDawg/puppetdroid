import { createProvider, parseJSON } from './providers.js';

const SYSTEM = (goal, w, h, history) => `You are an Android UI automation agent driving a real device toward a goal.

GOAL: ${goal}

The attached image is the current screen (${w}x${h} pixels, origin top-left).
Choose EXACTLY ONE next action and reply with JSON only:
  {"action":"tap","x":<int>,"y":<int>,"reason":"..."}      tap a point (element center)
  {"action":"type","text":"...","reason":"..."}            type into the focused field
  {"action":"swipe","direction":"up|down|left|right","reason":"..."}
  {"action":"key","name":"back|home|enter","reason":"..."}
  {"action":"wait","ms":<int>,"reason":"..."}
  {"action":"done","success":<bool>,"summary":"..."}       goal reached OR provably impossible

Rules: coordinates are in device pixels. Prefer the smallest number of steps. If a
screen looks unchanged after your last action, try a different approach. Emit "done"
as soon as the goal is satisfied.

Your previous actions (most recent last):
${history.length ? history.map((h, i) => `${i + 1}. ${JSON.stringify(h)}`).join('\n') : '(none yet)'}`;

/**
 * Goal-driven screen-control loop: screenshot → LLM picks the next action →
 * execute → repeat until the model reports "done" or `maxSteps` is hit.
 *
 * Guardrails: the action space is mechanical and bounded (tap/type/swipe/key/
 * wait/done) — the model never runs shell. A `confirm(action)` hook can gate or
 * veto each step, and `maxSteps` caps runaway loops.
 */
export class Agent {
    constructor(device, options = {}) {
        this.device = device;
        this.maxSteps = options.maxSteps ?? 15;
        this.stepDelay = options.stepDelay ?? 800;
        this.onStep = options.onStep || null;
        this.confirm = options.confirm || null;
        this._options = options;
        this._provider = null;
    }

    get provider() {
        if (!this._provider) {
            this._provider = this._options.provider && typeof this._options.provider !== 'string'
                ? this._options.provider
                : createProvider(this._options.provider, this._options);
        }
        return this._provider;
    }

    async run(goal) {
        const history = [];
        for (let step = 1; step <= this.maxSteps; step++) {
            const buffer = await this.device.adb.screencapBuffer();
            const { decode } = await import('../utils/png.js');
            const { width, height } = decode(buffer);

            const raw = await this.provider.complete({
                prompt: SYSTEM(goal, width, height, history), image: buffer, json: true, maxTokens: 400
            });
            let action;
            try { action = parseJSON(raw); } catch (e) { action = { action: 'done', success: false, summary: `Unparseable model reply: ${raw.slice(0, 120)}` }; }

            this.onStep?.({ step, action });
            if (this.confirm && (await this.confirm(action)) === false) {
                return { success: false, reason: 'vetoed by confirm()', steps: history };
            }

            if (action.action === 'done') {
                history.push(action);
                return { success: !!action.success, summary: action.summary, steps: history };
            }
            await this._exec(action);
            history.push(action);
            await this.device.wait(this.stepDelay);
        }
        return { success: false, reason: `reached maxSteps (${this.maxSteps})`, steps: history };
    }

    async _exec(action) {
        const adb = this.device.adb;
        switch (action.action) {
            case 'tap':
                return adb.tap(action.x, action.y);
            case 'type':
                return adb.type(action.text ?? '');
            case 'key':
                return adb.keyEvent({ back: 4, home: 3, enter: 66 }[action.name] ?? 4);
            case 'wait':
                return this.device.wait(action.ms ?? 1000);
            case 'swipe': {
                const { width, height } = await this.device.getScreenSize();
                const cx = Math.round(width / 2), cy = Math.round(height / 2);
                const d = { up: [cx, cy, cx, Math.round(height * 0.2)], down: [cx, cy, cx, Math.round(height * 0.8)],
                    left: [cx, cy, Math.round(width * 0.2), cy], right: [cx, cy, Math.round(width * 0.8), cy] }[action.direction] || [cx, cy, cx, cy];
                return adb.swipe(...d, 300);
            }
            default:
                return null; // unknown action — skip rather than crash the loop
        }
    }
}
