import { nowPlayingLabel } from './apple-tv-service.js';
import { APP_FEATURE_PREFIX, PARAMS } from './constants.js';
import { readParam } from './device-model.js';

const label = (en, fr) => ({ en, fr });
const short = (text, max) =>
  String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text);

const PLAYBACK_LABELS = {
  playing: label('Playing', 'En lecture'),
  paused: label('Paused', 'En pause'),
  stopped: label('Stopped', 'Arrêtée'),
  loading: label('Loading', 'Chargement'),
  seeking: label('Seeking', 'Déplacement'),
  idle: label('No media', 'Aucun média'),
};

// Render from the existing session cache: opening a dashboard never wakes a TV.
export function buildWidget({ gladys, service, key, settings = {} }) {
  const device = gladys.devices.find((item) => item.external_id === settings.device);
  const entry = device && service.devices.get(readParam(device, PARAMS.IDENTIFIER));
  const components = [];
  const commands = new Map();
  const content = { ttl_seconds: 10, components };
  const result = { content, commands, device };
  const body = (text) => components.push({ type: 'text', variant: 'body', text });
  const button = (action, text, icon, feature, value = 1) => {
    components.push({ type: 'button', label: text, icon, action: { key: action } });
    commands.set(action, { feature, value });
  };

  if (!device) {
    body(
      label(
        'Choose an Apple TV in the widget settings.',
        'Choisissez une Apple TV dans les réglages du widget.',
      ),
    );
    return result;
  }
  components.push({ type: 'text', variant: 'heading', text: short(device.name, 40) });
  if (entry?.paired === false) {
    body(
      label(
        'Pair this Apple TV in the integration settings.',
        'Appairez cette Apple TV dans la configuration de l’intégration.',
      ),
    );
    return result;
  }
  if (!entry?.connected) {
    body(
      label(
        'Apple TV unreachable. Check its power and network connection.',
        'Apple TV injoignable. Vérifiez son alimentation et sa connexion réseau.',
      ),
    );
    return result;
  }

  const state = entry.state;
  const capabilities = entry.capabilities || {};
  if (key === 'playback') {
    const standby = state.power === 'off';
    const items = [
      {
        label: label('Playback', 'Lecture'),
        value: standby
          ? label('Standby', 'En veille')
          : PLAYBACK_LABELS[state.playback_state] || label('Unknown', 'État inconnu'),
      },
    ];
    if (!standby && state.app_name) {
      items.push({ label: label('Application', 'Application'), value: short(state.app_name, 40) });
    }
    if (!standby && !['idle', 'stopped'].includes(state.playback_state)) {
      const title = nowPlayingLabel(state);
      if (title) body(short(title, 300));
    }
    components.push({ type: 'status', items });
    if (standby) {
      if (capabilities.turn_on) button('power_on', label('Turn on', 'Allumer'), 'power', 'power');
      return result;
    }
    const playing = state.playback_state === 'playing';
    if (capabilities[playing ? 'pause' : 'play']) {
      button(
        playing ? 'pause' : 'play',
        playing ? label('Pause', 'Pause') : label('Play', 'Lecture'),
        playing ? 'pause' : 'play',
        playing ? 'pause' : 'play',
      );
    }
    if (capabilities.skip_backward)
      button('rewind', label('Skip backward', 'Reculer'), 'rewind', 'rewind');
    if (capabilities.skip_forward)
      button('forward', label('Skip forward', 'Avancer'), 'fast-forward', 'forward');
    if (capabilities.turn_off)
      button('power_off', label('Standby', 'Mettre en veille'), 'power', 'power', 0);
    return result;
  }

  if (!service.config.appShortcuts) {
    body(
      label(
        'Enable application shortcuts in the integration settings.',
        'Activez les raccourcis d’applications dans la configuration de l’intégration.',
      ),
    );
    return result;
  }
  if (!capabilities.launch_app || !entry.apps.length) {
    body(
      label(
        'No applications available. Run a scan after pairing.',
        'Aucune application disponible. Lancez un scan après l’appairage.',
      ),
    );
    return result;
  }
  const missing = [];
  const selected = new Set();
  for (let i = 1; i <= 4; i++) {
    const name = String(settings[`favorite_${i}`] || '').trim();
    if (!name) continue;
    const matches = entry.apps.filter((app) => app.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) {
      missing.push(name);
      continue;
    }
    const app = matches[0];
    if (selected.has(app.identifier)) continue;
    selected.add(app.identifier);
    button(`favorite_${i}`, short(app.name, 24), 'grid', `${APP_FEATURE_PREFIX}${app.identifier}`);
  }
  if (missing.length) {
    body(
      label(
        short(
          `Application not found or ambiguous: ${missing.join(', ')}. Check the names in the widget settings.`,
          300,
        ),
        short(
          `Application introuvable ou ambiguë : ${missing.join(', ')}. Vérifiez les noms dans les réglages du widget.`,
          300,
        ),
      ),
    );
  } else if (!commands.size) {
    const names = entry.apps.map((app) => app.name).join(', ');
    body(
      label(
        short(
          `Enter up to four application names in the widget settings. Available: ${names}`,
          300,
        ),
        short(
          `Saisissez jusqu’à quatre noms d’applications dans les réglages du widget. Disponibles : ${names}`,
          300,
        ),
      ),
    );
  }
  return result;
}

export function registerWidgets({ gladys, service }) {
  for (const key of ['playback', 'favorites']) {
    gladys.onWidgetGet(
      key,
      ({ settings }) => buildWidget({ gladys, service, key, settings }).content,
    );
    gladys.onWidgetAction(key, async (actionKey, _params, { settings }) => {
      const { commands, device } = buildWidget({ gladys, service, key, settings });
      const command = commands.get(actionKey);
      if (!command) throw new Error('This command is no longer available. Refresh the widget.');
      await service.setValue(
        device,
        { external_id: `${device.external_id}:${command.feature}` },
        command.value,
      );
      // Transport commands do not always push a new state immediately.
      await service.poll(device);
    });
  }
}
