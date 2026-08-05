import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppleTvService, nowPlayingLabel } from '../src/apple-tv-service.js';
import { normalizeConfig } from '../src/config.js';
import { PARAMS } from '../src/constants.js';
import { descriptor, FakeBridge, FakeGladys, fakeLogger } from './helpers.js';

const IDENTIFIER = '92:18:15:B6:6D:D2';
const EXTERNAL_ID = 'ext:apple-tv-test:apple-tv:921815b66dd2';

function gladysDevice(overrides = {}) {
  return {
    name: 'Living room',
    external_id: EXTERNAL_ID,
    selector: EXTERNAL_ID,
    params: [
      { name: PARAMS.IDENTIFIER, value: IDENTIFIER },
      { name: PARAMS.HOST, value: '192.168.1.20' },
    ],
    ...overrides,
  };
}

function makeService({ gladysOptions = {}, handlers = {} } = {}) {
  const gladys = new FakeGladys(gladysOptions);
  const bridge = new FakeBridge(handlers);
  const service = new AppleTvService({
    gladys,
    bridge,
    config: normalizeConfig(),
    logger: fakeLogger(),
  });
  return { gladys, bridge, service };
}

describe('nowPlayingLabel', () => {
  it('joins the series, the title and the artist', () => {
    assert.equal(nowPlayingLabel({ title: 'Dune' }), 'Dune');
    assert.equal(
      nowPlayingLabel({ title: 'S01E01', series_name: 'Severance' }),
      'Severance — S01E01',
    );
    assert.equal(
      nowPlayingLabel({ title: 'Redbone', artist: 'Childish Gambino' }),
      'Redbone — Childish Gambino',
    );
  });

  it('is empty when nothing is playing', () => {
    assert.equal(nowPlayingLabel({ playback_state: 'idle' }), '');
    assert.equal(nowPlayingLabel(undefined), '');
  });
});

describe('syncDevices', () => {
  it('opens a session for each device the user created', async () => {
    const { bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });

    await service.syncDevices();

    const connect = bridge.calls.find((call) => call.method === 'connect');
    assert.deepEqual(connect.params, { identifier: IDENTIFIER, host: '192.168.1.20' });
    assert.equal(service.devices.get(IDENTIFIER).connected, true);
  });

  it('closes the session of a device deleted in Gladys', async () => {
    const { gladys, bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    gladys.devices = [];
    await service.syncDevices();

    assert.ok(bridge.calls.some((call) => call.method === 'disconnect'));
    assert.equal(service.devices.size, 0);
  });

  it('reports a device that is not paired instead of retrying forever', async () => {
    const { gladys, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: {
        connect: () => {
          const error = new Error('not paired');
          error.kind = 'NoCredentialsError';
          throw error;
        },
      },
    });

    await service.syncDevices();

    assert.equal(service.devices.get(IDENTIFIER).paired, false);
    assert.equal(gladys.connectionStatus.connected, false);
    assert.match(gladys.connectionStatus.message.en, /not paired/);
  });
});

