import zlib from 'zlib';

// Minimal PNG codec for 8-bit RGB/RGBA, non-interlaced images — enough for
// Android `screencap` output and CDP screenshots. Uses zlib for the DEFLATE
// stream; handles the chunk framing, CRC, and scanline filters by hand.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a PNG buffer to `{ width, height, data }`, data being RGBA bytes. */
export function decode(buffer) {
    if (!buffer.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
    let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (pos < buffer.length) {
        const len = buffer.readUInt32BE(pos);
        const type = buffer.toString('ascii', pos + 4, pos + 8);
        const data = buffer.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
                throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${data[12]})`);
            }
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }

    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? cur[i - channels] : 0;
            const b = prev[i];
            const c = i >= channels ? prev[i - channels] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            cur[i] = v & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const s = x * channels, d = (y * width + x) * 4;
            out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
            out[d + 3] = channels === 4 ? cur[s + 3] : 255;
        }
        prev = cur;
    }
    return { width, height, data: out };
}

/** Encode `{ width, height, data(RGBA) }` back to a PNG buffer (filter 0). */
export function encode({ width, height, data }) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const chunk = (type, body) => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0);
        out.write(type, 4, 'ascii');
        body.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Crop an RGBA image to a rectangle (clamped to bounds). */
export function crop(img, { x, y, width, height }) {
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    width = Math.min(Math.round(width), img.width - x);
    height = Math.min(Math.round(height), img.height - y);
    const out = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row++) {
        const src = ((y + row) * img.width + x) * 4;
        img.data.copy(out, row * width * 4, src, src + width * 4);
    }
    return { width, height, data: out };
}

/**
 * Pixel-compare two RGBA images. Returns the changed-pixel count/ratio and a
 * highlight image (differing pixels in red). Mismatched sizes count as fully different.
 */
export function diff(a, b, { threshold = 0 } = {}) {
    if (a.width !== b.width || a.height !== b.height) {
        return { diffCount: a.width * a.height, diffRatio: 1, sizeMismatch: true, image: b };
    }
    const out = Buffer.from(a.data);
    let diffCount = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (dr + dg + db > threshold) {
            diffCount++;
            out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
        }
    }
    return {
        diffCount,
        diffRatio: diffCount / (a.width * a.height),
        sizeMismatch: false,
        image: { width: a.width, height: a.height, data: out }
    };
}
