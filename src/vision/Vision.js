import { spawn } from 'child_process';
import { writeFile, readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Pixel-level fallbacks for UI that isn't in the accessibility tree — canvas
 * games, DRM/video surfaces, custom-rendered controls. Text location uses the
 * Tesseract CLI (optional); image location uses a downsampled template match on
 * a screenshot. Both are best-effort and slower than selector-based automation.
 */
export class Vision {
    constructor(device, options = {}) {
        this.device = device;
        this.tesseract = options.tesseract || 'tesseract';
    }

    async isOcrAvailable() {
        return new Promise((resolve) => {
            const p = spawn(this.tesseract, ['--version']);
            p.on('error', () => resolve(false));
            p.on('close', () => resolve(true));
        });
    }

    /** OCR the screen into words with bounding boxes and confidence. */
    async ocr() {
        if (!await this.isOcrAvailable()) {
            throw new Error(`Tesseract not found (tried "${this.tesseract}"). Install tesseract-ocr.`);
        }
        const dir = await mkdtemp(join(tmpdir(), 'puppetdroid-ocr-'));
        const img = join(dir, 'screen.png');
        await writeFile(img, await this.device.adb.screencapBuffer());

        const tsv = await new Promise((resolve, reject) => {
            const p = spawn(this.tesseract, [img, 'stdout', 'tsv']);
            const out = [], err = [];
            p.stdout.on('data', (d) => out.push(d));
            p.stderr.on('data', (d) => err.push(d));
            p.on('error', reject);
            p.on('close', (c) => c === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(Buffer.concat(err).toString())));
        });
        await rm(dir, { recursive: true, force: true }).catch(() => {});

        const words = [];
        for (const line of tsv.split('\n').slice(1)) {
            const c = line.split('\t');
            if (c[0] === '5' && c[11] && c[11].trim()) {
                const [left, top, w, h] = [+c[6], +c[7], +c[8], +c[9]];
                words.push({ text: c[11], confidence: +c[10], x: left, y: top, width: w, height: h, centerX: left + w / 2, centerY: top + h / 2 });
            }
        }
        return words;
    }

    /** Find on-screen text (substring, case-insensitive). Returns the word box or null. */
    async findText(text, options = {}) {
        const needle = text.toLowerCase();
        const words = await this.ocr();
        return words.find(w => w.confidence >= (options.minConfidence ?? 40) && w.text.toLowerCase().includes(needle)) || null;
    }

    async tapText(text, options = {}) {
        const hit = await this.findText(text, options);
        if (!hit) throw new Error(`Text not found on screen: "${text}"`);
        await this.device.adb.tap(Math.round(hit.centerX), Math.round(hit.centerY));
        return hit;
    }

    /**
     * Locate a template image on screen via coarse (downsampled) template match.
     * Returns `{ x, y, score }` in screen coordinates, or null below `threshold`.
     */
    async findImage(templatePath, options = {}) {
        const png = await import('../utils/png.js');
        const step = options.downsample ?? 4;
        const threshold = options.threshold ?? 0.9;

        const screen = down(png.decode(await this.device.adb.screencapBuffer()), step);
        const tpl = down(png.decode(await readFile(templatePath)), step);
        if (tpl.width > screen.width || tpl.height > screen.height) return null;

        let best = { score: -1, x: 0, y: 0 };
        for (let y = 0; y <= screen.height - tpl.height; y++) {
            for (let x = 0; x <= screen.width - tpl.width; x++) {
                const score = matchScore(screen, tpl, x, y);
                if (score > best.score) best = { score, x, y };
            }
        }
        if (best.score < threshold) return null;
        return { x: best.x * step + (tpl.width * step) / 2, y: best.y * step + (tpl.height * step) / 2, score: best.score };
    }

    async tapImage(templatePath, options = {}) {
        const hit = await this.findImage(templatePath, options);
        if (!hit) throw new Error(`Template not found on screen: ${templatePath}`);
        await this.device.adb.tap(Math.round(hit.x), Math.round(hit.y));
        return hit;
    }
}

/** Nearest-neighbour downsample of an RGBA image by an integer factor. */
function down(img, step) {
    if (step <= 1) return img;
    const w = Math.floor(img.width / step), h = Math.floor(img.height / step);
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((y * step) * img.width + x * step) * 4, d = (y * w + x) * 4;
        img.data.copy(data, d, s, s + 4);
    }
    return { width: w, height: h, data };
}

/** Normalized similarity (1 - mean abs RGB difference) of a template at (ox,oy). */
function matchScore(screen, tpl, ox, oy) {
    let sum = 0;
    for (let y = 0; y < tpl.height; y++) for (let x = 0; x < tpl.width; x++) {
        const s = ((oy + y) * screen.width + (ox + x)) * 4, t = (y * tpl.width + x) * 4;
        sum += Math.abs(screen.data[s] - tpl.data[t])
            + Math.abs(screen.data[s + 1] - tpl.data[t + 1])
            + Math.abs(screen.data[s + 2] - tpl.data[t + 2]);
    }
    return 1 - sum / (tpl.width * tpl.height * 3 * 255);
}
