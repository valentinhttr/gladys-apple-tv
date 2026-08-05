import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, isIpv4, normalizeConfig, parseHosts } from '../src/config.js';

describe('isIpv4', () => {
  it('accepts a well-formed address', () => {
    assert.equal(isIpv4('192.168.1.20'), true);
    assert.equal(isIpv4(' 10.0.0.1 '), true);
  });

  it('rejects anything else', () => {
    assert.equal(isIpv4('192.168.1.256'), false);
    assert.equal(isIpv4('fe80::1'), false);
    assert.equal(isIpv4('apple-tv.local'), false);
    assert.equal(isIpv4(undefined), false);
  });
});

describe('parseHosts', () => {
  it('splits on commas, spaces and semicolons', () => {
    assert.deepEqual(parseHosts('192.168.1.20, 192.168.1.21;192.168.1.22 192.168.1.23'), [
      '192.168.1.20',
      '192.168.1.21',
      '192.168.1.22',
      '192.168.1.23',
    ]);
  });

  it('drops duplicates and invalid entries', () => {
    assert.deepEqual(parseHosts('192.168.1.20, nope, 192.168.1.20'), ['192.168.1.20']);
  });

  it('returns an empty list for a missing value', () => {
    assert.deepEqual(parseHosts(undefined), []);
    assert.deepEqual(parseHosts(''), []);
  });
});

describe('normalizeConfig', () => {
  it('falls back to the defaults for an empty configuration', () => {
    const config = normalizeConfig();
    assert.deepEqual(config, {
      manualHosts: [],
      scanTimeout: DEFAULTS.scanTimeout,
      pollFrequency: DEFAULTS.pollFrequency,
      appShortcuts: true,
      maxAppShortcuts: DEFAULTS.maxAppShortcuts,
    });
  });

  it('reads the numbers Gladys stores as strings', () => {
    const config = normalizeConfig({ scan_timeout: '12', max_app_shortcuts: '5' });
    assert.equal(config.scanTimeout, 12);
    assert.equal(config.maxAppShortcuts, 5);
  });

  it('clamps the scan duration to what the core accepts', () => {
    assert.equal(normalizeConfig({ scan_timeout: 900 }).scanTimeout, 25);
    assert.equal(normalizeConfig({ scan_timeout: 0 }).scanTimeout, 2);
  });

  it('only keeps a poll frequency Gladys knows', () => {
    assert.equal(normalizeConfig({ poll_frequency: '15000' }).pollFrequency, 15000);
    assert.equal(normalizeConfig({ poll_frequency: '7000' }).pollFrequency, DEFAULTS.pollFrequency);
  });

  it('reads booleans from the form', () => {
    assert.equal(normalizeConfig({ enable_app_shortcuts: false }).appShortcuts, false);
    assert.equal(normalizeConfig({ enable_app_shortcuts: 'false' }).appShortcuts, false);
    assert.equal(normalizeConfig({ enable_app_shortcuts: true }).appShortcuts, true);
  });
});
