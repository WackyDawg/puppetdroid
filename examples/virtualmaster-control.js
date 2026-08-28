/**
 * Control a VirtualMaster VM from the host device.
 *
 * VirtualMaster ("dual space" / clone) runs a full Android VM inside an app. Its
 * MainActivity exposes Enter VM, Shutdown VM, Mute, and VM Settings — this drives
 * them by resource-id (the buttons are unlabeled icons) and waits on the real
 * lifecycle, verifying the guest over its network-adb connection.
 *
 * Usage:
 *   node examples/virtualmaster-control.js status
 *   node examples/virtualmaster-control.js stop
 *   node examples/virtualmaster-control.js start
 *   node examples/virtualmaster-control.js restart
 *   node examples/virtualmaster-control.js mute | settings
 *
 * Env / edit below:
 *   HOST   — host device serial running VirtualMaster (USB serial)
 *   GUEST  — the VM's network-adb address (ip:port), for boot verification
 */
import { Puppetdroid } from '../src/index.js';

const HOST = process.env.HOST || '1210715446001626';
const GUEST = process.env.GUEST || '192.168.1.105:10000';
const action = process.argv[2] || 'status';

async function main() {
    const device = await Puppetdroid.connect(HOST);
    const vm = device.virtualMaster({ guestSerial: GUEST });

    switch (action) {
        case 'status': {
            console.log('VM running:', await vm.isRunning());
            break;
        }

        case 'stop': {
            console.log('Shutting down the VM…');
            await vm.shutdown();
            await vm.waitForShutdown();
            console.log('✓ VM stopped');
            break;
        }

        case 'start': {
            console.log('Starting the VM…');
            await vm.start();
            await vm.waitForBoot();
            console.log('✓ VM booted and online');
            break;
        }

        case 'restart': {
            console.log('Restarting the VM…');
            await vm.shutdown();
            await vm.waitForShutdown();
            console.log('  stopped — booting again…');
            await vm.start();
            await vm.waitForBoot();
            console.log('✓ VM restarted');

            // The guest is now controllable as its own puppetdroid device:
            const guest = await vm.guestDevice();
            const app = await guest.getCurrentApp();
            console.log('  guest foreground:', app?.package);
            break;
        }

        case 'mute': await vm.mute(); console.log('✓ toggled mute'); break;
        case 'settings': await vm.openSettings(); console.log('✓ opened VM Settings'); break;

        default:
            console.log(`Unknown action "${action}". Use: status | stop | start | restart | mute | settings`);
    }
    process.exit(0);
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
