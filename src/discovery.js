import { isIpv4 } from './config.js';

/**
 * Finding the Apple TVs on the network.
 *
 * The integration container runs on a Docker bridge network, where multicast
 * never arrives: pyatv cannot browse mDNS by itself from in there. Gladys
 * solves this with mediated discovery — the core, which runs on the host
 * network, browses the service declared in the manifest and hands back the raw
 * announcements. This module turns those announcements into candidate IPv4
 * addresses, then asks pyatv to query each one directly (unicast mDNS, which
 * does cross the bridge) to obtain a real, complete device configuration.
 */

/**
 * Extract the IPv4 addresses of one raw mDNS announcement.
 *
 * The core returns `addresses` as it received them (A and AAAA records mixed),
 * and `txt` as an array of `key=value` strings — the shape actually produced by
 * `multicast-dns`, which the SDK types describe more loosely.
 *
 * @param {object} announcement One entry of the mediated mDNS scan.
 * @returns {Array<string>} The IPv4 addresses of the announcement.
 * @example
 * addressesOf({ addresses: ['192.168.1.20', 'fe80::1'] }); // ['192.168.1.20']
 */
export function addressesOf(announcement) {
  const addresses = Array.isArray(announcement?.addresses) ? announcement.addresses : [];
  return addresses.map((address) => String(address)).filter(isIpv4);
}

/**
 * Collect the candidate addresses of a mediated mDNS scan.
 *
 * An announcement can arrive with its SRV and TXT records but no A record — the
 * signature of an mDNS relay between two subnets, which forwards the service
 * announcements but not the address records that go with them. Such an
 * announcement still names its host, so an address learnt for the same host
 * from another announcement of the same scan is used to rescue it. What cannot
 * be rescued is reported, because a device silently dropped here is a device
 * the user will never see and can never explain.
 *
 * @param {Array<object>} announcements Raw results of `scanNetwork('mdns')`.
 * @returns {object} `{ hosts, unresolved }` — the IPv4 addresses to query, and
 * the announcements no address could be found for.
 * @example
 * candidateHosts([{ addresses: ['192.168.1.20'] }]);
 */
export function candidateHosts(announcements) {
  const entries = announcements || [];
  const hosts = [];
  const unresolved = [];

  // An address record is published for a HOST name, and several services of
  // the same device share that host.
  const addressesByHost = new Map();
  for (const announcement of entries) {
    const addresses = addressesOf(announcement);
    if (announcement?.host && addresses.length > 0 && !addressesByHost.has(announcement.host)) {
      addressesByHost.set(announcement.host, addresses);
    }
  }

  for (const announcement of entries) {
    const addresses = addressesOf(announcement);
    const rescued =
      addresses.length > 0 ? addresses : addressesByHost.get(announcement?.host) || [];
    if (rescued.length === 0) {
      unresolved.push({
        name: announcement?.name || 'unknown',
        host: announcement?.host || null,
      });
      continue;
    }
    for (const address of rescued) {
      if (!hosts.includes(address)) {
        hosts.push(address);
      }
    }
  }
  return { hosts, unresolved };
}

/**
 * Keep one entry per physical Apple TV.
 *
 * A device with several network interfaces (or a leftover address from a
 * previous DHCP lease) answers more than once. The first answer wins: pyatv
 * returns them in the order the addresses were queried, and the mediated scan
 * lists the currently announced address first.
 *
 * @param {Array<object>} devices Device descriptors from the worker.
 * @returns {Array<object>} Apple TVs only, deduplicated by identifier.
 * @example
 * keepAppleTvs([{ identifier: 'a', is_apple_tv: true }]);
 */
export function keepAppleTvs(devices) {
  const byIdentifier = new Map();
  for (const device of devices || []) {
    if (!device?.is_apple_tv || !device.identifier) {
      continue;
    }
    if (!byIdentifier.has(device.identifier)) {
      byIdentifier.set(device.identifier, device);
    }
  }
  return [...byIdentifier.values()];
}

/**
 * Run a full discovery: mediated mDNS, then unicast verification with pyatv.
 *
 * @param {object} options Options.
 * @param {object} options.gladys Gladys SDK instance.
 * @param {object} options.bridge The pyatv bridge.
 * @param {object} options.config Normalized configuration.
 * @param {object} options.logger Logger.
 * @param {Array<string>} [options.extraHosts] Addresses of already known devices.
 * @returns {Promise<Array<object>>} The Apple TVs found.
 * @example
 * const devices = await discoverAppleTvs({ gladys, bridge, config, logger });
 */
export async function discoverAppleTvs({ gladys, bridge, config, logger, extraHosts = [] }) {
  let announcements = [];
  try {
    announcements = await gladys.scanNetwork('mdns', { timeoutSeconds: config.scanTimeout });
    logger.info(`Gladys captured ${announcements.length} AirPlay announcement(s)`);
  } catch (error) {
    // A failed capture must not cancel the scan: the manually configured
    // addresses and the already known devices are still worth querying.
    logger.warn(`The mediated mDNS scan failed: ${error.message}`);
  }

  const { hosts: announced, unresolved } = candidateHosts(announcements);
  const hosts = [...new Set([...announced, ...config.manualHosts, ...extraHosts.filter(isIpv4)])];

  if (unresolved.length > 0) {
    // The single most useful line in the log when a device does not show up:
    // it names what was seen but could not be reached, so the user knows
    // whether their Apple TV was announced at all.
    const described = unresolved
      .map((entry) => `${entry.name}${entry.host ? ` (${entry.host})` : ''}`)
      .join(', ');
    logger.warn(
      `${unresolved.length} announcement(s) carried no IPv4 address and were skipped: ${described}. ` +
        'This usually means Gladys and these devices are on different subnets, with an mDNS relay ' +
        'forwarding the announcements but not the address records. Add their IP addresses in ' +
        '"Manual IPv4 addresses" in the integration configuration.',
    );
  }

  if (hosts.length === 0) {
    logger.warn(
      'No candidate address found. Check that Gladys and your Apple TV are on the same network, ' +
        'or fill in the manual addresses in the integration configuration.',
    );
    return [];
  }

  logger.info(`Verifying ${hosts.length} candidate address(es) with pyatv`);
  const { devices } = await bridge.request(
    'scan',
    { hosts, timeout: config.scanTimeout },
    // pyatv queries the candidates concurrently, so the worst case is the scan
    // window itself plus the time to build the configurations.
    { timeout: (config.scanTimeout + 20) * 1000 },
  );

  const appleTvs = keepAppleTvs(devices);
  logger.info(`Found ${appleTvs.length} Apple TV(s)`);

  if (appleTvs.length === 0 && (devices || []).length > 0) {
    // An AirPlay scan also finds Macs, speakers and smart TVs. Saying which
    // devices answered turns "it found nothing" into something the user can act
    // on: their Apple TV was either not among them, or not reachable at all.
    const others = devices
      .map((device) => `${device.name} (${device.address}, ${device.model || 'unknown model'})`)
      .join(', ');
    logger.warn(`The addresses that answered are not Apple TVs: ${others}`);
  }
  return appleTvs;
}
