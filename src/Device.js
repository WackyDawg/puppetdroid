import { ADB } from './utils/adb.js';
import { Page } from './Page.js';
import { NetworkMonitor } from './NetworkMonitor.js';
import { ScreenRecorder } from './ScreenRecorder.js';
import { Logcat } from './Logcat.js';
import { Intents } from './security/Intents.js';
import { Frida } from './security/Frida.js';
import { Mitmproxy } from './security/Mitmproxy.js';
import { Codegen } from './Codegen.js';
import { Vision } from './vision/Vision.js';
import { System } from './System.js';
import { AIVision } from './ai/AIVision.js';
import { Agent } from './ai/Agent.js';
import { VirtualMaster } from './apps/VirtualMaster.js';
import { parseUIHierarchy } from './utils/xml-parser.js';

export class AndroidDevice {
    constructor(deviceId = null) {
        this.deviceId = deviceId;
        this.adb = new ADB(deviceId);
        this.page = new Page(this);
        this.networkMonitor = new NetworkMonitor(this);
        this.recorder = new ScreenRecorder(this);
        this.intents = new Intents(this);
        this.frida = new Frida(this);
        this.mitmproxy = new Mitmproxy(this);
        this.vision = new Vision(this);
        this.system = new System(this);
        this._screenSize = null;
        this._uiHierarchy = null;
        this._lastUIUpdate = 0;
        this._deviceInfo = null;
    }

    /** A fresh streamed logcat reader. */
    logcat() { return new Logcat(this); }

    /** A codegen recorder that watches interactions and emits a puppetdroid script. */
    recordScript(options = {}) { return new Codegen(this, options); }

    /** Vision-LLM screen understanding (OCR / locate / extract). Needs an API key. */
    ai(options = {}) { return new AIVision(this, options); }

    /** Goal-driven AI agent that observes the screen and controls the device. */
    agent(options = {}) { return new Agent(this, options); }

    /** Controller for the VirtualMaster VM host app (start / shutdown / restart). */
    virtualMaster(options = {}) { return new VirtualMaster(this, options); }

    /**
     * Read all text on the current screen using the best available source, in
     * order: the accessibility tree, then a debuggable WebView over CDP, then OCR
     * (AI if `{ ocr: 'ai' }`/a provider is given, else Tesseract if installed).
     * Returns `{ text, method }`. WebView-heavy screens (GMS, banking) that expose
     * no accessibility text fall through to WebView-CDP or OCR automatically.
     */
    async readScreen(options = {}) {
        if (!options.forceOcr && !options.forceWebview) {
            const a11y = (await this.page.getAllText().catch(() => [])).join('\n').trim();
            if (a11y.length >= (options.minChars ?? 2)) return { text: a11y, method: 'accessibility' };
        }
        if (!options.forceOcr) {
            try {
                const pkg = (await this.getCurrentApp().catch(() => null))?.package;
                const socket = await this.adb.findDevtoolsSocket(pkg, { strict: true });
                if (socket && /webview|chrome/i.test(socket)) {
                    const dom = this.page.chrome({ socket });
                    await dom.ensureConnected();
                    const text = (await dom.evaluate(() => document.body ? document.body.innerText : '')).trim();
                    await dom.close();
                    if (text) return { text, method: 'webview-cdp' };
                }
            } catch (_) { /* not debuggable — fall through to OCR */ }
        }
        if (options.ocr === 'ai' || options.provider) {
            return { text: await this.ai(options).ocr(), method: 'ai-ocr' };
        }
        if (await this.vision.isOcrAvailable()) {
            return { text: await this.vision.ocr(), method: 'tesseract-ocr' };
        }
        const a11y = (await this.page.getAllText().catch(() => [])).join('\n').trim();
        return a11y
            ? { text: a11y, method: 'accessibility' }
            : { text: '', method: 'none', note: 'no accessibility text, no debuggable WebView, and no OCR backend (set an AI key or install tesseract to read this screen)' };
    }

    static async connect(deviceId = null) {
        const device = new AndroidDevice(deviceId);
        await device._initialize();
        return device;
    }

    async _initialize() {
        // Verify ADB connection
        try {
            const isConnected = await this.adb.isConnected();
            if (!isConnected) {
                throw new Error('Device not connected or not authorized');
            }
            console.log('📱 Device connected successfully');

            // Get device info
            this._deviceInfo = await this.adb.getDeviceInfo();
            console.log(`📱 Device: ${this._deviceInfo.brand} ${this._deviceInfo.model} (Android ${this._deviceInfo.version})`);
        } catch (error) {
            throw new Error(`Failed to connect to device: ${error.message}`);
        }
    }

    async launch(packageName) {
        await this.adb.startApp(packageName);
        await this.waitForIdle();
        return this.page;
    }

