/**
 * Vision-LLM providers behind one `complete({ prompt, image, json })` call.
 * API keys are read from the environment (or passed in `options.apiKey`) and
 * never stored — bring your own. Models are overridable; the defaults are the
 * fast vision tiers of each family.
 */

function requireKey(key, envName, provider) {
    const k = key || process.env[envName];
    if (!k) throw new Error(`${provider}: no API key. Set ${envName} or pass { apiKey }.`);
    return k;
}

async function postJSON(url, headers, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI request failed ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
}

class GeminiProvider {
    constructor({ apiKey, model = 'gemini-2.5-flash' } = {}) {
        this.key = requireKey(apiKey, 'GEMINI_API_KEY', 'Gemini');
        this.model = model;
    }
    async complete({ prompt, image, json = false, maxTokens = 1024 }) {
        const parts = [{ text: prompt }];
        if (image) parts.push({ inline_data: { mime_type: 'image/png', data: image.toString('base64') } });
        const body = {
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) }
        };
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.key}`;
        const data = await postJSON(url, {}, body);
        return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    }
}

class ClaudeProvider {
    constructor({ apiKey, model = 'claude-sonnet-5' } = {}) {
        this.key = requireKey(apiKey, 'ANTHROPIC_API_KEY', 'Claude');
        this.model = model;
    }
    async complete({ prompt, image, json = false, maxTokens = 1024 }) {
        const content = [];
        if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } });
        content.push({ type: 'text', text: json ? `${prompt}\n\nRespond with JSON only, no prose.` : prompt });
        const data = await postJSON('https://api.anthropic.com/v1/messages',
            { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
            { model: this.model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
        return data.content?.map(c => c.text).join('') ?? '';
    }
}

class OpenAIProvider {
    constructor({ apiKey, model = 'gpt-4o-mini' } = {}) {
        this.key = requireKey(apiKey, 'OPENAI_API_KEY', 'OpenAI');
        this.model = model;
    }
    async complete({ prompt, image, json = false, maxTokens = 1024 }) {
        const content = [{ type: 'text', text: prompt }];
        if (image) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } });
        const data = await postJSON('https://api.openai.com/v1/chat/completions',
            { authorization: `Bearer ${this.key}` },
            {
                model: this.model, max_tokens: maxTokens, messages: [{ role: 'user', content }],
                ...(json ? { response_format: { type: 'json_object' } } : {})
            });
        return data.choices?.[0]?.message?.content ?? '';
    }
}

const PROVIDERS = { gemini: GeminiProvider, google: GeminiProvider, claude: ClaudeProvider, anthropic: ClaudeProvider, openai: OpenAIProvider, gpt: OpenAIProvider };

/**
 * Build a provider by name, or auto-detect from whichever API key is present.
 * @param {string} [name] - 'gemini' | 'claude' | 'openai' (default: auto)
 */
export function createProvider(name, options = {}) {
    if (name) {
        const Ctor = PROVIDERS[name.toLowerCase()];
        if (!Ctor) throw new Error(`Unknown AI provider: ${name}`);
        return new Ctor(options);
    }
    if (options.apiKey) throw new Error('Pass a provider name when supplying an explicit apiKey');
    if (process.env.GEMINI_API_KEY) return new GeminiProvider(options);
    if (process.env.ANTHROPIC_API_KEY) return new ClaudeProvider(options);
    if (process.env.OPENAI_API_KEY) return new OpenAIProvider(options);
    throw new Error('No AI provider configured. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
}

/** Pull the first JSON object/array out of a model response (handles ``` fences). */
export function parseJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const match = body.match(/[[{][\s\S]*[\]}]/);
    if (!match) throw new Error(`No JSON in AI response: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
}
