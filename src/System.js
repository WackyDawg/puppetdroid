/**
 * Native device controls that map cleanly onto adb/shell: runtime permissions,
 * radios, notifications, screen power and brightness. Some toggles need the
 * right platform support and quietly no-op where the OS blocks them (noted per
 * method); none require root on a normal debuggable device.
 */
export class System {
    constructor(device) {
        this.device = device;
    }

    // ── Permissions ──

    async grantPermission(pkg, permission) {
        return this.device.adb.shell(`pm grant ${pkg} ${permission}`);
    }

    async revokePermission(pkg, permission) {
        return this.device.adb.shell(`pm revoke ${pkg} ${permission}`);
    }

    /** Grant every runtime permission the package requests (non-runtime ones just fail-quiet). */
    async grantAllPermissions(pkg) {
        const dump = await this.device.adb.shell(`dumpsys package ${pkg}`).catch(() => '');
        const perms = [...dump.matchAll(/(android\.permission\.[A-Z_]+):\s*granted=/g)].map(m => m[1]);
        const requested = perms.length ? perms : [...dump.matchAll(/(android\.permission\.[A-Z_]+)/g)].map(m => m[1]);
        const granted = [];
        for (const p of [...new Set(requested)]) {
            try { await this.grantPermission(pkg, p); granted.push(p); } catch (_) { /* not a runtime perm */ }
        }
        return granted;
    }

    // ── Connectivity ──

    async wifi(on) { return this.device.adb.shell(`svc wifi ${on ? 'enable' : 'disable'}`); }
    async mobileData(on) { return this.device.adb.shell(`svc data ${on ? 'enable' : 'disable'}`); }
    async bluetooth(on) { return this.device.adb.shell(`svc bluetooth ${on ? 'enable' : 'disable'}`); }

    /** Toggle airplane mode. The broadcast that applies it is restricted on newer OS builds. */
    async airplaneMode(on) {
        await this.device.adb.shell(`settings put global airplane_mode_on ${on ? 1 : 0}`);
        return this.device.adb.shell(`am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on}`).catch(() => null);
    }

    // ── Screen power ──

    async isScreenOn() {
        const out = await this.device.adb.shell("dumpsys power | grep -E 'mWakefulness=|Display Power'").catch(() => '');
        return /Awake|state=ON/.test(out);
    }

    async wake() {
        if (!await this.isScreenOn()) await this.device.adb.keyEvent(224); // KEYCODE_WAKEUP
        return this;
    }

    async sleep() { return this.device.adb.keyEvent(223); } // KEYCODE_SLEEP

    /** Wake, swipe up to dismiss the keyguard, and enter a PIN if provided. */
    async unlock(pin = null) {
        await this.wake();
        const { width, height } = await this.device.getScreenSize();
        await this.device.adb.swipe(width / 2, height * 0.8, width / 2, height * 0.2, 200);
        if (pin) {
            await this.device.wait(400);
            await this.device.adb.shell(`input text ${pin}`);
            await this.device.adb.keyEvent(66); // ENTER
        }
        return this;
    }

    /** Set brightness 0-255 (switches off auto-brightness first). */
    async setBrightness(level) {
        await this.device.adb.shell('settings put system screen_brightness_mode 0');
        return this.device.adb.shell(`settings put system screen_brightness ${Math.max(0, Math.min(255, level))}`);
    }

    // ── Notifications ──

    /** Active notifications as `{ pkg, title, text }` (parsed from dumpsys). */
    async getNotifications() {
        const dump = await this.device.adb.shell('dumpsys notification --noredact').catch(() => '');
        const out = [];
        // Each posted record carries a pkg= line followed by title/text extras.
        for (const block of dump.split(/NotificationRecord\(/).slice(1)) {
            const pkg = (block.match(/pkg=([\w.]+)/) || [])[1];
            const title = (block.match(/android\.title=[^:]*?:?\s*(?:String\s*)?\(?([^)\n]+)/) || [])[1];
            const text = (block.match(/android\.text=[^:]*?:?\s*(?:String\s*)?\(?([^)\n]+)/) || [])[1];
            if (pkg) out.push({ pkg, title: title?.trim() || null, text: text?.trim() || null });
        }
        return out;
    }

    async expandNotifications() { return this.device.adb.shell('cmd statusbar expand-notifications').catch(() => null); }
    async collapseStatusBar() { return this.device.adb.shell('cmd statusbar collapse').catch(() => null); }

    /** Dismiss all notifications (support varies by OEM). */
    async clearNotifications() {
        return this.device.adb.shell('service call notification 1').catch(() => null);
    }
}