    async getScreenSize() {
        if (!this._screenSize) {
            this._screenSize = await this.adb.getScreenSize();
        }
        return this._screenSize;
    }

    async getDeviceInfo() {
        if (!this._deviceInfo) {
            this._deviceInfo = await this.adb.getDeviceInfo();
        }
        return this._deviceInfo;
    }

    async getUIHierarchy(forceRefresh = false) {
        const now = Date.now();
        // Cache UI hierarchy for 1 second to avoid excessive calls
        if (!this._uiHierarchy || forceRefresh || (now - this._lastUIUpdate) > 1000) {
            const xmlString = await this.adb.getUIHierarchy();
            this._uiHierarchy = await parseUIHierarchy(xmlString);
            this._lastUIUpdate = now;
        }
        return this._uiHierarchy;
    }

    // Remove the old XML parsing methods since we're using xml2js now

    async waitForIdle(timeout = 2000) {
        // Wait for UI to stabilize
        try {
            // Use dumpsys to wait for window animations to complete
            await this.adb.shell(`dumpsys window | grep -E "(mSystemGestureExclusionLimit|mAnimationStartDelayed)" || echo "idle-check-done"`);
            await this.wait(200); // Small buffer for UI to settle
        } catch (error) {
            // Fallback to simple wait
            await this.wait(500);
        }
    }

    async wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async screenshot(path) {
        return this.adb.screenshot(path);
    }

    /** Capture the screen as a decoded RGBA image `{ width, height, data }`. */
    async captureImage() {
        const { decode } = await import('./utils/png.js');
        return decode(await this.adb.screencapBuffer());
    }

    /**
     * Pixel-diff two screenshots (paths, Buffers, or decoded images). Writes a
     * red-highlighted diff to `options.output` when given.
     */
    async visualDiff(a, b, options = {}) {
        const png = await import('./utils/png.js');
        const { readFile, writeFile } = await import('fs/promises');
        const load = async (x) => {
            if (x?.data && x.width) return x;
            return png.decode(Buffer.isBuffer(x) ? x : await readFile(x));
        };
        const result = png.diff(await load(a), await load(b), options);
        if (options.output && result.image) await writeFile(options.output, png.encode(result.image));
        return { diffCount: result.diffCount, diffRatio: result.diffRatio, sizeMismatch: result.sizeMismatch };
    }

    /** Record the screen to a local mp4 until `.stop()` is called. */
    startRecording(path, options = {}) {
        return this.recorder.start(path, options);
    }

    async getCurrentApp() {
        return this.adb.getCurrentActivity();
    }

    async getInstalledApps() {
        const packages = await this.adb.shell('pm list packages -3'); // Third-party apps only
        return packages.split('\n')
            .map(line => line.replace('package:', ''))
            .filter(pkg => pkg.length > 0);
    }

    async getAllInstalledApps() {
        const packages = await this.adb.shell('pm list packages');
        return packages.split('\n')
            .map(line => line.replace('package:', ''))
            .filter(pkg => pkg.length > 0);
    }

    async isAppInstalled(packageName) {
        return this.adb.isPackageInstalled(packageName);
    }

    async getAppInfo(packageName) {
        return this.adb.getPackageInfo(packageName);
    }

    async startApp(packageName) {
        return this.adb.startApp(packageName);
    }

    async stopApp(packageName) {
        return this.adb.stopApp(packageName);
    }

    async clearApp(packageName) {
        return this.adb.clearApp(packageName);
    }

    async installApp(apkPath) {
        try {
            const result = await this.adb.execute(`install "${apkPath}"`);
            return result.includes('Success');
        } catch (error) {
            throw new Error(`Failed to install app: ${error.message}`);
        }
    }

    async uninstallApp(packageName) {
        try {
            const result = await this.adb.execute(`uninstall ${packageName}`);
            return result.includes('Success');
        } catch (error) {
            throw new Error(`Failed to uninstall app: ${error.message}`);
        }
    }

    // Input methods
    async tap(x, y) {
        return this.adb.tap(x, y);
    }

    async swipe(x1, y1, x2, y2, duration = 300) {
        return this.adb.swipe(x1, y1, x2, y2, duration);
    }

    async type(text) {
        return this.adb.type(text);
    }

    async pressKey(keyCode) {
        return this.adb.keyEvent(keyCode);
    }

    async back() {
        return this.adb.back();
    }

    async home() {
        return this.adb.home();
    }

    async menu() {
        return this.adb.menu();
    }

    async recentApps() {
        return this.adb.recentApps();
    }

    // Network and connectivity
    async enableWifi() {
        return this.adb.shell('svc wifi enable');
    }

    async disableWifi() {
        return this.adb.shell('svc wifi disable');
    }

