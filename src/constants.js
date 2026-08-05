/**
 * Shared identifiers of the integration.
 *
 * External ids are built as `ext:<selector>:apple-tv:<platform id>` for the
 * device and `<device external id>:<feature key>` for its features. The
 * platform id is a sanitized pyatv identifier (the Apple TV MAC address), so it
 * carries no separator and a feature key can always be recovered by removing
 * the device prefix.
 */

/** Device type namespace passed to `gladys.externalIds()`. */
export const DEVICE_TYPE = 'apple-tv';

/** Device params. Everything the integration needs to talk to a device again after a restart. */
export const PARAMS = {
  /** pyatv identifier, the one the bridge and the credential storage are keyed on. */
  IDENTIFIER: 'APPLE_TV_IDENTIFIER',
  /** Last known IPv4 address. Refreshed on every scan, DHCP moves devices around. */
  HOST: 'APPLE_TV_HOST',
  /** Human-readable model, e.g. "Apple TV 4K (gen 3)". */
  MODEL: 'APPLE_TV_MODEL',
};

/** Prefix of the app shortcut feature keys: `app:com.netflix.Netflix`. */
export const APP_FEATURE_PREFIX = 'app:';

/** Gladys transport values (mirror of DEVICE_TRANSPORTS in the SDK). */
export const TRANSPORTS = {
  LOCAL: 'local',
  UNREACHABLE: 'unreachable',
};

/** Playback states published on the `music`/`playback_state` feature. */
export const PLAYBACK_STATE = {
  PLAYING: 1,
  PAUSED: 0,
};

/**
 * Turn a pyatv identifier into an external-id-safe platform id.
 *
 * @param {string} identifier pyatv identifier, e.g. `92:18:15:B6:6D:D2`.
 * @returns {string} Sanitized id, e.g. `921815b66dd2`.
 * @example
 * toPlatformId('92:18:15:B6:6D:D2'); // '921815b66dd2'
 */
export function toPlatformId(identifier) {
  return String(identifier)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Build the name of one Apple TV in Gladys.
 *
 * An Apple TV is named after the room it sits in ("Séjour", "Chambre"), which
 * says nothing about what the device is once it lands in a list next to a
 * thermostat and three lamps. The device is therefore prefixed, unless the user
 * already named it that way on the Apple TV itself.
 *
 * This is also what makes the SELECTOR readable, and the only thing that can:
 * the Gladys core strips the selector an integration publishes and derives its
 * own from the name (`externalIntegration.setDiscoveredDevices` drops it,
 * `device.create` calls `buildUniqueSelector(name)`). "Apple TV Séjour" is
 * therefore what turns `sejour` into `apple-tv-sejour`.
 *
 * @param {string} name Device name announced by the Apple TV.
 * @param {string} [address] IPv4 address, used when the announcement carries no name.
 * @returns {string} e.g. `Apple TV Séjour`.
 * @example
 * toDeviceName('Séjour'); // 'Apple TV Séjour'
 * toDeviceName('Apple TV Salon'); // 'Apple TV Salon'
 */
export function toDeviceName(name, address) {
  const announced = String(name ?? '').trim();
  if (!announced) {
    return `Apple TV (${address})`;
  }
  return /^apple\s*tv\b/i.test(announced) ? announced : `Apple TV ${announced}`;
}
