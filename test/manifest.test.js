import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildActions } from '../src/actions.js';
import { AppleTvService } from '../src/apple-tv-service.js';
import { normalizeConfig, POLL_FREQUENCIES } from '../src/config.js';
import { FakeBridge, FakeGladys, fakeLogger } from './helpers.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

/**
 * The manifest is the contract with the Gladys store and with the Gladys UI.
 * These checks are the ones a JSON schema cannot make: they tie the manifest to
 * the code that has to honour it.
 */
describe('manifest', () => {
  it('is in lockstep with package.json', () => {
    assert.equal(manifest.version, pkg.version);
    assert.ok(
      manifest.docker_image.endsWith(`:${manifest.version}`),
      `docker_image must be tagged ${manifest.version}, got ${manifest.docker_image}`,
    );
  });

  it('declares every mDNS service the discovery relies on', () => {
    // Gladys browses every declared mdns entry since 5.0.0 (before that it kept
    // only the first, which is why this used to be a single service). The whole
    // set matters: rebuilding a configuration without a direct query needs the
    // protocols the device actually speaks, and AirPlay alone cannot pair or
    // drive the remote.
    const mdns = manifest.network_discovery.filter((entry) => entry.type === 'mdns');
    assert.deepEqual(
      mdns.map((entry) => entry.service),
      ['_airplay._tcp', '_companion-link._tcp', '_raop._tcp', '_mediaremotetv._tcp'],
    );
  });

  it('stays within the capture entries the core accepts', () => {
    // MAX_NETWORK_DISCOVERY_ENTRIES is 5 core side, and each entry is a line the
    // user has to approve on the install screen.
    assert.ok(
      manifest.network_discovery.length <= 5,
      `network_discovery must declare at most 5 entries, got ${manifest.network_discovery.length}`,
    );
  });

  it('declares exactly the actions the code implements', () => {
    const gladys = new FakeGladys();
    const bridge = new FakeBridge();
    const logger = fakeLogger();
    const service = new AppleTvService({ gladys, bridge, config: normalizeConfig(), logger });
    const implemented = Object.keys(buildActions({ gladys, bridge, service, logger })).sort();
    const declared = manifest.actions.map((action) => action.key).sort();
    assert.deepEqual(declared, implemented);
  });

  it('only offers poll frequencies Gladys accepts', () => {
    const field = manifest.config_schema.find((entry) => entry.key === 'poll_frequency');
    for (const option of field.options) {
      assert.ok(
        POLL_FREQUENCIES.includes(Number(option.value)),
        `${option.value} is not a Gladys poll frequency`,
      );
    }
    assert.ok(POLL_FREQUENCIES.includes(Number(field.default)));
  });

  it('declares every configuration key the code reads', () => {
    const declared = new Set(
      manifest.config_schema.filter((entry) => entry.type !== 'section').map((entry) => entry.key),
    );
    for (const key of [
      'scan_timeout',
      'manual_hosts',
      'poll_frequency',
      'enable_app_shortcuts',
      'max_app_shortcuts',
    ]) {
      assert.ok(declared.has(key), `${key} is read by the code but missing from the manifest`);
    }
  });

  it('picks the target Apple TV from a dropdown, never from a typed address', () => {
    // Nobody should have to look up an IP address to pair a device: every
    // action targets a device already added from the Discovery tab, chosen in
    // a `select` the core fills with the integration's own devices.
    for (const action of manifest.actions) {
      const field = (action.fields || []).find((entry) => entry.key === 'device');
      if (!field) {
        continue;
      }
      assert.equal(field.type, 'select', `${action.key}.device must be a select`);
      assert.equal(field.source, 'devices', `${action.key}.device must be filled by the core`);
      assert.ok(!field.options, `${action.key}.device: options and source are mutually exclusive`);
      assert.equal(field.required, true, `${action.key}.device must be required`);
    }
  });

  it('requires the Gladys version that browses every declared mDNS service', () => {
    // Two constraints, and the newer one wins. `source: "devices"` is only
    // validated server side from 4.85.0 (getDynamicOptions); below that every
    // action is rejected with "must be one of " and an empty list. From 5.0.0
    // the core browses all the declared mdns entries instead of the first one,
    // which is what makes the Companion announcement reach the integration at
    // all — without it a routed network can never be recovered.
    assert.equal(manifest.gladys_version, '>=5.0.0');
  });

  it('gives every action enough time for its slowest step', () => {
    for (const action of manifest.actions) {
      assert.ok(
        action.timeout_seconds >= 5 && action.timeout_seconds <= 120,
        `${action.key}: timeout_seconds must be between 5 and 120`,
      );
    }
    // Pairing waits for a human to read a code off a television.
    for (const key of ['pair_start', 'pair_pin']) {
      const action = manifest.actions.find((entry) => entry.key === key);
      assert.ok(action.timeout_seconds >= 120, `${key} needs the full pairing window`);
    }
  });

  it('ships the documentation the store requires', () => {
    for (const path of ['../docs/en.md', '../docs/fr.md']) {
      const size = statSync(new URL(path, import.meta.url)).size;
      assert.ok(size >= 300, `${path} must be at least 300 characters, got ${size}`);
    }
  });
});
