import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

/**
 * The features an Apple TV exposes in Gladys, and the pyatv command behind
 * each one.
 *
 * Two categories on purpose, because Gladys has two dashboard boxes and each
 * one only looks at one of them:
 *
 * - `music` drives the **Music box**, which wants exactly play / pause /
 *   previous / next / volume / playback state, so a paired Apple TV can be
 *   driven from the dashboard like a Sonos. The box renders its own transport
 *   bar and never shows the feature names.
 * - `television` drives the **device-in-room box**, i.e. the remote. Since
 *   Gladys 4.85 every television type that is not a continuous control
 *   (binary, volume, channel) is rendered there as a real push button, so the
 *   whole remote is clickable from a dashboard. That box only offers features
 *   whose type it supports, and `music/play` is not one of them — hence the
 *   deliberate duplication of the transport keys and of the volume slider
 *   between the two categories. The names differ so the device list stays
 *   readable: the remote keeps the short names, the media-player set is
 *   prefixed (its names are never displayed anywhere).
 *
 * `capability` gates publication: it names an entry of the capability map the
 * bridge reports once connected. An Apple TV driven over HDMI-CEC has no
 * readable volume, and a volume slider that can never move is worse than no
 * slider at all. Capabilities are unknown until the first successful
 * connection, and everything that is not app-related is published optimistically
 * until then.
 */

const { TELEVISION, MUSIC, TEXT } = DEVICE_FEATURE_TYPES;

/** @type {Array<object>} */
export const FEATURES = [
  {
    key: 'power',
    name: 'Power',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    capability: 'power',
    // Standby, in Apple's sense: the box stays on the network and answers, it
    // is the screen and the HDMI output that go away.
    command: (value) => ({ action: Number(value) > 0 ? 'turn_on' : 'turn_off' }),
  },
  {
    key: 'play',
    name: 'Media play',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.PLAY,
    min: 1,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'play' }),
  },
  {
    key: 'pause',
    name: 'Media pause',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.PAUSE,
    min: 1,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'pause' }),
  },
  {
    key: 'previous',
    name: 'Media previous',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.PREVIOUS,
    min: 1,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'previous' }),
  },
  {
    key: 'next',
    name: 'Media next',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.NEXT,
    min: 1,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'next' }),
  },
  {
    key: 'volume',
    name: 'Media volume',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.VOLUME,
    min: 0,
    max: 100,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    capability: 'set_volume',
    command: (value) => ({ action: 'set_volume', value: Number(value) }),
  },
  {
    key: 'playback-state',
    name: 'Playback state',
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type: MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  },
  // The remote keys below duplicate the media-player set above under the
  // television category, on purpose: they are the ones the device-in-room box
  // renders as push buttons, and a remote without play/pause is not a remote.
  {
    key: 'remote-play',
    name: 'Play',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.PLAY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'play' }),
  },
  {
    key: 'remote-pause',
    name: 'Pause',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.PAUSE,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'pause' }),
  },
  {
    key: 'remote-previous',
    name: 'Previous',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.PREVIOUS,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'previous' }),
  },
  {
    key: 'remote-next',
    name: 'Next',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.NEXT,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'next' }),
  },
  {
    key: 'stop',
    name: 'Stop',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.STOP,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'stop' }),
  },
  {
    key: 'rewind',
    name: 'Rewind',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.REWIND,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'skip_backward' }),
  },
  {
    key: 'forward',
    name: 'Fast forward',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.FORWARD,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'skip_forward' }),
  },
  {
    key: 'up',
    name: 'Up',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.UP,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'up' }),
  },
  {
    key: 'down',
    name: 'Down',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.DOWN,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'down' }),
  },
  {
    key: 'left',
    name: 'Left',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.LEFT,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'left' }),
  },
  {
    key: 'right',
    name: 'Right',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.RIGHT,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'right' }),
  },
  {
    key: 'select',
    name: 'OK',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.ENTER,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'select' }),
  },
  {
    key: 'back',
    name: 'Back',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.RETURN,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    // On an Apple TV the "back" button IS the menu button.
    command: () => ({ action: 'menu' }),
  },
  {
    key: 'home',
    name: 'Home',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    // Gladys has no `home` television type; `exit` is the closest match and
    // keeps the button in the remote widget.
    type: TELEVISION.EXIT,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'home' }),
  },
  {
    key: 'control-center',
    name: 'Control Center',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.MENU,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    command: () => ({ action: 'control_center' }),
  },
  {
    key: 'volume-up',
    name: 'Volume up',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.VOLUME_UP,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    capability: 'volume_up',
    command: () => ({ action: 'volume_up' }),
  },
  {
    key: 'volume-down',
    name: 'Volume down',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    type: TELEVISION.VOLUME_DOWN,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    capability: 'volume_down',
    command: () => ({ action: 'volume_down' }),
  },
  {
    key: 'remote-volume',
    name: 'Volume',
    category: DEVICE_FEATURE_CATEGORIES.TELEVISION,
    // The device-in-room box renders a slider for `television/volume`, and only
    // for that type: `music/volume` exists for the Music box alone.
    type: TELEVISION.VOLUME,
    min: 0,
    max: 100,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    capability: 'set_volume',
    command: (value) => ({ action: 'set_volume', value: Number(value) }),
  },
  {
    key: 'now-playing',
    name: 'Now playing',
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: TEXT.TEXT,
    // Gladys stores min/max as NOT NULL, and its own convention for a text
    // feature is 0/0 (they carry no meaning for a string state). Omitting them
    // makes device creation fail with a 422.
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  },
  {
    key: 'application',
    name: 'Application',
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: TEXT.TEXT,
    // Gladys stores min/max as NOT NULL, and its own convention for a text
    // feature is 0/0 (they carry no meaning for a string state). Omitting them
    // makes device creation fail with a 422.
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
    capability: 'app',
  },
];

/** Features indexed by key, for the command router. */
export const FEATURES_BY_KEY = new Map(FEATURES.map((feature) => [feature.key, feature]));

/**
 * The features to publish for a device.
 *
 * @param {object|null} capabilities Capability map reported by the bridge, or
 * null when the device has never been connected (nothing is known yet).
 * @returns {Array<object>} The features whose capability is satisfied.
 * @example
 * selectFeatures({ set_volume: false });
 */
export function selectFeatures(capabilities) {
  if (!capabilities) {
    // Never connected: publish the full remote. Everything but volume works on
    // every Apple TV, and the list is refined on the first connection.
    return FEATURES;
  }
  return FEATURES.filter((feature) => !feature.capability || capabilities[feature.capability]);
}
