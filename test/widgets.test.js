import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { AppleTvService } from '../src/apple-tv-service.js';
import { normalizeConfig } from '../src/config.js';
import { PARAMS } from '../src/constants.js';
import { buildWidget, registerWidgets } from '../src/widgets.js';
import { FakeBridge, FakeGladys, fakeLogger } from './helpers.js';

function setup() {
  const device = {
    name: 'Apple TV Salon',
    external_id: 'ext:apple-tv-test:apple-tv:salon',
    params: [{ name: PARAMS.IDENTIFIER, value: 'salon' }],
  };
  const gladys = new FakeGladys({ devices: [device] });
  const bridge = new FakeBridge({ snapshot: { state: { playback_state: 'paused' } } });
  const service = new AppleTvService({
    gladys,
    bridge,
    logger: fakeLogger(),
    config: normalizeConfig(),
  });
  service.registerBridgeHandlers();
  const entry = service.rememberHost('salon', '192.168.1.20');
  Object.assign(entry, {
    connected: true,
    paired: true,
    state: { power: 'on', playback_state: 'playing', title: 'Severance', app_name: 'TV' },
    capabilities: {
      play: true,
      pause: true,
      skip_backward: true,
      skip_forward: true,
      turn_on: true,
      turn_off: true,
      launch_app: true,
    },
    apps: [
      { name: 'Netflix', identifier: 'com.netflix.Netflix' },
      { name: 'Plex', identifier: 'com.plex' },
    ],
  });
  const gets = new Map();
  const actions = new Map();
  gladys.onWidgetGet = (key, handler) => gets.set(key, handler);
  gladys.onWidgetAction = (key, handler) => actions.set(key, handler);
  registerWidgets({ gladys, service });
  const settings = { device: device.external_id };
  const render = (key = 'playback', extra = {}) =>
    gets.get(key)({ settings: { ...settings, ...extra } });
  return { gladys, service, bridge, entry, settings, render, gets, actions };
}

const buttons = (content) => content.components.filter((component) => component.type === 'button');

describe('dashboard widgets', () => {
  it('registers exactly the widgets in the manifest, with valid bounded content', () => {
    const { gets, actions, render, entry } = setup();
    const manifest = JSON.parse(
      readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
    );
    assert.deepEqual(
      [...gets.keys()],
      manifest.widgets.map((widget) => widget.key),
    );
    assert.deepEqual([...actions.keys()], [...gets.keys()]);
    entry.device.name = 'A'.repeat(100);
    entry.state.title = 'B'.repeat(400);
    for (const state of ['playing', 'paused', 'idle', 'stopped', 'loading', 'unknown']) {
      entry.state.playback_state = state;
      assert.deepEqual(validateWidgetContent(render()), []);
      assert.ok(buttons(render()).length <= 4);
    }
    for (const extra of [
      {},
      { favorite_1: 'Netflix', favorite_2: 'Plex' },
      { favorite_1: 'X'.repeat(400) },
    ]) {
      assert.deepEqual(validateWidgetContent(render('favorites', extra)), []);
    }
  });

  it('renders cached metadata and routes pause through the existing service', async () => {
    const { render, actions, settings, bridge, entry } = setup();
    assert.ok(render().components.some((component) => component.text === 'Severance'));
    assert.equal(bridge.calls.length, 0);
    assert.deepEqual(
      buttons(render()).map((button) => button.action.key),
      ['pause', 'rewind', 'forward', 'power_off'],
    );
    await actions.get('playback')('pause', {}, { settings });
    assert.deepEqual(bridge.calls[0], {
      method: 'command',
      params: { identifier: 'salon', action: 'pause', value: undefined },
    });
    assert.equal(entry.state.playback_state, 'paused');
    assert.equal(buttons(render())[0].action.key, 'play');
  });

  it('offers only wake in standby and respects unsupported capabilities', () => {
    const { render, entry } = setup();
    entry.state.power = 'off';
    assert.deepEqual(
      buttons(render()).map((button) => button.action.key),
      ['power_on'],
    );
    assert.ok(!JSON.stringify(render()).includes('Severance'));
    entry.capabilities = {};
    assert.equal(buttons(render()).length, 0);
    entry.state.power = 'on';
    assert.equal(buttons(render()).length, 0);
  });

  it('does not show controls or stale media for missing, unpaired or disconnected devices', () => {
    const { render, entry, bridge, service, gladys } = setup();
    for (const paired of [true, false]) {
      entry.connected = false;
      entry.paired = paired;
      const content = render();
      assert.equal(buttons(content).length, 0);
      assert.ok(!JSON.stringify(content).includes('Severance'));
      assert.deepEqual(validateWidgetContent(content), []);
    }
    const missing = buildWidget({
      gladys,
      service,
      key: 'playback',
      settings: { device: 'another-integration' },
    });
    assert.equal(missing.commands.size, 0);
    assert.equal(bridge.calls.length, 0);
  });

  it('matches favorite names case-insensitively, deduplicates them and launches the selected app', async () => {
    const { render, actions, settings, bridge } = setup();
    const favorites = { favorite_1: ' netflix ', favorite_2: 'Plex', favorite_3: 'NETFLIX' };
    assert.deepEqual(
      buttons(render('favorites', favorites)).map((button) => button.label),
      ['Netflix', 'Plex'],
    );
    await actions.get('favorites')('favorite_2', {}, { settings: { ...settings, ...favorites } });
    assert.deepEqual(bridge.calls[0], {
      method: 'command',
      params: { identifier: 'salon', action: 'launch_app', value: 'com.plex' },
    });
  });

  it('explains empty or invalid favorites and refuses undeclared commands', async () => {
    const { render, actions, settings, bridge, entry, service } = setup();
    assert.ok(JSON.stringify(render('favorites')).includes('Netflix'));
    assert.ok(
      JSON.stringify(render('favorites', { favorite_1: 'Missing' })).includes('introuvable'),
    );
    await assert.rejects(actions.get('favorites')('launch_app', { app: 'com.evil' }, { settings }));
    await assert.rejects(
      actions.get('playback')('power_off', {}, { settings: { device: 'foreign' } }),
    );
    assert.equal(bridge.calls.length, 0);
    entry.apps.push({ name: 'Netflix', identifier: 'duplicate' });
    assert.equal(buttons(render('favorites', { favorite_1: 'Netflix' })).length, 0);
    service.config.appShortcuts = false;
    assert.equal(buttons(render('favorites', { favorite_1: 'Plex' })).length, 0);
  });

  it('merges partial state and clears it when the connection or worker is lost', async () => {
    const { service, entry, bridge } = setup();
    await service.publishDeviceState('salon', { volume: 30 });
    assert.equal(entry.state.title, 'Severance');
    assert.equal(entry.state.volume, 30);
    bridge.emit('connection', { identifier: 'salon', connected: false });
    assert.deepEqual(entry.state, {});
    entry.state.title = 'Old title';
    bridge.emit('down');
    assert.deepEqual(entry.state, {});
  });

  it('reports command failures without pretending the action succeeded', async () => {
    const { bridge, actions, settings } = setup();
    bridge.handlers.command = () => {
      throw new Error('Apple TV disconnected');
    };
    await assert.rejects(actions.get('playback')('pause', {}, { settings }), /disconnected/);
    assert.equal(bridge.calls.length, 1);
  });
});
