import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildActions, resolveTarget } from '../src/actions.js';
import { AppleTvService } from '../src/apple-tv-service.js';
import { normalizeConfig } from '../src/config.js';
import { PARAMS } from '../src/constants.js';
import { descriptor, FakeBridge, FakeGladys, fakeLogger } from './helpers.js';

const IDENTIFIER = '92:18:15:B6:6D:D2';
const EXTERNAL_ID = 'ext:apple-tv-test:apple-tv:921815b66dd2';

function gladysDevice() {
  return {
    name: 'Living room',
    external_id: EXTERNAL_ID,
    params: [
      { name: PARAMS.IDENTIFIER, value: IDENTIFIER },
      { name: PARAMS.HOST, value: '192.168.1.20' },
    ],
  };
}

function setup({ devices = [gladysDevice()], handlers = {} } = {}) {
  const gladys = new FakeGladys({ devices });
  const bridge = new FakeBridge(handlers);
  const logger = fakeLogger();
  const service = new AppleTvService({ gladys, bridge, config: normalizeConfig(), logger });
  const actions = buildActions({ gladys, bridge, service, logger });
  return { gladys, bridge, service, actions };
}

describe('resolveTarget', () => {
  it('uses the only Apple TV when the field is left empty', async () => {
    const { gladys, service } = setup();
    const target = await resolveTarget({ gladys, service, fields: {} });
    assert.deepEqual(target, { identifier: IDENTIFIER, host: '192.168.1.20', name: 'Living room' });
  });

  it('asks which one when several exist', async () => {
    const second = {
      ...gladysDevice(),
      name: 'Bedroom',
      external_id: 'ext:apple-tv-test:apple-tv:other',
    };
    const { gladys, service } = setup({ devices: [gladysDevice(), second] });
    await assert.rejects(
      () => resolveTarget({ gladys, service, fields: {} }),
      /Pick the Apple TV you want to act on/,
    );
  });

  it('matches a device by name, case insensitively', async () => {
    const { gladys, service } = setup();
    const target = await resolveTarget({ gladys, service, fields: { device: 'living room' } });
    assert.equal(target.identifier, IDENTIFIER);
  });

  it('matches a device by external id, by selector and by address', async () => {
    const { gladys, service } = setup({
      devices: [{ ...gladysDevice(), selector: 'apple-tv-living-room-0f3f' }],
    });
    for (const value of [EXTERNAL_ID, 'apple-tv-living-room-0f3f', '192.168.1.20']) {
      const target = await resolveTarget({ gladys, service, fields: { device: value } });
      assert.equal(target.identifier, IDENTIFIER, `failed for ${value}`);
    }
  });

  it('resolves the external id the device dropdown submits', async () => {
    // What the Configuration screen actually sends for a `select` field with
    // `source: "devices"`: the external id of the chosen device, nothing else.
    const { gladys, service } = setup();
    const target = await resolveTarget({ gladys, service, fields: { device: EXTERNAL_ID } });
    assert.deepEqual(target, { identifier: IDENTIFIER, host: '192.168.1.20', name: 'Living room' });
  });

  it('sends the user back to the Discovery tab when the device is gone', async () => {
    const { gladys, service } = setup();
    await assert.rejects(
      () =>
        resolveTarget({ gladys, service, fields: { device: 'ext:apple-tv-test:apple-tv:gone' } }),
      /No Apple TV matches.*run a scan from the Discovery tab.*Living room/i,
    );
  });

  it('sends the user back to the Discovery tab when nothing is added yet', async () => {
    const { gladys, service } = setup({ devices: [] });
    await assert.rejects(
      () => resolveTarget({ gladys, service, fields: {} }),
      /No Apple TV added yet.*Discovery tab/,
    );
  });
});

