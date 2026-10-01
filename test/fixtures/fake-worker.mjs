// A stand-in for src/pyatv_bridge.py, speaking the same newline-delimited JSON
// protocol. Used by test/pyatv-bridge.test.js to exercise the transport (and
// the respawn) without needing Python or an Apple TV.
//
// Behaviour is driven by the method name:
//   ping   -> answers { pong: true }
//   boom   -> answers an error
//   quiet  -> never answers (exercises the request deadline)
//   die    -> exits, so the parent has to respawn it
import { createInterface } from 'node:readline';

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

write({ event: 'ready', pyatv_version: 'fake' });
write({ event: 'state', identifier: 'atv', state: { power: 'on' } });

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'quiet') {
    return;
  }
  if (method === 'die') {
    process.exit(3);
  }
  if (method === 'boom') {
    write({ id, ok: false, error: { message: 'it failed', kind: 'PairingError' } });
    return;
  }
  write({ id, ok: true, result: { pong: true, params } });
});
