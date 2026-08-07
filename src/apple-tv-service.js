import { APP_FEATURE_PREFIX, PARAMS, PLAYBACK_STATE, TRANSPORTS } from './constants.js';
import { FEATURES_BY_KEY } from './features.js';
import { buildDevice, externalIdsFor, featureKeyOf, readParam } from './device-model.js';
import { discoverAppleTvs } from './discovery.js';

/**
 * Orchestration: keeps one live pyatv session per Apple TV the user created in
 * Gladys, routes commands to it, and turns what the device pushes back into
 * Gladys states.
 */
export class AppleTvService {
  /**
   * @param {object} options Options.
   * @param {object} options.gladys Gladys SDK instance.
   * @param {object} options.bridge The pyatv bridge.
   * @param {object} options.config Normalized configuration.
   * @param {object} options.logger Logger.
   */
  constructor({ gladys, bridge, config, logger }) {
    this.gladys = gladys;
    this.bridge = bridge;
    this.config = config;
    this.logger = logger;
    /** identifier -> { device, host, connected, paired, capabilities, apps, lastValues } */
    this.devices = new Map();
    /** Descriptors of the last scan, so a pairing can find a device Gladys does not know yet. */
    this.lastScan = new Map();
    /** In-flight `syncDevices`, so two triggers never open the same session twice. */
    this.syncing = null;
  }

  // -- configuration -------------------------------------------------------

