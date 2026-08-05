import { EventEmitter } from 'node:events';

/** A logger that records instead of writing, so tests stay quiet. */
export function fakeLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const logger = {
    lines,
    debug: (...args) => lines.debug.push(args.join(' ')),
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
    child: () => logger,
  };
  return logger;
}

/**
 * A minimal stand-in for the Gladys SDK: the same surface the integration uses,
 * recording what it was asked to publish.
 */
export class FakeGladys extends EventEmitter {
  constructor({ selector = 'apple-tv-test', devices = [], config = {} } = {}) {
    super();
    this.selector = selector;
    this.devices = devices;
    this.config = config;
    this.published = [];
    this.states = [];
    this.transports = [];
    this.connectionStatus = null;
    this.scanNetworkResults = [];
    this.scanNetworkError = null;
  }

  externalId(suffix) {
    return `ext:${this.selector}:${suffix}`;
  }

  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return { device, feature: (key) => `${device}:${key}` };
  }

  async publishDiscoveredDevices(devices) {
    this.published.push(devices);
    return { success: true, count: devices.length };
  }

  async publishStates(states) {
    this.states.push(...states);
    return { success: true };
  }

  async publishState(externalId, value) {
    this.states.push({ device_feature_external_id: externalId, value });
    return { success: true };
  }

  async publishTransports(transports) {
    this.transports.push(...transports);
    return { success: true };
  }

  async setConnectionStatus(connected, message) {
    this.connectionStatus = { connected, message };
    return { success: true };
  }

  async scanNetwork() {
    if (this.scanNetworkError) {
      throw this.scanNetworkError;
    }
    return this.scanNetworkResults;
  }
}

/** A stand-in for the pyatv bridge, driven by a table of canned answers. */
export class FakeBridge extends EventEmitter {
  constructor(handlers = {}) {
    super();
    this.handlers = handlers;
    this.calls = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) {
      return {};
    }
    return typeof handler === 'function' ? handler(params) : handler;
  }
}

/** A device descriptor as the pyatv worker produces it. */
export function descriptor(overrides = {}) {
  return {
    identifier: '92:18:15:B6:6D:D2',
    all_identifiers: ['92:18:15:B6:6D:D2', '921815B66DD2'],
    name: 'Living room',
    address: '192.168.1.20',
    model: 'Apple TV 4K (gen 3)',
    raw_model: 'AppleTV14,1',
    operating_system: 'tvos',
    version: '26.5',
    mac: '92:18:15:B6:6D:D2',
    services: [],
    is_apple_tv: true,
    pairing_needed: [],
    ...overrides,
  };
}
