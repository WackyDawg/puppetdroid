/**
 * Screen video recording via `adb shell screenrecord`. screenrecord writes to
 * the device, so we record to a temp path and pull it on stop. Note the
 * platform limits: mp4 only, ~180s max per clip, and no output on most emulators.
 */
export class ScreenRecorder {
    constructor(device) {
        this.device = device;
        this._proc = null;
        this._remote = null;
        this._localPath = null;
    }

    get isRecording() { return !!this._proc; }

    async start(localPath = `recording-${Date.now()}.mp4`, options = {}) {
        if (this._proc) throw new Error('Already recording');
        this._localPath = localPath;
        this._remote = `/sdcard/puppetdroid-rec-${Date.now()}.mp4`;

        const flags = [];
        if (options.bitRate) flags.push(`--bit-rate ${options.bitRate}`);
        if (options.size) flags.push(`--size ${options.size}`);
        if (options.timeLimit) flags.push(`--time-limit ${options.timeLimit}`);

        this._proc = this.device.adb.spawnStream(
            ['shell', `screenrecord ${flags.join(' ')} ${this._remote}`],
            () => {}
        );
        return this;
    }

    async stop() {
        if (!this._proc) throw new Error('Not recording');
        // screenrecord only finalizes the mp4 moover atom on SIGINT, not SIGKILL.
        this._proc.kill('SIGINT');
        this._proc = null;
        await this.device.wait(1500);

        await this.device.adb.execute(`pull ${this._remote} "${this._localPath}"`);
        await this.device.adb.shell(`rm -f ${this._remote}`).catch(() => {});
        return this._localPath;
    }
}