  /**
   * @param {object} config Newly normalized configuration.
   * @returns {void}
   * @example
   * service.setConfig(normalizeConfig(newConfig));
   */
  setConfig(config) {
    this.config = config;
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Open a session for every Apple TV the user created in Gladys.
   *
   * Called on every (re)connection to Gladys: the SDK has just resynchronized
   * `gladys.devices`, and a device may have been created or deleted while the
   * WebSocket was down.
   *
   * Runs one at a time: a reconnection, a device creation and a respawn of the
   * worker can all fire it at once, and opening the same session twice costs a
   * needless disconnection of the one that worked.
   *
   * @returns {Promise<void>} Resolves once every device has been attempted.
   * @example
   * await service.syncDevices();
   */
  async syncDevices() {
    const run = Promise.resolve(this.syncing)
      .catch(() => {})
      .then(() => this._syncDevices());
    this.syncing = run.catch(() => {});
    return run;
  }

  /**
   * @returns {Promise<void>} Resolves once every device has been attempted.
   */
  async _syncDevices() {
    const seen = new Set();

    for (const device of this.gladys.devices || []) {
      const identifier = readParam(device, PARAMS.IDENTIFIER);
      if (!identifier) {
        this.logger.warn(
          `Device ${device.external_id} carries no Apple TV identifier, ignoring it. ` +
            'Run a new scan and recreate it.',
        );
        continue;
      }
      seen.add(identifier);
      const entry = this._entry(identifier);
      entry.device = device;
      entry.host = readParam(device, PARAMS.HOST) || entry.host;
      if (!entry.connected) {
        await this.connectDevice(identifier);
      }
    }

    // A device deleted in Gladys must not keep a session (nor a reconnection
    // loop) open in the worker.
    for (const identifier of [...this.devices.keys()]) {
      if (!seen.has(identifier)) {
        await this.disconnectDevice(identifier);
        this.devices.delete(identifier);
      }
    }

    await this.refreshConnectionStatus();
  }

  /**
   * Record the address of a device, creating its entry when needed.
   *
   * A device can be paired before it exists in Gladys (the pairing action
   * accepts a raw address), so the only place its address is known is the
   * pairing itself.
   *
   * @param {string} identifier pyatv identifier.
   * @param {string} [host] Address to remember.
   * @returns {object} The tracked entry.
   * @example
   * service.rememberHost('92:18:15:B6:6D:D2', '192.168.1.20');
   */
  rememberHost(identifier, host) {
    const entry = this._entry(identifier);
    if (host) {
      entry.host = host;
    }
    if (!entry.device) {
      entry.device =
        (this.gladys.devices || []).find(
          (device) => readParam(device, PARAMS.IDENTIFIER) === identifier,
        ) || null;
    }
    return entry;
  }

  /**
   * @param {string} identifier pyatv identifier.
   * @returns {object} The tracked entry, created on first use.
   */
  _entry(identifier) {
    let entry = this.devices.get(identifier);
    if (!entry) {
      entry = {
        identifier,
        device: null,
        host: null,
        connected: false,
        paired: null,
        capabilities: null,
        apps: [],
        lastValues: new Map(),
      };
      this.devices.set(identifier, entry);
    }
    return entry;
  }

  /**
   * Open (or reopen) the session of one device.
   *
   * @param {string} identifier pyatv identifier.
   * @returns {Promise<boolean>} True when the session is live.
   * @example
   * await service.connectDevice('92:18:15:B6:6D:D2');
   */
  async connectDevice(identifier) {
    const entry = this._entry(identifier);
    if (!entry.host) {
      this.logger.warn(`No known address for ${identifier}, run a scan first.`);
      return false;
    }

    try {
      const result = await this.bridge.request(
        'connect',
        { identifier, host: entry.host },
        { timeout: 45_000 },
      );
      entry.connected = true;
      entry.paired = true;
      entry.capabilities = result.capabilities || {};
      entry.host = result.address || entry.host;
      this.logger.info(`Connected to ${entry.device?.name || identifier} (${entry.host})`);
      await this._loadApps(entry);
      await this.publishDeviceState(identifier, result.state || {});
      await this.publishTransport(identifier, TRANSPORTS.LOCAL);
      return true;
    } catch (error) {
      entry.connected = false;
      if (error.kind === 'NoCredentialsError') {
        entry.paired = false;
        this.logger.warn(`${entry.device?.name || identifier} is not paired yet.`);
      } else {
        this.logger.warn(
          `Could not connect to ${entry.device?.name || identifier}: ${error.message}`,
        );
      }
      await this.publishTransport(identifier, TRANSPORTS.UNREACHABLE);
      return false;
    }
  }

  /**
   * @param {string} identifier pyatv identifier.
   * @returns {Promise<void>} Resolves once the worker released the session.
   * @example
   * await service.disconnectDevice('92:18:15:B6:6D:D2');
   */
  async disconnectDevice(identifier) {
    const entry = this.devices.get(identifier);
    if (entry) {
      entry.connected = false;
    }
    try {
      await this.bridge.request('disconnect', { identifier }, { timeout: 10_000 });
    } catch (error) {
      this.logger.debug?.(`Disconnecting ${identifier} failed: ${error.message}`);
    }
  }

  /**
   * Read the installed applications of a connected device, best effort.
   *
   * @param {object} entry Tracked device entry.
   * @returns {Promise<void>} Always resolves.
   */
  async _loadApps(entry) {
    if (!this.config.appShortcuts || !entry.capabilities?.app_list) {
      entry.apps = [];
      return;
    }
    try {
      const { apps } = await this.bridge.request(
        'app_list',
        { identifier: entry.identifier },
        { timeout: 20_000 },
      );
      entry.apps = apps || [];
      this.logger.info(
        `${entry.apps.length} application(s) found on ${entry.device?.name || entry.identifier}`,
      );
    } catch (error) {
      entry.apps = [];
      this.logger.warn(`Could not list the applications of ${entry.identifier}: ${error.message}`);
    }
  }

  // -- discovery -----------------------------------------------------------

  /**
   * Run a scan and publish the discovered devices.
   *
   * @returns {Promise<Array<object>>} The published devices.
   * @example
   * await service.scan();
   */
  async scan() {
    const knownHosts = [...this.devices.values()].map((entry) => entry.host).filter(Boolean);
    const descriptors = await discoverAppleTvs({
      gladys: this.gladys,
      bridge: this.bridge,
      config: this.config,
      logger: this.logger,
      extraHosts: knownHosts,
    });

    this.lastScan = new Map(descriptors.map((descriptor) => [descriptor.identifier, descriptor]));
    const devices = await this.republish();

    // A device already created in Gladys whose session was never opened (it was
    // paired since the last try, or it just came back online) deserves a new
    // attempt right after a scan: that is exactly what the user just asked for.
    for (const [identifier, entry] of this.devices) {
      if (entry.device && !entry.connected && this.lastScan.has(identifier)) {
        await this.connectDevice(identifier);
      }
    }
    await this.refreshConnectionStatus();
    return devices;
  }

  /**
   * Publish the devices of the last scan again, without touching the network.
   *
   * Used right after a pairing: the fresh connection revealed the real
   * capabilities and the installed applications, and Gladys offers to update
   * the device with them. A full scan there would blow the action deadline for
   * information the integration already has.
   *
   * @returns {Promise<Array<object>>} The published devices.
   * @example
   * await service.republish();
   */
  async republish() {
    const devices = [...this.lastScan.values()].map((descriptor) => {
      const entry = this.devices.get(descriptor.identifier);
      if (entry) {
        // A known device may have moved: remember the address the scan found.
        entry.host = descriptor.address;
      }
      return buildDevice({
        gladys: this.gladys,
        descriptor,
        config: this.config,
        capabilities: entry?.capabilities ?? null,
        apps: entry?.apps ?? [],
        transport: entry?.connected ? TRANSPORTS.LOCAL : TRANSPORTS.UNREACHABLE,
      });
    });

    if (devices.length > 0) {
      await this.gladys.publishDiscoveredDevices(devices);
    }
    return devices;
  }

  /**
   * Remember a device descriptor obtained outside a scan (a pairing).
   *
   * @param {object} descriptor Device descriptor from the worker.
   * @returns {void}
   * @example
   * service.rememberDescriptor(result.device);
   */
  rememberDescriptor(descriptor) {
    if (descriptor?.identifier) {
      this.lastScan.set(descriptor.identifier, descriptor);
    }
  }

  // -- commands ------------------------------------------------------------

  /**
   * Execute a Gladys `set-value` command on the right Apple TV.
   *
   * @param {object} device The Gladys device.
   * @param {object} feature The Gladys device feature.
   * @param {number} value The requested value.
   * @returns {Promise<void>} Resolves when the Apple TV acknowledged the command.
   * @example
   * await service.setValue(device, feature, 1);
   */
  async setValue(device, feature, value) {
    const identifier = readParam(device, PARAMS.IDENTIFIER);
    if (!identifier) {
      throw new Error('This device carries no Apple TV identifier. Run a scan and recreate it.');
    }
    const entry = this._entry(identifier);
    entry.device = entry.device || device;
    entry.host = entry.host || readParam(device, PARAMS.HOST);

    if (!entry.connected) {
      const connected = await this.connectDevice(identifier);
      if (!connected) {
        throw new Error(
          entry.paired === false
            ? `${device.name} is not paired yet. Pair it from the integration configuration screen.`
            : `${device.name} is unreachable. Check that it is powered on and on the same network as Gladys.`,
        );
      }
    }

    const key = featureKeyOf(device, feature);
    if (!key) {
      throw new Error(`Unknown feature: ${feature.external_id}`);
    }

    if (key.startsWith(APP_FEATURE_PREFIX)) {
      await this.bridge.request(
        'command',
        { identifier, action: 'launch_app', value: key.slice(APP_FEATURE_PREFIX.length) },
        { timeout: 30_000 },
      );
      return;
    }

    const definition = FEATURES_BY_KEY.get(key);
    if (!definition?.command) {
      throw new Error(`The "${key}" feature of an Apple TV accepts no command.`);
    }
    const { action, value: commandValue } = definition.command(value);
    await this.bridge.request(
      'command',
      { identifier, action, value: commandValue },
      { timeout: 30_000 },
    );
  }

  /**
   * Answer a Gladys poll: read the device and publish what changed.
   *
   * @param {object} device The Gladys device to poll.
   * @returns {Promise<void>} Resolves once the states are published.
   * @example
   * await service.poll(device);
   */
  async poll(device) {
    const identifier = readParam(device, PARAMS.IDENTIFIER);
    if (!identifier) {
      return;
    }
    const entry = this._entry(identifier);
    entry.device = entry.device || device;
    entry.host = entry.host || readParam(device, PARAMS.HOST);

    if (!entry.connected) {
      // A poll is also the heartbeat that brings back an Apple TV that was
      // switched off when Gladys started.
      await this.connectDevice(identifier);
      return;
    }
    try {
      const { state } = await this.bridge.request('snapshot', { identifier }, { timeout: 20_000 });
      await this.publishDeviceState(identifier, state || {});
    } catch (error) {
      this.logger.warn(`Could not read the state of ${device.name}: ${error.message}`);
    }
  }

  // -- state publication ---------------------------------------------------

  /**
   * Turn a worker state into Gladys states, and publish what changed.
   *
   * The states rate limit (300 per minute per integration) is the reason for
   * the deduplication: an Apple TV pushes a playback update every second while
   * seeking, and republishing an unchanged value would burn the budget for the
   * updates that matter.
   *
   * @param {string} identifier pyatv identifier.
   * @param {object} state Partial state from the worker.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await service.publishDeviceState(identifier, { power: 'on' });
   */
  async publishDeviceState(identifier, state) {
    const entry = this._entry(identifier);
    const ids = externalIdsFor(this.gladys, identifier);
    const states = [];

    const push = (key, value) => {
      if (value === undefined || value === null) {
        return;
      }
      if (entry.lastValues.get(key) === value) {
        return;
      }
      entry.lastValues.set(key, value);
      const payload = { device_feature_external_id: ids.feature(key) };
      if (typeof value === 'string') {
        payload.text = value;
      } else {
        payload.state = value;
      }
      states.push(payload);
    };

    if ('power' in state) {
      const power = state.power === 'on' ? 1 : state.power === 'off' ? 0 : undefined;
      push('power', power);
    }
    if (typeof state.volume === 'number') {
      const volume = Math.min(Math.max(Math.round(state.volume), 0), 100);
      // The same level feeds two sliders: the Music box reads `music/volume`,
      // the remote box reads `television/volume`.
      push('volume', volume);
      push('remote-volume', volume);
    }
    if ('playback_state' in state) {
      push(
        'playback-state',
        state.playback_state === 'playing' ? PLAYBACK_STATE.PLAYING : PLAYBACK_STATE.PAUSED,
      );
      push('now-playing', nowPlayingLabel(state));
    }
    if ('app_name' in state || 'app_identifier' in state) {
      push('application', state.app_name || state.app_identifier || '');
    }

    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishStates(states);
    } catch (error) {
      // Republishing later is fine, but the memory of what was published must
      // not claim a value Gladys never received.
      for (const published of states) {
        const key = published.device_feature_external_id.slice(ids.device.length + 1);
        entry.lastValues.delete(key);
      }
      this.logger.warn(`Could not publish the states of ${identifier}: ${error.message}`);
    }
  }

