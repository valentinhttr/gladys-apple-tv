import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { PyatvBridge } from '../src/pyatv-bridge.js';
import { fakeLogger } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));

/** A bridge talking to the fake worker instead of Python. */
function makeBridge() {
  return new PyatvBridge({ logger: fakeLogger(), python: process.execPath, script: SCRIPT });
}

describe('PyatvBridge', () => {
  const bridges = [];
  const open = () => {
    const bridge = makeBridge();
    bridges.push(bridge);
    return bridge;
  };

  after(async () => {
    await Promise.all(bridges.map((bridge) => bridge.stop()));
  });

  it('starts the worker on the first request and resolves it', async () => {
    const bridge = open();
    const result = await bridge.request('ping', { hello: 'world' });
    assert.deepEqual(result, { pong: true, params: { hello: 'world' } });
  });

  it('surfaces the worker error with its kind', async () => {
    const bridge = open();
    await assert.rejects(
      () => bridge.request('boom'),
      (error) => {
        assert.equal(error.message, 'it failed');
        assert.equal(error.kind, 'PairingError');
        return true;
      },
    );
  });

  it('gives up on a request the worker never answers', async () => {
    const bridge = open();
    await assert.rejects(() => bridge.request('quiet', {}, { timeout: 150 }), /did not answer/);
  });

  it('emits the events the worker pushes', async () => {
    const bridge = open();
    const ready = once(bridge, 'ready');
    const state = once(bridge, 'state');
    bridge.start();
    await ready;
    const [payload] = await state;
    assert.deepEqual(payload, { identifier: 'atv', state: { power: 'on' } });
  });

  it('rejects the in-flight requests and respawns when the worker dies', async () => {
    const bridge = open();
    await bridge.request('ping');

    const down = once(bridge, 'down');
    const pending = bridge.request('quiet', {}, { timeout: 5_000 });
    bridge.request('die').catch(() => {});

    await assert.rejects(() => pending, /stopped/);
    await down;

    // The respawn is delayed, but a new request starts the worker right away.
    assert.deepEqual((await bridge.request('ping')).pong, true);
  });

  it('stays stopped once stopped', async () => {
    const bridge = makeBridge();
    await bridge.request('ping');
    await bridge.stop();
    assert.equal(bridge.child, null);
    assert.equal(bridge.stopping, true);
  });
});
