import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Where the Python interpreter lives in the image (see the Dockerfile). */
const DEFAULT_PYTHON = process.env.PYATV_PYTHON || '/opt/pyatv/bin/python3';

/** Default deadline of a bridge call. Scans and pairings pass their own. */
const DEFAULT_TIMEOUT = 25_000;

/** Backoff used when the Python process dies and has to be respawned. */
const RESPAWN_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Node side of the pyatv bridge: spawns the Python worker, speaks the
 * newline-delimited JSON protocol described in `src/pyatv_bridge.py`, and keeps
 * the process alive for the lifetime of the integration.
 *
 * Emits:
 * - `ready` when the worker announces itself (also after a respawn);
 * - `state` `{ identifier, state }` for every push update;
 * - `connection` `{ identifier, connected, capabilities?, error? }`;
 * - `down` when the worker died and the in-flight calls were rejected.
 */
export class PyatvBridge extends EventEmitter {
  /**
   * @param {object} options Options.
   * @param {object} options.logger Logger.
   * @param {string} [options.python] Python interpreter path.
   * @param {string} [options.script] Path of the Python worker.
   */
  constructor({ logger, python = DEFAULT_PYTHON, script } = {}) {
    super();
    this.logger = logger;
    this.python = python;
    this.script = script || fileURLToPath(new URL('./pyatv_bridge.py', import.meta.url));
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
    this.respawnAttempt = 0;
    this.respawnTimer = null;
  }

  /**
   * Start the worker. Safe to call again: a running worker is left alone.
   *
   * @returns {void}
   * @example
   * bridge.start();
   */
  start() {
    if (this.child || this.stopping) {
      return;
    }
    this.logger.info(`Starting the pyatv worker (${this.python} ${this.script})`);
    // stderr is inherited: the worker logs there, and the Gladys supervisor
    // captures the container output.
    const child = spawn(this.python, [this.script], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.child = child;

    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => this._onLine(line));

    child.on('error', (error) => {
      this.logger.error(`The pyatv worker could not be started: ${error.message}`);
    });
    child.on('exit', (code, signal) => this._onExit(code, signal));
  }

  /**
   * Stop the worker for good (no respawn) and reject the in-flight calls.
   *
   * @returns {Promise<void>} Resolves once the process is gone.
   * @example
   * await bridge.stop();
   */
  async stop() {
    this.stopping = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.child;
    if (!child) {
      return;
    }
    // Closing stdin is the documented shutdown of the worker: it closes its
    // sessions and saves the credential storage before exiting.
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Call a worker method.
   *
   * @param {string} method Method name, e.g. `scan`.
   * @param {object} [params] Method parameters.
   * @param {object} [options] Options.
   * @param {number} [options.timeout] Deadline in milliseconds.
   * @returns {Promise<object>} The method result.
   * @example
   * await bridge.request('scan', { hosts: ['192.168.1.20'] }, { timeout: 20000 });
   */
  request(method, params = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (!this.child) {
      this.start();
    }
    if (!this.child) {
      return Promise.reject(new Error('The pyatv worker is not running.'));
    }
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Apple TV worker did not answer "${method}" in ${timeout} ms.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * @param {string} line One JSON line written by the worker.
   * @returns {void}
   */
  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn(`Ignoring an unreadable line from the pyatv worker: ${line.slice(0, 200)}`);
      return;
    }

    if (message.event) {
      const { event, ...payload } = message;
      if (event === 'ready') {
        this.respawnAttempt = 0;
      }
      this.emit(event, payload);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result ?? {});
      return;
    }
    const error = new Error(message.error?.message || `"${pending.method}" failed.`);
    error.kind = message.error?.kind;
    pending.reject(error);
  }

  /**
   * @param {number|null} code Exit code.
   * @param {string|null} signal Signal that killed the process.
   * @returns {void}
   */
  _onExit(code, signal) {
    this.child = null;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`The pyatv worker stopped (${reason}) while running "${pending.method}".`),
      );
      this.pending.delete(id);
    }

    if (this.stopping) {
      return;
    }
    this.emit('down', { reason });
    const delay = RESPAWN_DELAYS[Math.min(this.respawnAttempt, RESPAWN_DELAYS.length - 1)];
    this.respawnAttempt += 1;
    this.logger.error(`The pyatv worker stopped (${reason}), restarting in ${delay} ms`);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.start();
    }, delay);
  }
}