  /**
   * @param {string} identifier pyatv identifier.
   * @param {string} transport One of TRANSPORTS.
   * @returns {Promise<void>} Always resolves.
   * @example
   * await service.publishTransport(identifier, 'local');
   */
  async publishTransport(identifier, transport) {
    const entry = this.devices.get(identifier);
    if (!entry?.device) {
      return;
    }
    try {
      await this.gladys.publishTransports([{ external_id: entry.device.external_id, transport }]);
    } catch (error) {
      this.logger.debug?.(`Could not publish the transport of ${identifier}: ${error.message}`);
    }
  }

  /**
   * Publish the application-level status shown on the configuration screen.
   *
   * @returns {Promise<void>} Always resolves.
   * @example
   * await service.refreshConnectionStatus();
   */
  async refreshConnectionStatus() {
    const entries = [...this.devices.values()].filter((entry) => entry.device);
    const connected = entries.filter((entry) => entry.connected);

    if (connected.length > 0) {
      const unreachable = entries.length - connected.length;
      const message =
        unreachable > 0
          ? {
              en: `${connected.length} Apple TV connected, ${unreachable} unreachable.`,
              fr: `${connected.length} Apple TV connectée(s), ${unreachable} injoignable(s).`,
            }
          : undefined;
      await this.gladys.setConnectionStatus(true, message).catch(() => {});
      return;
    }

    let message;
    if (entries.length === 0) {
      message = {
        en: 'No Apple TV added yet. Run a scan from the Discovery tab, add your Apple TV, then pair it below.',
        fr: "Aucune Apple TV ajoutée. Lancez une recherche dans l'onglet Découverte, ajoutez votre Apple TV, puis appairez-la ci-dessous.",
      };
    } else if (entries.every((entry) => entry.paired === false)) {
      message = {
        en: 'Apple TV added but not paired yet. Run "Pair an Apple TV" below, then enter the code shown on the screen.',
        fr: "Apple TV ajoutée mais pas encore appairée. Lancez « Appairer une Apple TV » ci-dessous, puis saisissez le code affiché à l'écran.",
      };
    } else {
      message = {
        en: 'No Apple TV reachable. Check that they are powered on and on the same network as Gladys.',
        fr: 'Aucune Apple TV joignable. Vérifiez qu’elles sont allumées et sur le même réseau que Gladys.',
      };
    }
    await this.gladys.setConnectionStatus(false, message).catch(() => {});
  }