    async getWifiStatus() {
        const result = await this.adb.shell('dumpsys wifi | grep "Wi-Fi is"');
        return result.includes('enabled');
    }

    async enableMobileData() {
        return this.adb.shell('svc data enable');
    }

    async disableMobileData() {
        return this.adb.shell('svc data disable');
    }

    async getBatteryLevel() {
        const result = await this.adb.shell('dumpsys battery | grep level');
        const match = result.match(/level: (\d+)/);
        return match ? parseInt(match[1]) : null;
    }

    async getBatteryStatus() {
        const result = await this.adb.shell('dumpsys battery');
        const lines = result.split('\n');
        const status = {};

        for (const line of lines) {
            if (line.includes('level:')) {
                status.level = parseInt(line.split(':')[1].trim());
            }
            if (line.includes('status:')) {
                status.status = line.split(':')[1].trim();
            }
            if (line.includes('health:')) {
                status.health = line.split(':')[1].trim();
            }
            if (line.includes('present:')) {
                status.present = line.split(':')[1].trim() === 'true';
            }
        }

        return status;
    }

    // File system operations
    async pushFile(localPath, remotePath) {
        return this.adb.execute(`push "${localPath}" "${remotePath}"`);
    }

    async pullFile(remotePath, localPath) {
        return this.adb.execute(`pull "${remotePath}" "${localPath}"`);
    }

    async listFiles(remotePath) {
        const result = await this.adb.shell(`ls -la "${remotePath}"`);
        return result.split('\n').filter(line => line.trim().length > 0);
    }

    async fileExists(remotePath) {
        try {
            await this.adb.shell(`test -f "${remotePath}" && echo "exists"`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async createDirectory(remotePath) {
        return this.adb.shell(`mkdir -p "${remotePath}"`);
    }

    async removeFile(remotePath) {
        return this.adb.shell(`rm "${remotePath}"`);
    }

    async removeDirectory(remotePath) {
        return this.adb.shell(`rm -rf "${remotePath}"`);
    }

    // System information
    async getSystemProperties() {
        const result = await this.adb.shell('getprop');
        const properties = {};
        const lines = result.split('\n');

        for (const line of lines) {
            const match = line.match(/\[([^\]]+)\]: \[([^\]]*)\]/);
            if (match) {
                properties[match[1]] = match[2];
            }
        }

        return properties;
    }

    async getProperty(property) {
        return this.adb.shell(`getprop ${property}`);
    }

    async setProperty(property, value) {
        return this.adb.shell(`setprop ${property} "${value}"`);
    }

    async getMemoryInfo() {
        const result = await this.adb.shell('cat /proc/meminfo');
        const memInfo = {};
        const lines = result.split('\n');

        for (const line of lines) {
            const match = line.match(/^([^:]+):\s*(\d+)\s*kB/);
            if (match) {
                memInfo[match[1]] = parseInt(match[2]);
            }
        }

        return memInfo;
    }

    async getCpuInfo() {
        const result = await this.adb.shell('cat /proc/cpuinfo');
        return result;
    }

    // Debugging and logging
    async getLogcat(filter = '', lines = 100) {
        let command = `logcat -d`;
        if (lines > 0) {
            command += ` -t ${lines}`;
        }
        if (filter) {
            command += ` ${filter}`;
        }
        return this.adb.shell(command);
    }

    async clearLogcat() {
        return this.adb.shell('logcat -c');
    }

    async dumpSys(service) {
        return this.adb.shell(`dumpsys ${service}`);
    }

    // Utility methods
    async close() {
        await this.back();
    }

    async disconnect() {
        // Clean up any resources
        this._uiHierarchy = null;
        this._screenSize = null;
        this._deviceInfo = null;
        console.log('📱 Device disconnected');
    }

    async reboot() {
        return this.adb.execute('reboot');
    }

    async rebootBootloader() {
        return this.adb.execute('reboot bootloader');
    }

    async rebootRecovery() {
        return this.adb.execute('reboot recovery');
    }

    // Performance monitoring
    async getTopProcesses(count = 10) {
        const result = await this.adb.shell(`top -n 1 | head -${count + 7}`);
        return result;
    }

    async getRunningProcesses() {
        const result = await this.adb.shell('ps');
        const lines = result.split('\n').slice(1); // Skip header
        return lines.map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 9) {
                return {
                    pid: parts[1],
                    ppid: parts[2],
                    vsize: parts[3],
                    rss: parts[4],
                    name: parts[8]
                };
            }
            return null;
        }).filter(proc => proc !== null);
    }

    async killProcess(pid) {
        return this.adb.shell(`kill ${pid}`);
    }

    async forceKillProcess(pid) {
        return this.adb.shell(`kill -9 ${pid}`);
    }
}