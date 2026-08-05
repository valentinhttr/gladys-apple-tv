import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from '../src/config.js';
import { PARAMS, toPlatformId } from '../src/constants.js';
import { buildDevice, featureKeyOf, readParam } from '../src/device-model.js';
import { FEATURES, selectFeatures } from '../src/features.js';
import { descriptor, FakeGladys } from './helpers.js';

const config = normalizeConfig();

describe('toPlatformId', () => {
  it('strips everything an external id would choke on', () => {
    assert.equal(toPlatformId('92:18:15:B6:6D:D2'), '921815b66dd2');
  });
});

describe('selectFeatures', () => {
  it('publishes the whole remote when nothing is known yet', () => {
    assert.equal(selectFeatures(null).length, FEATURES.length);
  });

  it('drops the volume slider on a device that cannot set a volume', () => {
    const keys = selectFeatures({ set_volume: false, power: true }).map((f) => f.key);
    assert.ok(!keys.includes('volume'));
    assert.ok(keys.includes('power'));
    assert.ok(keys.includes('select'));
  });
});

describe('buildDevice', () => {
  const gladys = new FakeGladys();

  it('builds stable external ids from the pyatv identifier', () => {
    const device = buildDevice({ gladys, descriptor: descriptor(), config });
    assert.equal(device.external_id, 'ext:apple-tv-test:apple-tv:921815b66dd2');
    assert.ok(
      device.features.every((feature) => feature.external_id.startsWith(`${device.external_id}:`)),
    );
  });

  it('gives every feature a min and a max', () => {
    // Gladys stores both as NOT NULL: a single feature without them fails the
    // whole device creation with a 422, and the user sees only a raw SQL error.
    const device = buildDevice({
      gladys,
      descriptor: descriptor(),
      config,
      capabilities: { app_list: true, power: true, set_volume: true, app: true },
      apps: [{ name: 'Netflix', identifier: 'com.netflix.Netflix' }],
    });
    for (const feature of device.features) {
      assert.equal(typeof feature.min, 'number', `${feature.external_id} has no min`);
      assert.equal(typeof feature.max, 'number', `${feature.external_id} has no max`);
      assert.ok(feature.min <= feature.max, `${feature.external_id} has min > max`);
    }
  });

  it('names the device so the selector Gladys derives is readable', () => {
    // The core DROPS the selector an integration publishes and slugifies the
    // name instead, so the name is the only lever: "Séjour" alone would become
    // the selector `sejour`, which says nothing in a scene.
    const device = buildDevice({ gladys, descriptor: descriptor({ name: 'Séjour' }), config });
    assert.equal(device.name, 'Apple TV Séjour');
    assert.equal(device.selector, undefined);
    assert.ok(device.features.every((feature) => feature.selector === undefined));
  });

  it('does not repeat "Apple TV" when the device is already named that way', () => {
    for (const name of ['Apple TV Chambre', 'AppleTV Chambre', 'apple tv chambre']) {
      const device = buildDevice({ gladys, descriptor: descriptor({ name }), config });
      assert.equal(device.name, name);
    }
  });

  it('falls back to the address when the announcement carries no name', () => {
    const device = buildDevice({ gladys, descriptor: descriptor({ name: '' }), config });
    assert.equal(device.name, 'Apple TV (192.168.1.20)');
  });

  it('asks to be polled, which is what makes the poll frequency legal', () => {
    // A device carrying a poll_frequency without should_poll is never
    // registered for polling, and makes every later update of that device
    // crash in the core ("an error occurred while saving this device").
    const device = buildDevice({ gladys, descriptor: descriptor(), config });
    assert.equal(device.should_poll, true);
    assert.equal(device.poll_frequency, config.pollFrequency);
  });

  it('carries what is needed to talk to the device again after a restart', () => {
    const device = buildDevice({ gladys, descriptor: descriptor(), config });
    assert.equal(readParam(device, PARAMS.IDENTIFIER), '92:18:15:B6:6D:D2');
    assert.equal(readParam(device, PARAMS.HOST), '192.168.1.20');
    assert.equal(readParam(device, PARAMS.MODEL), 'Apple TV 4K (gen 3)');
  });

  it('exposes the feature set the Gladys music box needs', () => {
    const device = buildDevice({ gladys, descriptor: descriptor(), config });
    const musicTypes = device.features
      .filter((feature) => feature.category === DEVICE_FEATURE_CATEGORIES.MUSIC)
      .map((feature) => feature.type);
    for (const type of [
      DEVICE_FEATURE_TYPES.MUSIC.PLAY,
      DEVICE_FEATURE_TYPES.MUSIC.PAUSE,
      DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS,
      DEVICE_FEATURE_TYPES.MUSIC.NEXT,
      DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
      DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE,
    ]) {
      assert.ok(musicTypes.includes(type), `missing music feature ${type}`);
    }
  });

  it('exposes the remote as television features the dashboard renders as buttons', () => {
    // The device-in-room box turns every television type that is not a
    // continuous control (binary, volume, channel) into a push button, and it
    // is the only category it does that for: the transport keys have to exist
    // here too, not only under `music`.
    const device = buildDevice({
      gladys,
      descriptor: descriptor(),
      config,
      capabilities: { set_volume: true, power: true, volume_up: true, volume_down: true },
    });
    const televisionTypes = device.features
      .filter((feature) => feature.category === DEVICE_FEATURE_CATEGORIES.TELEVISION)
      .map((feature) => feature.type);
    for (const type of [
      DEVICE_FEATURE_TYPES.TELEVISION.BINARY,
      DEVICE_FEATURE_TYPES.TELEVISION.PLAY,
      DEVICE_FEATURE_TYPES.TELEVISION.PAUSE,
      DEVICE_FEATURE_TYPES.TELEVISION.PREVIOUS,
      DEVICE_FEATURE_TYPES.TELEVISION.NEXT,
      DEVICE_FEATURE_TYPES.TELEVISION.UP,
      DEVICE_FEATURE_TYPES.TELEVISION.DOWN,
      DEVICE_FEATURE_TYPES.TELEVISION.LEFT,
      DEVICE_FEATURE_TYPES.TELEVISION.RIGHT,
      DEVICE_FEATURE_TYPES.TELEVISION.ENTER,
      DEVICE_FEATURE_TYPES.TELEVISION.RETURN,
      DEVICE_FEATURE_TYPES.TELEVISION.VOLUME,
    ]) {
      assert.ok(televisionTypes.includes(type), `missing television feature ${type}`);
    }
  });

  it('adds one button per installed application, bounded by the configuration', () => {
    const apps = Array.from({ length: 40 }, (_, index) => ({
      name: `App ${index}`,
      identifier: `com.example.app${index}`,
    }));
    const device = buildDevice({
      gladys,
      descriptor: descriptor(),
      config: normalizeConfig({ max_app_shortcuts: 3 }),
      capabilities: { app_list: true },
      apps,
    });
    const buttons = device.features.filter(
      (feature) => feature.category === DEVICE_FEATURE_CATEGORIES.BUTTON,
    );
    assert.equal(buttons.length, 3);
    assert.equal(buttons[0].external_id, `${device.external_id}:app:com.example.app0`);
    // `push`, not `click`: only `button/push` is rendered as something the user
    // can press on a dashboard.
    assert.ok(buttons.every((button) => button.type === DEVICE_FEATURE_TYPES.BUTTON.PUSH));
  });

  it('publishes no application button when the user disabled them', () => {
    const device = buildDevice({
      gladys,
      descriptor: descriptor(),
      config: normalizeConfig({ enable_app_shortcuts: false }),
      apps: [{ name: 'Netflix', identifier: 'com.netflix.Netflix' }],
    });
    assert.equal(
      device.features.filter((f) => f.category === DEVICE_FEATURE_CATEGORIES.BUTTON).length,
      0,
    );
  });

  it('declares the transport as a reserved Gladys param', () => {
    const device = buildDevice({
      gladys,
      descriptor: descriptor(),
      config,
      transport: 'unreachable',
    });
    assert.equal(readParam(device, 'GLADYS_TRANSPORT'), 'unreachable');
  });
});

describe('featureKeyOf', () => {
  const device = { external_id: 'ext:apple-tv-test:apple-tv:921815b66dd2' };

  it('recovers a simple key', () => {
    assert.equal(featureKeyOf(device, { external_id: `${device.external_id}:power` }), 'power');
  });

  it('recovers an application key, dots included', () => {
    assert.equal(
      featureKeyOf(device, { external_id: `${device.external_id}:app:com.netflix.Netflix` }),
      'app:com.netflix.Netflix',
    );
  });

  it('returns nothing for a feature of another device', () => {
    assert.equal(featureKeyOf(device, { external_id: 'ext:other:apple-tv:x:power' }), undefined);
  });
});