  // -- worker events -------------------------------------------------------

  /**
   * Wire the bridge events to the Gladys state channel.
   *
   * @returns {void}
   * @example
   * service.registerBridgeHandlers();
   */
  registerBridgeHandlers() {
    this.bridge.on('state', ({ identifier, state }) => {
      this.publishDeviceState(identifier, state || {}).catch((error) => {
        this.logger.warn(`State update ignored for ${identifier}: ${error.message}`);
      });
    });

    this.bridge.on('connection', ({ identifier, connected, capabilities, error }) => {
      const entry = this._entry(identifier);
      entry.connected = Boolean(connected);
      if (connected) {
        entry.paired = true;
        entry.capabilities = capabilities || entry.capabilities;
        this.logger.info(`${entry.device?.name || identifier} is back online`);
      } else {
        // Nothing is known about the device any more: drop the memory of the
        // published values so the next connection republishes everything.
        entry.lastValues.clear();
        this.logger.warn(
          `${entry.device?.name || identifier} went offline: ${error || 'unknown reason'}`,
        );
      }
      Promise.all([
        this.publishTransport(identifier, connected ? TRANSPORTS.LOCAL : TRANSPORTS.UNREACHABLE),
        this.refreshConnectionStatus(),
      ]).catch(() => {});
    });

    this.bridge.on('down', () => {
      for (const entry of this.devices.values()) {
        entry.connected = false;
        entry.lastValues.clear();
      }
      this.refreshConnectionStatus().catch(() => {});
    });

    // The worker was respawned: it lost every session, they must be reopened.
    this.bridge.on('ready', () => {
      this.syncDevices().catch((error) => {
        this.logger.error(`Could not reopen the Apple TV sessions: ${error.message}`);
      });
    });
  }
}

/**
 * Human-readable label of what is playing.
 *
 * @param {object} state Worker state.
 * @returns {string} The label, empty when nothing is playing.
 * @example
 * nowPlayingLabel({ title: 'Dune', artist: 'Netflix' }); // 'Dune — Netflix'
 */
export function nowPlayingLabel(state) {
  if (!state?.title) {
    return '';
  }
  const parts = [state.title];
  if (state.series_name && state.series_name !== state.title) {
    parts.unshift(state.series_name);
  }
  if (state.artist) {
    parts.push(state.artist);
  }
  return parts.join(' — ');
}
