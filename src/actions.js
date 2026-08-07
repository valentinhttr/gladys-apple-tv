import { PARAMS } from './constants.js';
import { readParam } from './device-model.js';

/**
 * Handlers of the manifest actions — the buttons of the integration
 * configuration screen.
 *
 * Every handler returns a multi-language message that Gladys displays under the
 * button, or throws: the SDK acks the failure and the message is what the user
 * reads. They are the only place where the pairing sequence lives, because
 * pairing is a conversation (start, read the code on the television, confirm)
 * and a device feature cannot hold one.
 */

// Deadline of one bridge pairing call. The slow part of a pairing is the human
// reading a code off a television, and that happens BETWEEN two actions: each
// individual call is a handshake of a few seconds. Kept well under the
// `timeout_seconds` the manifest declares, because `pair_pin` chains two calls.
const PAIR_TIMEOUT = 45_000;

/**
 * Turn a pairing step returned by the worker into the instruction shown under
 * the button.
 *
 * @param {object} step The `pair_begin` result, or the `next` of a `pair_pin`.
 * @param {object|string} [prefix] Sentence prepended to both languages.
 * @param {object} [options] Options.
 * @param {boolean} [options.clearField] Whether step 2 still holds the previous
 * code. Apple asks for one code per protocol and the Gladys action form keeps
 * what was typed, so the second code has to be typed OVER the first one — the
 * single most confusing moment of the pairing, worth one explicit sentence.
 * @returns {object} A multi-language message.
 * @example
 * describeStep({ protocol: 'AirPlay', device_provides_pin: true, remaining: ['AirPlay'] });
 */
export function describeStep(step, prefix = '', { clearField = false } = {}) {
  const en = typeof prefix === 'string' ? prefix : prefix.en;
  const fr = typeof prefix === 'string' ? prefix : prefix.fr;
  const left = step.remaining?.length || 1;
  const stepsEn = `${step.protocol}, ${left} step(s) left`;
  const stepsFr = `${step.protocol}, ${left} étape(s) restante(s)`;
  const enter = clearField
    ? {
        en: 'Clear the "Code" field of step 2 and type this new code in its place',
        fr: "Effacez le champ « Code » de l'étape 2 et saisissez ce nouveau code à la place",
      }
    : {
        en: 'Enter it in step 2',
        fr: "Saisissez-le dans l'étape 2",
      };

  if (step.device_provides_pin) {
    return {
      en: `${en}a ${clearField ? 'new ' : ''}code is displayed on your television (${stepsEn}). ${enter.en} right away — it expires.`,
      fr: `${fr}un ${clearField ? 'nouveau ' : ''}code s'affiche sur votre téléviseur (${stepsFr}). ${enter.fr} tout de suite — il expire.`,
    };
  }
  return {
    en: `${en}type the code ${step.pin} on your television (${stepsEn}). ${enter.en}.`,
    fr: `${fr}saisissez le code ${step.pin} sur votre téléviseur (${stepsFr}). ${enter.fr}.`,
  };
}

/**
 * Find the Apple TV targeted by an action.
 *
 * The `device` field of every action is a `select` with `source: "devices"`:
 * the Configuration screen fills the dropdown with the Apple TVs already added
 * to Gladys and submits the `external_id` of the chosen one. Nobody has to look
 * up an IP address to pair a device any more — the price is that an Apple TV
 * must be added from the Discovery tab BEFORE it can be paired, which is the
 * order the manifest walks the user through anyway.
 *
 * Dynamic options need a core that resolves them server side (Gladys 4.85.0,
 * `getDynamicOptions`); before that, such a field was rejected with "must be
 * one of " and an empty list, hence the `gladys_version` floor in the manifest.
 *
 * Also accepted, for a handler reached outside the form: a name, a selector or
 * an IP address, and nothing at all when a single Apple TV exists.
 *
 * @param {object} options Options.
 * @param {object} options.gladys Gladys SDK instance.
 * @param {object} options.service The Apple TV service.
 * @param {object} options.fields Values of the action form.
 * @returns {Promise<object>} `{ identifier, host, name }`.
 * @example
 * await resolveTarget({ gladys, service, fields });
 */
