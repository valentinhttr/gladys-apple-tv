import { isIpv4 } from './config.js';

/**
 * Finding the Apple TVs on the network.
 *
 * The integration container runs on a Docker bridge network, where multicast
 * never arrives: pyatv cannot browse mDNS by itself from in there. Gladys
 * solves this with mediated discovery — the core, which runs on the host
 * network, browses the services declared in the manifest and hands back the raw
 * announcements. This module turns those announcements into candidate IPv4
 * addresses, then asks pyatv to query each one directly (unicast mDNS, which
 * does cross the bridge) to obtain a real, complete device configuration.
 *
 * That direct query is the step that fails between VLANs: an Apple TV ignores a
 * unicast mDNS query whose source is outside its own subnet, so the candidate
 * stays silent and the device is never found — even though Gladys received its
 * announcement and its address. Since Gladys 5.0.0 the core browses every
 * declared service rather than only the first, so the announcements it returns
 * now carry the full protocol set of the device (AirPlay, Companion, RAOP,
 * MRP). That is the same raw material pyatv's own scanner consumes, so the
 * announcements are handed to the worker as well: it rebuilds a configuration
 * from them for the candidates that never answered.
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
 * Read the DNS-SD service type an announcement belongs to.
 *
 * The core returns the full instance name (`Living Room._airplay._tcp.local`);
 * everything after the first dot is the service type. It is what tells an
 * AirPlay announcement from a Companion one now that several are declared.
 *
 * @param {object} announcement One entry of the mediated mDNS scan.
 * @returns {string|null} The service type, or null when the name is unusable.
 * @example
 * serviceTypeOf({ name: 'TV._airplay._tcp.local' }); // '_airplay._tcp.local'
 */
export function serviceTypeOf(announcement) {
  const name = String(announcement?.name || '');
  const separator = name.indexOf('.');
  return separator > 0 ? name.slice(separator + 1) : null;
}

/**
 * Produce a stable, compact description of one announcement for the logs.
 *
 * TXT records are deliberately omitted: they are verbose and can contain
 * identifiers that add no value to the first line of network diagnosis.
 *
 * @param {object} announcement One entry of the mediated mDNS scan.
 * @returns {string} JSON containing the useful routing fields.
 */
function describeAnnouncement(announcement) {
  const addresses = Array.isArray(announcement?.addresses)
    ? announcement.addresses.map((address) => String(address))
    : [];
  return JSON.stringify({
    name: announcement?.name || null,
    service: serviceTypeOf(announcement),
    host: announcement?.host || null,
    addresses,
    ipv4: addressesOf(announcement),
    port: Number.isInteger(announcement?.port) ? announcement.port : null,
  });
}

/**
 * Produce a stable description of a pyatv answer for the logs.
 *
 * @param {object} device Device descriptor returned by the worker.
 * @returns {string} JSON containing non-secret identification fields.
 */
function describeAnswer(device) {
  return JSON.stringify({
    name: device?.name || null,
    address: device?.address || null,
    model: device?.model || null,
    operating_system: device?.operating_system || null,
    is_apple_tv: Boolean(device?.is_apple_tv),
    source: device?.source || 'direct',
  });
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
    const services = [...new Set(announcements.map(serviceTypeOf).filter(Boolean))];
    logger.info(
      `Gladys captured ${announcements.length} mDNS announcement(s) across ` +
        `${services.length} service(s): ${services.join(', ') || 'none'}`,
    );
    announcements.forEach((announcement, index) => {
      logger.info(
        `mDNS announcement ${index + 1}/${announcements.length}: ${describeAnnouncement(announcement)}`,
      );
    });
  } catch (error) {
    // A failed capture must not cancel the scan: the manually configured
    // addresses and the already known devices are still worth querying.
    logger.warn(`The mediated mDNS scan failed: ${error.message}`);
  }

  const { hosts: announced, unresolved } = candidateHosts(announcements);
  const known = extraHosts.filter(isIpv4);
  const sourcesByHost = new Map();
  const addSource = (candidates, source) => {
    for (const host of candidates) {
      if (!sourcesByHost.has(host)) {
        sourcesByHost.set(host, []);
      }
      if (!sourcesByHost.get(host).includes(source)) {
        sourcesByHost.get(host).push(source);
      }
    }
  };
  // Not "AirPlay announcement": since Gladys 5.0.0 an address can just as well
  // come from the Companion or RAOP announcement of the same device.
  addSource(announced, 'mDNS announcement');
  addSource(config.manualHosts, 'manual configuration');
  addSource(known, 'known Gladys device');
  const hosts = [...sourcesByHost.keys()];

  hosts.forEach((host, index) => {
    logger.info(
      `Candidate address ${index + 1}/${hosts.length}: ${JSON.stringify({ address: host, sources: sourcesByHost.get(host) })}`,
    );
  });

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
        'forwarding the announcements but not the address records. A manual IPv4 address can help ' +
        'only when direct traffic still exits on the device local subnet; it does not by itself ' +
        'enable discovery across routed VLANs.',
    );
  }

  if (hosts.length === 0) {
    logger.warn(
      'No candidate address found. Check that Gladys and your Apple TV are on the same network, ' +
        'or try a manual address when direct traffic still exits on the Apple TV local subnet.',
    );
    return [];
  }

  logger.info(`Verifying ${hosts.length} candidate address(es) with pyatv`);
  const { devices = [] } = await bridge.request(
    'scan',
    // The announcements travel with the candidates: a device that does not
    // answer the direct query is rebuilt from what Gladys already captured,
    // which is the only thing that works across routed VLANs.
    { hosts, announcements, timeout: config.scanTimeout },
    // pyatv queries the candidates concurrently, so the worst case is the scan
    // window itself plus the time to build the configurations.
    { timeout: (config.scanTimeout + 20) * 1000 },
  );

  devices.forEach((device, index) => {
    logger.info(`pyatv response ${index + 1}/${devices.length}: ${describeAnswer(device)}`);
  });

  // A device reconstructed from an announcement was never actually reached, so
  // it is not proof the network works — the commands still have to cross. Only
  // the direct answers count as verified.
  const verified = devices.filter((device) => (device?.source || 'direct') === 'direct');
  const rebuilt = devices.filter((device) => device?.source === 'announced');
  const answeredHosts = new Set(verified.map((device) => device?.address).filter(Boolean));
  const unansweredHosts = hosts.filter((host) => !answeredHosts.has(host));

  if (rebuilt.length > 0) {
    logger.info(
      `${rebuilt.length} device(s) were rebuilt from the announcements Gladys captured, ` +
        'because they did not answer a direct query: ' +
        `${rebuilt.map((device) => `${device.name} (${device.address})`).join(', ')}. ` +
        'This is the expected path when Gladys and the Apple TV sit on different subnets.',
    );
  }

  if (devices.length === 0) {
    logger.warn(
      `No candidate answered pyatv's direct mDNS query: ${unansweredHosts.join(', ')}, ` +
        'and none could be rebuilt from the announcements either. On routed networks or ' +
        'separate VLANs, Apple devices normally ignore direct mDNS queries whose source is ' +
        'outside their local subnet; a rebuild needs the AirPlay and Companion announcements ' +
        'to carry their TXT records through the relay.',
    );
  } else if (unansweredHosts.length > 0) {
    logger.info(
      `${unansweredHosts.length} candidate address(es) did not answer a direct query: ${unansweredHosts.join(', ')}`,
    );
  }

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
