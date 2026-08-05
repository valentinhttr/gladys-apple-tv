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

  it('declares the mDNS capture the discovery relies on', () => {
    // Only ONE entry per capture type is honoured by the core (it picks the
    // first one matching the type), so declaring a second mDNS service would
    // silently do nothing.
    const mdns = manifest.network_discovery.filter((entry) => entry.type === 'mdns');
    assert.equal(mdns.length, 1);
    assert.equal(mdns[0].service, '_airplay._tcp');
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

  it('never uses a dynamic select in an action', () => {
    // The Gladys core validates action fields against `field.options`, which a
    // `select` with `source: "devices"` does not carry — its options are filled
    // in by the frontend. Any value submitted for such a field is rejected with
    // `must be one of ` and an empty list, so the action is simply unusable.
    for (const action of manifest.actions) {
      for (const field of action.fields || []) {
        assert.ok(
          !field.source,
          `${action.key}.${field.key}: a field with a "source" can never be validated by the core`,
        );
      }
    }
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
