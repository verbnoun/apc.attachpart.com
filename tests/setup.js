/**
 * Test setup — bridges window.* globals to Vitest environment.
 *
 * Loads source files in the same dependency order as index.html.
 * Each file's window.* assignments become available to tests via globalThis.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Minimal browser globals needed by our code
globalThis.window = globalThis;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;

// Suppress noisy console output from transport layer during tests
const _noop = () => {};
globalThis.console = {
    ...console,
    log: _noop,
    warn: _noop,
    error: _noop
};

/**
 * Load a source file into the global context.
 * Mimics browser <script> tag behavior.
 */
function loadSource(relativePath) {
    const fullPath = join(ROOT, relativePath);
    const code = readFileSync(fullPath, 'utf-8');
    vm.runInThisContext(code, { filename: fullPath });
}

// Load in dependency order (matching index.html <script> order).
// Only non-JSX files — React components are not loaded here.
loadSource('protocol.js');
loadSource('transport.js');
loadSource('chunked-transport.js');
loadSource('midi-connection.js');
loadSource('midi-state.js');
loadSource('topology-utils.js');
loadSource('protocol-dm.js');
loadSource('firmware-uploader.js');
loadSource('api.js');
loadSource('device-registry.js');
loadSource('virtual-device.js');
loadSource('estragon.js');
loadSource('ahab.js');