export async function resolveTarget({ gladys, service, fields }) {
  const wanted = typeof fields?.device === 'string' ? fields.device.trim() : '';
  const devices = gladys.devices || [];

  if (!wanted) {
    if (devices.length === 1) {
      return fromGladysDevice(devices[0], service);
    }
    if (devices.length === 0) {
      throw new Error(
        'No Apple TV added yet. Run a scan from the Discovery tab and add yours first.',
      );
    }
    throw new Error('Pick the Apple TV you want to act on in the list above.');
  }

  const matched = devices.find(
    (device) =>
      device.external_id === wanted ||
      device.selector === wanted ||
      device.name?.toLowerCase() === wanted.toLowerCase() ||
      readParam(device, PARAMS.HOST) === wanted,
  );
  if (matched) {
    return fromGladysDevice(matched, service);
  }

  const known = devices.map((device) => device.name).join(', ');
  throw new Error(
    `No Apple TV matches "${wanted}". It was probably deleted — run a scan from the Discovery tab and add it again. Known: ${known || 'none'}.`,
  );
}

/**
 * Read the target out of a device Gladys already knows.
 *
 * @param {object} device A Gladys device of this integration.
 * @param {object} service The Apple TV service.
 * @returns {object} `{ identifier, host, name }`.
 * @example
 * fromGladysDevice(device, service);
 */
function fromGladysDevice(device, service) {
  const identifier = readParam(device, PARAMS.IDENTIFIER);
  if (!identifier) {
    throw new Error(`${device.name} carries no Apple TV identifier. Run a scan and recreate it.`);
  }
  const host = service.devices.get(identifier)?.host || readParam(device, PARAMS.HOST);
  if (!host) {
    throw new Error(`No known address for ${device.name}. Run a scan first.`);
  }
  return { identifier, host, name: device.name };
}

/**
 * Build the action handlers, keyed by manifest action key.
 *
 * @param {object} options Options.
 * @param {object} options.gladys Gladys SDK instance.
 * @param {object} options.bridge The pyatv bridge.
 * @param {object} options.service The Apple TV service.
 * @param {object} options.logger Logger.
 * @returns {object} Handlers keyed by action key.
 * @example
 * const handlers = buildActions({ gladys, bridge, service, logger });
 */
