import { GladysIntegration, createLogger } from '@gladysassistant/integration-sdk';

import { buildActions } from './src/actions.js';
import { AppleTvService } from './src/apple-tv-service.js';
import { normalizeConfig } from './src/config.js';
import { PyatvBridge } from './src/pyatv-bridge.js';

// A mediated mDNS scan is a single HTTP request that Gladys holds open for the
// whole capture window (up to 30 s): the SDK timeout has to outlive it.
const gladys = new GladysIntegration({ requestTimeout: 45_000 });
const logger = createLogger({ name: 'apple-tv' });

const bridge = new PyatvBridge({ logger: logger.child('pyatv') });
let config = normalizeConfig();
const service = new AppleTvService({ gladys, bridge, config, logger });

service.registerBridgeHandlers();

gladys.onScanRequest(async () => {
  logger.info('Scan requested');
  config = normalizeConfig(gladys.config);
  service.setConfig(config);
  await service.scan();
});

gladys.onSetValue(async (device, feature, value) => {
  await service.setValue(device, feature, value);
});

gladys.onPoll(async (device) => {
  await service.poll(device);
});

gladys.onDeviceCreated(async (device) => {
  logger.info(`Device created: ${device.name}`);
  await service.syncDevices();
});

gladys.onDeviceUpdated(async () => {
  await service.syncDevices();
});

gladys.onDeviceDeleted(async (device) => {
  logger.info(`Device deleted: ${device.name}`);
  await service.syncDevices();
});

gladys.onConfigUpdated(async (newConfig) => {
  logger.info('Configuration updated');
  config = normalizeConfig(newConfig);
  service.setConfig(config);
});

const actions = buildActions({ gladys, bridge, service, logger });
for (const [key, handler] of Object.entries(actions)) {
  gladys.onAction(key, handler);
}

// Every (re)connection to Gladys resynchronizes the devices: the SDK has just
// refreshed `gladys.devices`, and anything that happened while the WebSocket
// was down (a device created, deleted, or an Apple TV that came back) is
// reconciled here.
gladys.on('connected', () => {
  config = normalizeConfig(gladys.config);
  service.setConfig(config);
  service.syncDevices().catch((error) => {
    logger.error(`Could not synchronize the Apple TV devices: ${error.message}`);
  });
});

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal}, closing the Apple TV sessions`);
  await bridge.stop();
});

logger.info('Starting the Gladys Apple TV integration');
bridge.start();
gladys.connect().catch((error) => {
  logger.error(`Initial connection to Gladys failed: ${error.message}`);
  process.exitCode = 1;
});
