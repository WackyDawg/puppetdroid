/**
 * Exported-component discovery and intent/deep-link exercising — attack-surface
 * mapping for an installed app. Reads component visibility from `dumpsys package`
 * and fires `am` intents, watching logcat for the crashes they provoke.
 */
export class Intents {
    constructor(device) {
        this.device = device;
    }

    /** Exported activities/services/receivers for a package (the reachable surface). */
    async getExportedComponents(packageName) {
        const dump = await this.device.adb.shell(`dumpsys package ${packageName}`).catch(() => '');
        const result = { activities: [], services: [], receivers: [], providers: [] };

        // dumpsys groups components under headers; an "exported=true" (or an
        // intent-filter with no explicit exported=false) means externally reachable.
        let section = null;
        for (const raw of dump.split('\n')) {
            const line = raw.trim();
            if (/^Activity Resolver Table:/.test(line)) section = 'activities';
            else if (/^Service Resolver Table:/.test(line)) section = 'services';
            else if (/^Receiver Resolver Table:/.test(line)) section = 'receivers';
            else if (/^Provider Resolver Table:/.test(line)) section = 'providers';
            else {
                const m = line.match(new RegExp(`${packageName}/([\\w.$]+)`));
                if (m && section && !result[section].includes(m[0])) result[section].push(m[0]);
            }
        }
        // Fallback: explicit `exported=true` lines carry the component before them.
        for (const m of dump.matchAll(/([\w.]+\/[\w.$]+)[^]{0,200}?exported=true/g)) {
            const comp = m[1];
            if (comp.startsWith(packageName) && !Object.values(result).flat().includes(comp)) {
                result.activities.push(comp);
            }
        }
        return result;
    }

    /** Fire a single intent. `target`: 'activity' | 'broadcast' | 'service'. */
    async send({ action, data, component, category, mimeType, extras = {}, flags, target = 'activity' } = {}) {
        const cmd = { activity: 'am start', broadcast: 'am broadcast', service: 'am startservice' }[target];
        const parts = [cmd];
        if (action) parts.push(`-a ${action}`);
        if (category) parts.push(`-c ${category}`);
        if (data) parts.push(`-d '${data}'`);
        if (mimeType) parts.push(`-t ${mimeType}`);
        if (component) parts.push(`-n ${component}`);
        for (const [k, v] of Object.entries(extras)) {
            const flag = typeof v === 'number' ? '--ei' : typeof v === 'boolean' ? '--ez' : '--es';
            parts.push(`${flag} ${k} ${v}`);
        }
        if (flags) parts.push(`-f ${flags}`);
        return this.device.adb.shell(parts.join(' '));
    }

    /** Open a deep link (VIEW intent), optionally pinned to a package. */
    async openDeepLink(uri, packageName = null) {
        return this.device.adb.shell(
            `am start -a android.intent.action.VIEW -d '${uri}'${packageName ? ' ' + packageName : ''}`);
    }

    /**
     * Fire test intents at every exported activity and report which ones crash.
     * `payloads` are used for the VIEW data / string extras (default: a few
     * classic malformed inputs). Watches logcat for FATAL exceptions per launch.
     */
    async fuzz(packageName, options = {}) {
        const payloads = options.payloads || [
            '', 'null', '../../etc/passwd', 'file:///data/data/' + packageName,
            "' OR '1'='1", '%00', 'A'.repeat(5000), 'javascript:alert(1)'
        ];
        const components = (await this.getExportedComponents(packageName)).activities;
        const findings = [];

        for (const comp of components) {
            for (const payload of payloads) {
                await this.device.adb.shell('logcat -c').catch(() => {});
                await this.send({
                    component: comp,
                    data: payload || undefined,
                    extras: { input: payload, url: payload },
                    flags: '0x10000000'
                }).catch(() => {});
                await this.device.wait(options.settle ?? 800);

                const crash = await this.device.adb.shell(
                    `logcat -d -t 200 | grep -E "FATAL EXCEPTION|AndroidRuntime.*${packageName}"`
                ).catch(() => '');
                if (crash.includes('FATAL')) {
                    findings.push({ component: comp, payload, trace: crash.split('\n').slice(0, 6).join('\n') });
                }
            }
        }
        return findings;
    }
}
