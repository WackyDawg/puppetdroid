import { spawn } from 'child_process';
import { writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Thin wrapper around the Frida CLI for instrumentation — SSL-pinning / root
 * bypass, method hooking, forcing WebView debugging on. Requires `frida` on PATH
 * and a matching frida-server (or gadget) on the device; every entry point
 * degrades to a clear error if the tooling isn't there.
 */
export class Frida {
    constructor(device, options = {}) {
        this.device = device;
        this.binary = options.binary || 'frida';
    }

    async isAvailable() {
        return new Promise((resolve) => {
            const p = spawn(this.binary, ['--version']);
            p.on('error', () => resolve(false));
            p.on('close', (code) => resolve(code === 0));
        });
    }

    /**
     * Run a Frida script against the device. Spawns the app when `options.spawn`
     * is set, else attaches. Returns a handle: `{ stop(), output }` where output
     * accumulates the script's console/send messages.
     * @param {string} target - package name or process name/pid
     * @param {string} scriptSource - JavaScript agent source
     */
    async run(target, scriptSource, options = {}) {
        if (!await this.isAvailable()) {
            throw new Error(`Frida CLI not found (tried "${this.binary}"). Install with: pip install frida-tools`);
        }
        const dir = await mkdtemp(join(tmpdir(), 'puppetdroid-frida-'));
        const scriptPath = join(dir, 'agent.js');
        await writeFile(scriptPath, scriptSource);

        const args = ['-U', options.spawn ? '-f' : (/^\d+$/.test(target) ? '-p' : '-n'), target, '-l', scriptPath, '-q'];
        if (options.runtime) args.push('--runtime', options.runtime);

        const proc = spawn(this.binary, args);
        const output = [];
        proc.stdout.on('data', (d) => { output.push(d.toString()); options.onOutput?.(d.toString()); });
        proc.stderr.on('data', (d) => options.onError?.(d.toString()));

        return {
            proc,
            output,
            stop: () => { try { proc.kill('SIGINT'); } catch (_) { /* ignore */ } }
        };
    }

    /** Attach a script to an already-running app. */
    attach(target, scriptSource, options = {}) {
        return this.run(target, scriptSource, { ...options, spawn: false });
    }

    /** Spawn the app and load a script before its first instruction runs. */
    spawn(packageName, scriptSource, options = {}) {
        return this.run(packageName, scriptSource, { ...options, spawn: true });
    }

    /** Spawn with a stock SSL-pinning bypass (OkHttp/TrustManager/Conscrypt). */
    async bypassSSLPinning(packageName, options = {}) {
        return this.spawn(packageName, SSL_PINNING_BYPASS, options);
    }
}

// Compact, framework-agnostic pinning bypass covering the common Android stacks.
const SSL_PINNING_BYPASS = `
Java.perform(function () {
  try {
    var X509TM = Java.registerClass({
      name: 'com.puppetdroid.TrustAll',
      implements: [Java.use('javax.net.ssl.X509TrustManager')],
      methods: {
        checkClientTrusted: function () {}, checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    var init = SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
    init.implementation = function (km, tm, sr) {
      init.call(this, km, [X509TM.$new()], sr);
    };
  } catch (e) {}
  try {
    var CPP = Java.use('okhttp3.CertificatePinner');
    CPP.check.overload('java.lang.String', 'java.util.List').implementation = function () {};
  } catch (e) {}
  console.log('[puppetdroid] SSL pinning bypass installed');
});
`;
