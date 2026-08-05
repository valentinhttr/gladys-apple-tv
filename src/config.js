/**
 * Normalization of the integration configuration.
 *
 * Values arrive from the Gladys configuration form, so every one of them can be
 * missing, empty or a string where a number is expected. The rest of the code
 * reads the normalized object and never the raw one.
 */

/** Poll frequencies Gladys accepts, in milliseconds (DEVICE_POLL_FREQUENCIES). */
export const POLL_FREQUENCIES = [1000, 2000, 10000, 15000, 30000, 60000];

export const DEFAULTS = {
  scanTimeout: 8,
  pollFrequency: 30000,
  appShortcuts: true,
  maxAppShortcuts: 25,
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether a string is a plain IPv4 address.
 *
 * @param {unknown} value Candidate address.
 * @returns {boolean} True for a well-formed IPv4 address.
 * @example
 * isIpv4('192.168.1.20'); // true
 */
export function isIpv4(value) {
  const match = IPV4.exec(String(value ?? '').trim());
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Parse the comma/space/semicolon separated list of manual hosts.
 *
 * @param {unknown} value Raw configuration value.
 * @returns {Array<string>} Unique, well-formed IPv4 addresses.
 * @example
 * parseHosts('192.168.1.20, 192.168.1.21');
 */
export function parseHosts(value) {
  if (typeof value !== 'string') {
    return [];
  }
  const hosts = value
    .split(/[\s,;]+/)
    .map((host) => host.trim())
    .filter(isIpv4);
  return [...new Set(hosts)];
}

/**
 * @param {unknown} value Raw value.
 * @param {number} fallback Value used when the raw one is unusable.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped number.
 * @example
 * toBoundedNumber('40', 8, 2, 25); // 25
 */
function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/**
 * @param {unknown} value Raw value.
 * @param {boolean} fallback Value used when the raw one is missing.
 * @returns {boolean} The boolean value.
 * @example
 * toBoolean('false', true); // false
 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value !== false && value !== 'false' && value !== 0 && value !== '0';
}

/**
 * Normalize the raw Gladys configuration.
 *
 * @param {object} [raw] Raw configuration from `gladys.config`.
 * @returns {object} `{ manualHosts, scanTimeout, pollFrequency, appShortcuts, maxAppShortcuts }`.
 * @example
 * normalizeConfig({ scan_timeout: '10' });
 */
export function normalizeConfig(raw = {}) {
  const config = raw || {};
  const pollFrequency = Number(config.poll_frequency);
  return {
    manualHosts: parseHosts(config.manual_hosts),
    // Gladys keeps the mediated scan HTTP request open for the whole duration,
    // so this bound is also what the SDK request timeout is sized against.
    scanTimeout: toBoundedNumber(config.scan_timeout, DEFAULTS.scanTimeout, 2, 25),
    pollFrequency: POLL_FREQUENCIES.includes(pollFrequency)
      ? pollFrequency
      : DEFAULTS.pollFrequency,
    appShortcuts: toBoolean(config.enable_app_shortcuts, DEFAULTS.appShortcuts),
    maxAppShortcuts: toBoundedNumber(config.max_app_shortcuts, DEFAULTS.maxAppShortcuts, 0, 100),
  };
}
