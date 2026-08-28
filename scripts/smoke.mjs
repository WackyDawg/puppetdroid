// Device-free smoke test for CI: the package must import and expose its full
// public surface. Anything that needs a real phone is out of scope here.
import Puppetdroid, * as api from '../src/index.js'

const EXPORTS = [
  'Puppetdroid', 'AndroidDevice', 'ADB', 'Page', 'AndroidElement', 'Gestures', 'Selector',
  'ChromeDOM', 'DOMElementHandle', 'CDPConnection', 'NetworkCapture', 'Interceptor',
  'Logcat', 'ScreenRecorder', 'Codegen', 'Intents', 'Frida', 'Mitmproxy', 'Vision',
  'System', 'AIVision', 'Agent', 'createProvider', 'VirtualMaster', 'expect',
]
const STATICS = ['connect', 'launch', 'launchChrome', 'newPage', 'devices', 'checkADB']

const missing = EXPORTS.filter((n) => !(n in api))
const noStatic = STATICS.filter((m) => typeof Puppetdroid[m] !== 'function')

if (missing.length) { console.error('Missing exports:', missing.join(', ')); process.exit(1) }
if (noStatic.length) { console.error('Missing static methods:', noStatic.join(', ')); process.exit(1) }
if (api.Puppetdroid !== Puppetdroid) { console.error('Default and named Puppetdroid differ'); process.exit(1) }

console.log(`✓ smoke ok — ${EXPORTS.length} exports, ${STATICS.length} static methods`)
