import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/config.js';
import { addressesOf, candidateHosts, discoverAppleTvs, keepAppleTvs } from '../src/discovery.js';
import { descriptor, FakeBridge, FakeGladys, fakeLogger } from './helpers.js';

describe('addressesOf', () => {
  it('keeps only the IPv4 records', () => {
    assert.deepEqual(addressesOf({ addresses: ['192.168.1.20', 'fe80::1c2d', '192.168.1.21'] }), [
      '192.168.1.20',
      '192.168.1.21',
    ]);
  });

  it('tolerates an announcement without any address', () => {
    assert.deepEqual(addressesOf({}), []);
    assert.deepEqual(addressesOf(undefined), []);
  });
});

describe('candidateHosts', () => {
  it('deduplicates across announcements', () => {
    const { hosts } = candidateHosts([
      { addresses: ['192.168.1.20'] },
      { addresses: ['192.168.1.20', '192.168.1.21'] },
    ]);
    assert.deepEqual(hosts, ['192.168.1.20', '192.168.1.21']);
  });

  it('rescues an announcement whose host was resolved by another one', () => {
    // The AirPlay announcement of a device can arrive without its address
    // record while another service of the same host carries it.
    const { hosts, unresolved } = candidateHosts([
      { name: 'Salon._raop._tcp.local', host: 'atv.local', addresses: ['192.168.1.20'] },
      { name: 'Salon._airplay._tcp.local', host: 'atv.local', addresses: [] },
    ]);
    assert.deepEqual(hosts, ['192.168.1.20']);
    assert.deepEqual(unresolved, []);
  });

  it('reports the announcements no address could be found for', () => {
    const { hosts, unresolved } = candidateHosts([
      { name: 'Living room._airplay._tcp.local', host: 'Sejour.local', addresses: [] },
      { name: 'Kitchen._airplay._tcp.local', addresses: ['fe80::1'] },
    ]);
    assert.deepEqual(hosts, []);
    assert.deepEqual(unresolved, [
      { name: 'Living room._airplay._tcp.local', host: 'Sejour.local' },
      { name: 'Kitchen._airplay._tcp.local', host: null },
    ]);
  });
});

describe('keepAppleTvs', () => {
  it('drops the Macs and the AirPlay speakers the scan also finds', () => {
    const devices = [
      descriptor({ identifier: 'mac', is_apple_tv: false }),
      descriptor({ identifier: 'atv' }),
    ];
    assert.deepEqual(
      keepAppleTvs(devices).map((device) => device.identifier),
      ['atv'],
    );
  });

  it('keeps the first answer of a device reachable on two addresses', () => {
    const devices = [descriptor({ address: '192.168.1.20' }), descriptor({ address: '10.8.0.4' })];
    const kept = keepAppleTvs(devices);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].address, '192.168.1.20');
  });
});

describe('discoverAppleTvs', () => {
  const config = normalizeConfig({ scan_timeout: 5 });

  it('verifies the mDNS candidates with pyatv', async () => {
    const gladys = new FakeGladys();
    gladys.scanNetworkResults = [
      { name: 'Living room._airplay._tcp.local', addresses: ['192.168.1.20', 'fe80::1'] },
    ];
    const bridge = new FakeBridge({ scan: () => ({ devices: [descriptor()] }) });

    const found = await discoverAppleTvs({ gladys, bridge, config, logger: fakeLogger() });

    assert.deepEqual(bridge.calls[0].params.hosts, ['192.168.1.20']);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Living room');
  });

  it('still scans the manual addresses when the mediated capture fails', async () => {
    const gladys = new FakeGladys();
    gladys.scanNetworkError = new Error('capture unavailable');
    const bridge = new FakeBridge({ scan: () => ({ devices: [descriptor()] }) });

    const found = await discoverAppleTvs({
      gladys,
      bridge,
      config: normalizeConfig({ manual_hosts: '192.168.1.30' }),
      logger: fakeLogger(),
    });

    assert.deepEqual(bridge.calls[0].params.hosts, ['192.168.1.30']);
    assert.equal(found.length, 1);
  });

  it('merges the announcements, the manual addresses and the known devices', async () => {
    const gladys = new FakeGladys();
    gladys.scanNetworkResults = [{ addresses: ['192.168.1.20'] }];
    const bridge = new FakeBridge({ scan: () => ({ devices: [] }) });

    await discoverAppleTvs({
      gladys,
      bridge,
      config: normalizeConfig({ manual_hosts: '192.168.1.30' }),
      logger: fakeLogger(),
      extraHosts: ['192.168.1.40', 'not-an-ip'],
    });

    assert.deepEqual(bridge.calls[0].params.hosts, [
      '192.168.1.20',
      '192.168.1.30',
      '192.168.1.40',
    ]);
  });

  it('does not call pyatv when nothing was found', async () => {
    const gladys = new FakeGladys();
    const bridge = new FakeBridge();
    const logger = fakeLogger();

    const found = await discoverAppleTvs({ gladys, bridge, config, logger });

    assert.deepEqual(found, []);
    assert.equal(bridge.calls.length, 0);
    assert.match(logger.lines.warn.join(' '), /No candidate address/);
  });

  it('names the announcements it had to skip', async () => {
    const gladys = new FakeGladys();
    gladys.scanNetworkResults = [
      { name: 'Living room._airplay._tcp.local', host: 'Sejour.local', addresses: [] },
    ];
    const bridge = new FakeBridge();
    const logger = fakeLogger();

    await discoverAppleTvs({ gladys, bridge, config, logger });

    const warnings = logger.lines.warn.join(' ');
    assert.match(warnings, /Living room\._airplay\._tcp\.local \(Sejour\.local\)/);
    assert.match(warnings, /different subnets/);
  });

  it('says which devices answered when none of them is an Apple TV', async () => {
    const gladys = new FakeGladys();
    gladys.scanNetworkResults = [{ addresses: ['192.168.1.17'] }];
    const bridge = new FakeBridge({
      scan: () => ({
        devices: [
          descriptor({ name: 'Kitchen speaker', address: '192.168.1.17', is_apple_tv: false }),
        ],
      }),
    });
    const logger = fakeLogger();

    const found = await discoverAppleTvs({ gladys, bridge, config, logger });

    assert.deepEqual(found, []);
    assert.match(logger.lines.warn.join(' '), /Kitchen speaker \(192\.168\.1\.17/);
  });
});
