import { ADB } from '../utils/adb.js';

/**
 * Controller for the VirtualMaster / "dual space" VM host app. Drives its
 * MainActivity controls (Enter VM, Shutdown VM, Mute, VM Settings) by
 * resource-id — the buttons are icons with no text, and their positions shift,
 * so id lookups are the only stable handle.
 *
 * Lifecycle waits check the host: the running VM is backed by `VMCoreService`,
 * and boot is confirmed either from the guest's `sys.boot_completed` (when a
 * `guestSerial` is given) or the host reaching `VMDisplayActivity`.
 */
export class VirtualMaster {
    constructor(device, options = {}) {
        this.device = device;
        this.pkg = options.package || 'com.clone.android.dual.space';
        this.mainActivity = options.mainActivity || 'com.android.vmapp.ui.MainActivity';
        this.guestSerial = options.guestSerial || null;   // e.g. '192.168.1.105:10000'
    }

    /** Bring the VirtualMaster control panel (MainActivity) to the foreground. */
    async open() {
        await this.device.adb.shell(`am start -n ${this.pkg}/${this.mainActivity}`);
        await this.device.wait(2000);
        return this;
    }

    async _tapControl(id) {
        const els = await this.device.page.selector.findClickableElements();
        const el = els.find(e => (e.resourceId || '').endsWith(`:id/${id}`));
        if (!el) throw new Error(`VirtualMaster control "${id}" not on screen (is MainActivity open?)`);
        await el.click();
        return el;
    }

    // ── VM lifecycle ──

    /** Start / enter the VM ("Enter VM"). */
    async start() {
        await this.open();
        await this._tapControl('start');
        return this;
    }

    /**
     * Shut the VM down ("Shutdown VM"), handling the confirmation dialog.
     * @param {boolean} [confirm=true] tap Confirm; false taps Cancel (a no-op stop)
     */
    async shutdown({ confirm = true } = {}) {
        await this.open();
        await this._tapControl('shutdown');
        await this.device.wait(1500);
        // "Are you sure to shutdown the VM?" → Confirm / Cancel
        const btn = await this.device.page.findByText(confirm ? 'Confirm' : 'Cancel', false).catch(() => null);
        if (btn) await btn.click();
        return this;
    }

    /** Shut down (waiting for it to stop) then start again. */
    async restart(options = {}) {
        await this.shutdown();
        await this.waitForShutdown(options.shutdownTimeout ?? 30000).catch(() => {});
        await this.start();
        return this;
    }

    async mute() { await this.open(); await this._tapControl('volume'); return this; }
    async openSettings() { await this.open(); await this._tapControl('settings'); return this; }

    // ── State ──

    /** True while the VM's `VMCoreService` is alive on the host. */
    async isRunning() {
        const out = await this.device.adb.shell(`dumpsys activity services ${this.pkg}`).catch(() => '');
        return /VMCoreService/.test(out);
    }

    async waitForShutdown(timeout = 30000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.guestSerial) {
                if (!(await this._guestReady())) return this;
            } else if (!(await this.isRunning())) {
                return this;
            }
            await this.device.wait(1500);
        }
        throw new Error('VM did not shut down in time');
    }

    /**
     * Wait for the VM to finish booting. Uses the guest's `sys.boot_completed`
     * when a `guestSerial` is configured, else the host reaching VMDisplayActivity.
     */
    async waitForBoot(timeout = 120000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.guestSerial) {
                if (await this._guestReady()) return this;
            } else {
                const app = await this.device.getCurrentApp().catch(() => null);
                if (/VMDisplayActivity/.test(app?.activity || '')) return this;
            }
            await this.device.wait(3000);
        }
        throw new Error('VM did not boot in time');
    }

    /** Connect to the guest (network adb) and check it has finished booting. */
    async _guestReady() {
        try {
            await new ADB().execute(`connect ${this.guestSerial}`).catch(() => {});
            const done = await new ADB(this.guestSerial).shell('getprop sys.boot_completed').catch(() => '');
            return done.trim() === '1';
        } catch (_) {
            return false;
        }
    }

    /** A puppetdroid device bound to the guest VM (needs `guestSerial`). */
    async guestDevice() {
        if (!this.guestSerial) throw new Error('No guestSerial configured');
        await new ADB().execute(`connect ${this.guestSerial}`).catch(() => {});
        const { AndroidDevice } = await import('../Device.js');
        return AndroidDevice.connect(this.guestSerial);
    }
}
