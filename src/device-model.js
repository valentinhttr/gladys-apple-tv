import {
  APP_FEATURE_PREFIX,
  DEVICE_TYPE,
  PARAMS,
  toDeviceName,
  toPlatformId,
} from './constants.js';
import { selectFeatures } from './features.js';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

/**
 * Building the Gladys device that represents one Apple TV.
 */

/**
 * External ids of one Apple TV.
 *
 * @param {object} gladys Gladys SDK instance.
 * @param {string} identifier pyatv identifier.
 * @returns {object} `{ device, feature(key) }`.
 * @example
 * externalIdsFor(gladys, '92:18:15:B6:6D:D2');
 */
export function externalIdsFor(gladys, identifier) {
  return gladys.externalIds(DEVICE_TYPE, toPlatformId(identifier));
}

/**
 * Read a device param.
 *
 * @param {object} device A Gladys device.
 * @param {string} name Param name.
 * @returns {string|undefined} The value, when set.
 * @example
 * readParam(device, PARAMS.HOST);
 */
export function readParam(device, name) {
  return device?.params?.find((param) => param.name === name)?.value;
}

/**
 * The feature key of a feature of this integration.
 *
 * @param {object} device The Gladys device the feature belongs to.
 * @param {object} feature The Gladys device feature.
 * @returns {string|undefined} The key, e.g. `power` or `app:com.netflix.Netflix`.
 * @example
 * featureKeyOf(device, feature); // 'power'
 */
export function featureKeyOf(device, feature) {
  const prefix = `${device?.external_id}:`;
  const externalId = feature?.external_id || '';
  return externalId.startsWith(prefix) ? externalId.slice(prefix.length) : undefined;
}

/**
 * Build the Gladys device payload of one Apple TV.
 *
 * @param {object} options Options.
 * @param {object} options.gladys Gladys SDK instance.
 * @param {object} options.descriptor Device descriptor from the pyatv worker.
 * @param {object} options.config Normalized configuration.
 * @param {object|null} [options.capabilities] Capabilities of the live connection, when known.
 * @param {Array<object>} [options.apps] Installed applications, when known.
 * @param {string} [options.transport] Gladys transport status of the device.
 * @returns {object} A device in the standard Gladys format.
 * @example
 * buildDevice({ gladys, descriptor, config });
 */
export function buildDevice({
  gladys,
  descriptor,
  config,
  capabilities = null,
  apps = [],
  transport,
}) {
  const ids = externalIdsFor(gladys, descriptor.identifier);
  // "Séjour" becomes "Apple TV Séjour": the name is the only thing an
  // integration controls here, and the core derives the selector from it.
  const name = toDeviceName(descriptor.name, descriptor.address);

  const features = selectFeatures(capabilities).map((feature) => ({
    name: feature.name,
    external_id: ids.feature(feature.key),
    category: feature.category,
    type: feature.type,
    // Gladys stores min and max as NOT NULL: a feature without them is
    // rejected with a 422 when the user creates the device.
    min: feature.min,
    max: feature.max,
    read_only: feature.read_only,
    has_feedback: feature.has_feedback,
    keep_history: feature.keep_history,
  }));

  if (config.appShortcuts && config.maxAppShortcuts > 0) {
    for (const app of apps.slice(0, config.maxAppShortcuts)) {
      features.push({
        name: app.name,
        external_id: ids.feature(`${APP_FEATURE_PREFIX}${app.identifier}`),
        category: DEVICE_FEATURE_CATEGORIES.BUTTON,
        // `push`, not `click`: `click` is what a physical button REPORTS, and
        // the dashboard only renders `button/push` as something pressable.
        type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      });
    }
  }

  const params = [
    { name: PARAMS.IDENTIFIER, value: String(descriptor.identifier) },
    { name: PARAMS.HOST, value: String(descriptor.address) },
    { name: PARAMS.MODEL, value: String(descriptor.model || 'Apple TV') },
  ];
  if (transport) {
    // Reserved Gladys param: rendered as a badge on the device.
    params.push({ name: 'GLADYS_TRANSPORT', value: transport });
  }

  return {
    name,
    external_id: ids.device,
    // No selector: the core strips the one an integration publishes and
    // derives it from the name instead. Publishing one only makes the code lie
    // about what the user will end up seeing.
    //
    // The Apple TV pushes what it can, but power and volume have no push on
    // every model: a reconciliation poll keeps the dashboard honest.
    //
    // `should_poll` is not optional next to `poll_frequency`, even though the
    // SDK does not mention it: the core only schedules a poll for
    // `should_poll === true`, and — worse — a device carrying a poll frequency
    // it never registered makes every later UPDATE of that device crash
    // (`device.create` dereferences the empty `devicesByPollFrequency` bucket).
    // That is the 500 behind "an error occurred while saving this device".
    should_poll: true,
    poll_frequency: config.pollFrequency,
    features,
    params,
  };
}
