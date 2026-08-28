class AssertionError extends Error {
    constructor(message) { super(message); this.name = 'AssertionError'; }
}

async function elementText(el) {
    if (!el) return null;
    return typeof el.text === 'function' ? await el.text() : el.text;
}

async function isVisible(el) {
    if (!el) return false;
    return typeof el.isVisible === 'function' ? await el.isVisible() : true;
}

/**
 * Web-first assertions over a Page (accessibility) or ChromeDOM. Each matcher
 * polls until it passes or `timeout` elapses, so callers don't hand-roll waits.
 * `expect(target).not.*` inverts.
 */
class Expectation {
    constructor(target, { negated = false, timeout = 5000 } = {}) {
        this.target = target;
        this.negated = negated;
        this.timeout = timeout;
    }

    get not() { return new Expectation(this.target, { negated: !this.negated, timeout: this.timeout }); }

    async _poll(probe, describe) {
        const start = Date.now();
        let last = false;
        do {
            last = await probe().catch(() => false);
            if (this.negated ? !last : last) return;
            await new Promise(r => setTimeout(r, 100));
        } while (Date.now() - start < this.timeout);
        throw new AssertionError(`expect(${this.negated ? '.not' : ''}).${describe} failed after ${this.timeout}ms`);
    }

    toHaveElement(selector) {
        return this._poll(async () => !!(await this.target.$(selector)), `toHaveElement(${JSON.stringify(selector)})`);
    }

    toBeVisible(selector) {
        return this._poll(async () => isVisible(await this.target.$(selector)), `toBeVisible(${JSON.stringify(selector)})`);
    }

    toHaveText(selectorOrText, maybeText) {
        const [selector, text] = maybeText === undefined ? [null, selectorOrText] : [selectorOrText, maybeText];
        return this._poll(async () => {
            if (selector) {
                const t = await elementText(await this.target.$(selector));
                return t != null && t.includes(text);
            }
            const all = await this.target.getAllText?.();      // Page has this; else scan
            return (all || []).some(t => t.includes(text));
        }, `toHaveText(${JSON.stringify(text)})`);
    }

    toHaveTitle(text) {
        return this._poll(async () => {
            const title = await this.target.title();
            return typeof text === 'string' ? title.includes(text) : text.test(title);
        }, `toHaveTitle(${JSON.stringify(text)})`);
    }

    toHaveURL(text) {
        return this._poll(async () => {
            const url = await this.target.url();
            return typeof text === 'string' ? url.includes(text) : text.test(url);
        }, `toHaveURL(${JSON.stringify(text)})`);
    }
}

export function expect(target, options = {}) {
    return new Expectation(target, options);
}

export { AssertionError };