describe('setValue', () => {
  it('routes a remote key to the matching pyatv action', async () => {
    const { bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:select` }, 1);

    const command = bridge.calls.at(-1);
    assert.equal(command.method, 'command');
    assert.equal(command.params.action, 'select');
  });

  it('turns the power feature into turn_on / turn_off', async () => {
    const { bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:power` }, 1);
    assert.equal(bridge.calls.at(-1).params.action, 'turn_on');

    await service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:power` }, 0);
    assert.equal(bridge.calls.at(-1).params.action, 'turn_off');
  });

  it('carries the value of the volume slider', async () => {
    const { bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:volume` }, 42);

    assert.deepEqual(bridge.calls.at(-1).params, {
      identifier: IDENTIFIER,
      action: 'set_volume',
      value: 42,
    });
  });

  it('launches the application of an app shortcut', async () => {
    const { bridge, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await service.setValue(
      gladysDevice(),
      { external_id: `${EXTERNAL_ID}:app:com.netflix.Netflix` },
      1,
    );

    assert.deepEqual(bridge.calls.at(-1).params, {
      identifier: IDENTIFIER,
      action: 'launch_app',
      value: 'com.netflix.Netflix',
    });
  });

  it('explains what to do when the Apple TV is not paired', async () => {
    const { service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: {
        connect: () => {
          const error = new Error('not paired');
          error.kind = 'NoCredentialsError';
          throw error;
        },
      },
    });
    await service.syncDevices();

    await assert.rejects(
      () => service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:select` }, 1),
      /not paired yet/,
    );
  });

  it('refuses a feature that is not one of ours', async () => {
    const { service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await assert.rejects(
      () => service.setValue(gladysDevice(), { external_id: `${EXTERNAL_ID}:nope` }, 1),
      /accepts no command/,
    );
  });
});

describe('publishDeviceState', () => {
  it('maps a worker state onto the Gladys features', async () => {
    const { gladys, service } = makeService({ gladysOptions: { devices: [gladysDevice()] } });

    await service.publishDeviceState(IDENTIFIER, {
      power: 'on',
      volume: 41.6,
      playback_state: 'playing',
      title: 'Dune',
      app_name: 'Netflix',
    });

    const byId = Object.fromEntries(
      gladys.states.map((state) => [state.device_feature_external_id, state]),
    );
    assert.equal(byId[`${EXTERNAL_ID}:power`].state, 1);
    assert.equal(byId[`${EXTERNAL_ID}:volume`].state, 42);
    // The same level feeds the Music box slider and the remote slider.
    assert.equal(byId[`${EXTERNAL_ID}:remote-volume`].state, 42);
    assert.equal(byId[`${EXTERNAL_ID}:playback-state`].state, 1);
    assert.equal(byId[`${EXTERNAL_ID}:now-playing`].text, 'Dune');
    assert.equal(byId[`${EXTERNAL_ID}:application`].text, 'Netflix');
  });

  it('publishes nothing when nothing changed', async () => {
    const { gladys, service } = makeService({ gladysOptions: { devices: [gladysDevice()] } });

    await service.publishDeviceState(IDENTIFIER, { power: 'on' });
    assert.equal(gladys.states.length, 1);

    await service.publishDeviceState(IDENTIFIER, { power: 'on' });
    assert.equal(gladys.states.length, 1);

    await service.publishDeviceState(IDENTIFIER, { power: 'off' });
    assert.equal(gladys.states.length, 2);
  });

  it('ignores a power state the device could not read', async () => {
    const { gladys, service } = makeService({ gladysOptions: { devices: [gladysDevice()] } });

    await service.publishDeviceState(IDENTIFIER, { power: 'unknown' });

    assert.equal(gladys.states.length, 0);
  });

  it('forgets what it published when Gladys refused the batch', async () => {
    const { gladys, service } = makeService({ gladysOptions: { devices: [gladysDevice()] } });
    gladys.publishStates = async () => {
      throw new Error('rate limited');
    };

    await service.publishDeviceState(IDENTIFIER, { power: 'on' });

    assert.equal(service.devices.get(IDENTIFIER).lastValues.has('power'), false);
  });
});

describe('scan', () => {
  it('publishes the discovered Apple TVs', async () => {
    const { gladys, service } = makeService({
      handlers: { scan: () => ({ devices: [descriptor()] }) },
    });
    gladys.scanNetworkResults = [{ addresses: ['192.168.1.20'] }];

    await service.scan();

    assert.equal(gladys.published.length, 1);
    assert.equal(gladys.published[0][0].external_id, EXTERNAL_ID);
    assert.equal(gladys.published[0][0].name, 'Apple TV Living room');
  });

  it('remembers the new address of a device that moved', async () => {
    const { gladys, service } = makeService({
      gladysOptions: { devices: [gladysDevice()] },
      handlers: {
        connect: () => ({ capabilities: {}, state: {} }),
        scan: () => ({ devices: [descriptor({ address: '192.168.1.77' })] }),
      },
    });
    await service.syncDevices();
    gladys.scanNetworkResults = [{ addresses: ['192.168.1.77'] }];

    await service.scan();

    assert.equal(service.devices.get(IDENTIFIER).host, '192.168.1.77');
  });
});