describe('pair_start', () => {
  it('tells the user to read the code on the television', async () => {
    const { actions } = setup({
      handlers: {
        pair_begin: () => ({
          done: false,
          protocol: 'AirPlay',
          device_provides_pin: true,
          remaining: ['AirPlay', 'Companion'],
          device: descriptor(),
        }),
      },
    });

    const message = await actions.pair_start({ device: EXTERNAL_ID });

    assert.match(message.en, /Living room: a code is displayed/);
    assert.match(message.en, /AirPlay, 2 step\(s\) left/);
    assert.match(message.fr, /un code s'affiche/);
  });

  it('gives the code to type when the Apple TV expects one from us', async () => {
    const { actions } = setup({
      handlers: {
        pair_begin: () => ({
          done: false,
          protocol: 'Companion',
          device_provides_pin: false,
          pin: '1111',
          remaining: ['Companion'],
          device: descriptor(),
        }),
      },
    });

    const message = await actions.pair_start({ device: EXTERNAL_ID });

    assert.match(message.en, /1111/);
  });

  it('says so when the device is already paired', async () => {
    const { actions } = setup({
      handlers: {
        pair_begin: () => ({ done: true, device: descriptor() }),
        connect: () => ({ capabilities: {}, state: {} }),
      },
    });

    const message = await actions.pair_start({ device: EXTERNAL_ID });

    assert.match(message.en, /already paired/);
  });
});

describe('pair_pin', () => {
  it('announces the next protocol in a single call', async () => {
    const { bridge, actions } = setup({
      handlers: {
        pair_pin: () => ({
          paired_protocol: 'AirPlay',
          failure: null,
          done: false,
          remaining: ['Companion'],
          next: {
            protocol: 'Companion',
            device_provides_pin: true,
            remaining: ['Companion'],
            device: descriptor(),
          },
          device: descriptor(),
        }),
      },
    });

    const message = await actions.pair_pin({ pin: '1234' });

    // The worker chains internally: no second round trip to open the next step.
    assert.equal(bridge.calls.filter((call) => call.method === 'pair_begin').length, 0);
    assert.match(message.en, /AirPlay is paired/);
    assert.match(message.en, /Companion, 1 step\(s\) left/);
  });

  it('asks for the new code when the previous one expired', async () => {
    const { actions } = setup({
      handlers: {
        pair_pin: () => ({
          paired_protocol: null,
          failure: 'not connected',
          done: false,
          remaining: ['Companion'],
          next: {
            protocol: 'Companion',
            device_provides_pin: true,
            remaining: ['Companion'],
            device: descriptor(),
          },
          device: descriptor(),
        }),
      },
    });

    const message = await actions.pair_pin({ pin: '1234' });

    assert.match(message.en, /did not work \(not connected\)/);
    assert.match(message.fr, /n'a pas fonctionné/);
  });

  it('reports a failure the worker could not recover from', async () => {
    const { actions } = setup({
      handlers: {
        pair_pin: () => ({
          paired_protocol: null,
          failure: 'The Apple TV refused the code for Companion.',
          done: false,
          remaining: [],
          next: null,
          device: descriptor(),
        }),
      },
    });

    await assert.rejects(() => actions.pair_pin({ pin: '0000' }), /refused the code/);
  });

  it('reconnects and republishes once every protocol is paired', async () => {
    const { gladys, bridge, actions } = setup({
      handlers: {
        pair_pin: () => ({
          paired_protocol: 'Companion',
          failure: null,
          done: true,
          remaining: [],
          next: null,
          device: descriptor(),
        }),
        connect: () => ({ capabilities: { app_list: false }, state: { power: 'on' } }),
      },
    });

    const message = await actions.pair_pin({ pin: '1234' });

    assert.ok(bridge.calls.some((call) => call.method === 'connect'));
    // Republished from the descriptor the pairing returned: no network scan.
    assert.equal(bridge.calls.filter((call) => call.method === 'scan').length, 0);
    assert.equal(gladys.published.length, 1);
    assert.match(message.en, /Pairing complete/);
  });

  it('refuses an empty code', async () => {
    const { actions } = setup();
    await assert.rejects(() => actions.pair_pin({ pin: '  ' }), /Enter the code/);
  });

  it('tells the user to clear the field instead of resubmitting the same code', async () => {
    // The action form keeps what was typed, so the second protocol is where
    // people press the button again without touching the field. Replaying the
    // old code would burn the fresh one the television is showing.
    const { bridge, actions } = setup({
      handlers: {
        pair_pin: () => ({
          paired_protocol: 'AirPlay',
          failure: null,
          done: false,
          remaining: ['Companion'],
          next: {
            protocol: 'Companion',
            device_provides_pin: true,
            remaining: ['Companion'],
            device: descriptor(),
          },
          device: descriptor(),
        }),
      },
    });

    const first = await actions.pair_pin({ pin: '2641' });
    assert.match(first.en, /Clear the "Code" field/);
    assert.match(first.fr, /Effacez le champ/);

    await assert.rejects(() => actions.pair_pin({ pin: '2641' }), /already entered/);
    // The worker was never asked to burn the new code on the old value.
    assert.equal(bridge.calls.filter((call) => call.method === 'pair_pin').length, 1);
  });
});

describe('other actions', () => {
  it('launches an application by bundle identifier', async () => {
    const { bridge, actions } = setup();
    await actions.launch_app({ device: EXTERNAL_ID, app_id: ' com.netflix.Netflix ' });
    assert.deepEqual(bridge.calls.at(-1).params, {
      identifier: IDENTIFIER,
      action: 'launch_app',
      value: 'com.netflix.Netflix',
    });
  });

  it('refuses a URL that is not http(s)', async () => {
    const { actions } = setup();
    await assert.rejects(
      () => actions.play_url({ device: EXTERNAL_ID, url: 'ftp://example.com/a.mp4' }),
      /starting with http/,
    );
  });

  it('lists the installed applications', async () => {
    const { actions } = setup({
      handlers: {
        app_list: () => ({ apps: [{ name: 'Netflix', identifier: 'com.netflix.Netflix' }] }),
      },
    });
    const message = await actions.list_apps({ device: EXTERNAL_ID });
    assert.match(message.en, /Netflix — com\.netflix\.Netflix/);
  });

  it('forgets the credentials of a device', async () => {
    const { bridge, service, actions } = setup({
      handlers: { connect: () => ({ capabilities: {}, state: {} }) },
    });
    await service.syncDevices();

    await actions.unpair({ device: EXTERNAL_ID });

    assert.ok(bridge.calls.some((call) => call.method === 'forget'));
    assert.equal(service.devices.get(IDENTIFIER).paired, false);
  });

  it('reports an Apple TV that stays unreachable on refresh', async () => {
    const { actions } = setup({
      handlers: {
        connect: () => {
          throw new Error('timed out');
        },
      },
    });
    await assert.rejects(() => actions.refresh({ device: EXTERNAL_ID }), /unreachable/);
  });
});
