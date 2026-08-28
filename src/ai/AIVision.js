import { createProvider, parseJSON } from './providers.js';

/**
 * Vision-LLM screen understanding: OCR, natural-language element location, and
 * structured extraction from a live screenshot. Coordinates come back in device
 * pixels (screencap resolution == `input tap` space) so taps map 1:1.
 *
 * Slower and costlier than accessibility selectors — reach for it when the UI
 * isn't in the tree (canvas, games, video overlays) or when a human-style
 * instruction beats a brittle selector.
 */
export class AIVision {
    constructor(device, options = {}) {
        this.device = device;
        this._options = options;
        this._provider = null;
    }

    /** Resolve the provider on first use so construction never needs a key. */
    get provider() {
        if (!this._provider) {
            this._provider = this._options.provider && typeof this._options.provider !== 'string'
                ? this._options.provider
                : createProvider(this._options.provider, this._options);
        }
        return this._provider;
    }

    async _screen() {
        const buffer = await this.device.adb.screencapBuffer();
        const { decode } = await import('../utils/png.js');
        const { width, height } = decode(buffer);
        return { buffer, width, height };
    }

    /** Free-form question about what's on screen → text answer. */
    async ask(question) {
        const { buffer } = await this._screen();
        return (await this.provider.complete({ prompt: question, image: buffer })).trim();
    }

    /** Extract all visible text (reading order). */
    async ocr() {
        const { buffer } = await this._screen();
        return (await this.provider.complete({
            image: buffer,
            prompt: 'Transcribe all text visible on this screen, top to bottom, left to right. Output only the text.',
            maxTokens: 2048
        })).trim();
    }

    /**
     * Locate an element by description. Returns `{ found, x, y, label }` with the
     * element center in device pixels.
     */
    async locate(description) {
        const { buffer, width, height } = await this._screen();
        const prompt =
            `This is an Android screen, ${width}x${height} pixels, origin top-left. ` +
            `Locate this element: "${description}". ` +
            `Reply with JSON {"found": boolean, "x": int, "y": int, "label": string} where x,y is the element's CENTER in pixels.`;
        const raw = await this.provider.complete({ prompt, image: buffer, json: true, maxTokens: 256 });
        const r = parseJSON(raw);
        return { found: !!r.found, x: Math.round(r.x), y: Math.round(r.y), label: r.label || description };
    }

    async exists(description) {
        return (await this.locate(description)).found;
    }

    /** Tap an element described in natural language. */
    async tap(description) {
        const loc = await this.locate(description);
        if (!loc.found) throw new Error(`AI could not find: "${description}"`);
        await this.device.adb.tap(loc.x, loc.y);
        return loc;
    }

    /** Tap a described field, then type into it. */
    async type(description, text) {
        await this.tap(description);
        await this.device.wait(400);
        await this.device.adb.type(text);
        return this;
    }

    /**
     * Extract structured data from the screen. Pass an instruction (and optionally
     * a shape) and get parsed JSON back.
     */
    async extract(instruction, shape = null) {
        const { buffer } = await this._screen();
        const prompt = shape
            ? `${instruction}\nReturn JSON matching this shape: ${JSON.stringify(shape)}`
            : `${instruction}\nReturn the result as JSON.`;
        return parseJSON(await this.provider.complete({ prompt, image: buffer, json: true, maxTokens: 2048 }));
    }
}