export function buildActions({ gladys, bridge, service, logger }) {
  // Last code submitted in the current pairing conversation. Apple asks for one
  // code per protocol and the action form keeps what was typed, so submitting
  // the same value twice means the field was never cleared — and burning the
  // fresh code the television is showing to say "wrong code" would be cruel.
  let lastPin = null;

  return {
    /** Step 1: open a pairing session; the Apple TV shows a code. */
    pair_start: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      logger.info(`Starting the pairing of ${target.name} (${target.host})`);
      lastPin = null;

      // The Apple TV refuses to pair a protocol it is currently serving, and
      // the worker drops the session on `pair_begin`.
      service.rememberHost(target.identifier, target.host).connected = false;

      const result = await bridge.request(
        'pair_begin',
        { identifier: target.identifier, host: target.host },
        { timeout: PAIR_TIMEOUT },
      );

      if (result.done) {
        await service.connectDevice(target.identifier);
        await service.refreshConnectionStatus();
        return {
          en: `${target.name} is already paired. Nothing else to do.`,
          fr: `${target.name} est déjà appairée. Rien d'autre à faire.`,
        };
      }

      return describeStep(result, `${target.name}: `);
    },

    /** Step 2: confirm the code. Repeat until every protocol is paired. */
    pair_pin: async (fields) => {
      const pin = typeof fields?.pin === 'string' ? fields.pin.trim() : '';
      if (!pin) {
        throw new Error('Enter the code displayed on your television.');
      }
      if (pin === lastPin) {
        throw new Error(
          `${pin} is the code you already entered. Your television is showing a NEW code: clear the field above and type that one instead.`,
        );
      }
      lastPin = pin;

      // The worker chains to the next protocol itself, and reopens a session
      // when a code expired: one call is always one screenful of instructions.
      const result = await bridge.request('pair_pin', { pin }, { timeout: PAIR_TIMEOUT });
      const identifier = result.device?.identifier;

      if (result.next) {
        const prefix = result.failure
          ? {
              en: `That code did not work (${result.failure}). A new one is on its way. `,
              fr: `Ce code n'a pas fonctionné (${result.failure}). Un nouveau code arrive. `,
            }
          : {
              en: `${result.paired_protocol} is paired. `,
              fr: `${result.paired_protocol} est appairé. `,
            };
        return describeStep(result.next, prefix, { clearField: true });
      }

      if (result.failure) {
        throw new Error(result.failure);
      }
      lastPin = null;

      if (identifier) {
        // The worker answers with the address it actually reached, which is the
        // authoritative one after a DHCP lease changed under us.
        service.rememberHost(identifier, result.device?.address);
        service.rememberDescriptor(result.device);
        await service.connectDevice(identifier);
        // The connection revealed the real capabilities and the installed apps:
        // republishing lets Gladys offer to update the device with them. No
        // network scan here — the action deadline is for the human, not for a
        // second discovery.
        await service.republish().catch((error) => {
          logger.warn(`Could not republish after the pairing: ${error.message}`);
        });
      }
      await service.refreshConnectionStatus();

      return {
        en: 'Pairing complete. Last step: go back to the Discovery tab and press "Update" on your Apple TV, to get the volume control and the application shortcuts the pairing just revealed.',
        fr: "Appairage terminé. Dernière étape : retournez dans l'onglet Découverte et cliquez sur « Mettre à jour » sur votre Apple TV, pour récupérer le volume et les raccourcis d'applications révélés par l'appairage.",
      };
    },

    /** Drop the stored credentials, so the device can be paired again. */
    unpair: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      await bridge.request('forget', { identifier: target.identifier }, { timeout: 20_000 });
      const entry = service.devices.get(target.identifier);
      if (entry) {
        entry.connected = false;
        entry.paired = false;
        entry.capabilities = null;
        entry.apps = [];
        entry.lastValues.clear();
      }
      await service.refreshConnectionStatus();
      return {
        en: `The credentials of ${target.name} have been deleted. Run the pairing again to use it.`,
        fr: `Les identifiants de ${target.name} ont été supprimés. Relancez l'appairage pour l'utiliser.`,
      };
    },

    /** Launch an application by bundle identifier or deep link. */
    launch_app: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      const appId = typeof fields?.app_id === 'string' ? fields.app_id.trim() : '';
      if (!appId) {
        throw new Error(
          'Enter the bundle identifier of the application, e.g. com.netflix.Netflix.',
        );
      }
      await bridge.request(
        'command',
        { identifier: target.identifier, action: 'launch_app', value: appId },
        { timeout: 30_000 },
      );
      return {
        en: `${appId} launched on ${target.name}.`,
        fr: `${appId} lancé sur ${target.name}.`,
      };
    },

    /** List the installed applications, to find a bundle identifier. */
    list_apps: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      const { apps } = await bridge.request(
        'app_list',
        { identifier: target.identifier },
        { timeout: 30_000 },
      );
      if (!apps?.length) {
        throw new Error('This Apple TV did not return any application.');
      }
      const list = apps.map((app) => `${app.name} — ${app.identifier}`).join('\n');
      return { en: list, fr: list };
    },

    /** Open a URL or a deep link (AirPlay video). */
    play_url: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      const url = typeof fields?.url === 'string' ? fields.url.trim() : '';
      if (!/^https?:\/\//.test(url)) {
        throw new Error('Enter a URL starting with http:// or https://.');
      }
      await bridge.request(
        'command',
        { identifier: target.identifier, action: 'play_url', value: url },
        { timeout: 40_000 },
      );
      return {
        en: `URL sent to ${target.name}.`,
        fr: `URL envoyée à ${target.name}.`,
      };
    },

    /** Reopen the session and read the device again. */
    refresh: async (fields) => {
      const target = await resolveTarget({ gladys, service, fields });
      const connected = await service.connectDevice(target.identifier);
      await service.refreshConnectionStatus();
      if (!connected) {
        throw new Error(
          `${target.name} is unreachable. Check that it is powered on and on the same network as Gladys.`,
        );
      }
      return {
        en: `${target.name} is connected and its state has been refreshed.`,
        fr: `${target.name} est connectée et son état a été actualisé.`,
      };
    },
  };
}
