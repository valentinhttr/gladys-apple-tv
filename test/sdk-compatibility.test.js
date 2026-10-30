import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AppleTvService } from '../src/apple-tv-service.js';
import { normalizeConfig } from '../src/config.js';
import { buildDevice } from '../src/device-model.js';
import { descriptor, FakeBridge, fakeLogger } from './helpers.js';

it('discovers, polls and controls an Apple TV through the real SDK protocol', async () => {
  const gladys = createFakeGladys({ selector: 'apple-tv-test' });
  const config = normalizeConfig();
  const device = buildDevice({ gladys, descriptor: descriptor(), config });
  await gladys.connect();
  await gladys.publishDiscoveredDevices([device]);
  assert.equal(gladys.fake.discoveredDevices[0].should_poll, true);
  await gladys.fake.deviceCreated(device);

  const bridge = new FakeBridge({
    connect: { capabilities: {}, state: {} },
    snapshot: { state: { power: 'on', playback_state: 'playing', title: 'Severance' } },
  });
  const logger = fakeLogger();
  const service = new AppleTvService({ gladys, bridge, config, logger });
  service.registerBridgeHandlers();
  gladys.onPoll((target) => service.poll(target));
  gladys.onSetValue((target, feature, value) => service.setValue(target, feature, value));
  await service.syncDevices();

  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  assert.equal((await gladys.fake.poll(device)).success, true);
  assert.ok(gladys.fake.states.some((state) => state.text === 'Severance'));
  assert.ok(
    gladys.fake.states.some(
      (state) => state.device_feature_external_id.endsWith(':power') && state.state === 1,
    ),
  );

  const play = device.features.find((feature) => feature.external_id.endsWith(':play'));
  assert.equal((await gladys.fake.setValue(device, play, 1)).success, true);
  assert.equal(bridge.calls.at(-1).params.action, 'play');
  assert.deepEqual(logger.lines.warn, []);
  await gladys.disconnect();
});
