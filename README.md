# Gladys Apple TV

<p align="center">
  <img src="assets/cover.jpg" alt="Gladys Apple TV integration cover" width="900">
</p>

<p align="center">
  <a href="https://github.com/valentinhttr/gladys-apple-tv/actions/workflows/ci.yml"><img src="https://github.com/valentinhttr/gladys-apple-tv/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/valentinhttr/gladys-apple-tv/releases"><img src="https://img.shields.io/github/v/release/valentinhttr/gladys-apple-tv" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/valentinhttr/gladys-apple-tv" alt="Apache-2.0 license"></a>
</p>

External [Gladys Assistant](https://gladysassistant.com) integration that
discovers, pairs and controls Apple TV devices on the local network, built on
[pyatv](https://pyatv.dev).

Everything happens on your network: no Apple ID, no cloud, no Apple servers.

> **Using it?** The setup guide lives in [`docs/en.md`](docs/en.md) (and
> [`docs/fr.md`](docs/fr.md)) — that is what Gladys shows on the integration
> page. This README is about the code.

> **AI development disclosure:** this integration was written with substantial
> assistance from Claude (Anthropic). Architecture, implementation, tests and
> documentation were produced collaboratively and validated against the Gladys
> external-integration contract and against a real Apple TV 4K running tvOS 26.

## What it exposes

One Gladys device per Apple TV, named `Apple TV <the name of the device>` — the
Apple TV announces the room it sits in ("Séjour"), and the core derives the
selector from the name, so the prefix is what turns `sejour` into
`apple-tv-sejour`.

| Category     | Features                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `television` | Power, D-pad (up/down/left/right/OK), Back, Home, Control Center, Play, Pause, Previous, Next, Stop, Rewind, Fast forward, Volume, Volume ± |
| `music`      | Media play, Media pause, Media previous, Media next, Media volume, Playback state                                                           |
| `text`       | Now playing, Application                                                                                                                    |
| `button`     | One shortcut per installed application (optional)                                                                                           |

The two categories serve two different dashboard boxes, which is why the
transport keys and the volume appear twice:

- **device-in-room box** — since Gladys 4.84.3 every `television` type that is
  not a continuous control (binary, volume, channel) is rendered as a real push
  button, so the whole remote is clickable from a dashboard. That box only
  offers types it supports, and `music/play` is not one of them.
- **Music box** — wants exactly the `music` set, so a paired Apple TV can be
  driven like a Sonos. It renders its own transport bar and never shows the
  feature names, which is why that set carries the prefixed ones.

Application shortcuts use `button/push`, not `button/click`: `click` is what a
physical button _reports_, and only `push` is rendered as something pressable.

Features gated on a capability (volume, power, application shortcuts) are only
published once a live connection has proven the device supports them. Before the
first connection the full remote is published optimistically, then refined on the
next scan.

The device is published with `should_poll: true`. That is not decoration: the
core only schedules a poll for `should_poll === true`, and a device carrying a
`poll_frequency` it never registered makes every later update of that device
crash server-side — which is what the generic "an error occurred while saving
this device" turned out to be.

## Architecture

The Gladys integration SDK is Node.js. pyatv — the only complete implementation
of Apple's protocols — is Python. So the image ships both, and the Node process
drives a long-lived Python worker over a pipe.

```
┌──────────────── container ────────────────┐
│                                           │
│  index.js                                 │
│    ├── AppleTvService   orchestration     │
│    ├── actions.js       pairing, actions  │
│    ├── discovery.js     mDNS + unicast    │
│    └── PyatvBridge  ──┐                   │
│                       │ JSON lines        │
│                    pyatv_bridge.py        │
│                       └── pyatv sessions  │
└───────────────────────────────────────────┘
```

| File                                                 | Role                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [`index.js`](index.js)                               | Wiring: SDK handlers, lifecycle, shutdown                       |
| [`src/apple-tv-service.js`](src/apple-tv-service.js) | One live session per device, command routing, state publication |
| [`src/actions.js`](src/actions.js)                   | The configuration-screen buttons, pairing included              |
| [`src/discovery.js`](src/discovery.js)               | Mediated mDNS scan, then unicast verification                   |
| [`src/device-model.js`](src/device-model.js)         | Gladys device payload                                           |
| [`src/features.js`](src/features.js)                 | Feature catalogue and the pyatv command behind each one         |
| [`src/pyatv-bridge.js`](src/pyatv-bridge.js)         | Node side of the worker protocol, respawn included              |
| [`src/pyatv_bridge.py`](src/pyatv_bridge.py)         | Python worker: sessions, push updates, pairing                  |
| [`src/config.js`](src/config.js)                     | Normalization of the configuration form                         |

### Why a persistent worker

An Apple TV session costs one to two seconds to open, and push updates only
exist while the connection is held. Spawning `atvremote` per command would make
every button feel broken and would give up real-time state entirely.

### Why mediated discovery

The integration container runs on a Docker bridge network, where multicast never
arrives — pyatv cannot browse mDNS from in there. The manifest declares an
`_airplay._tcp` capture, the Gladys core browses it from the host network, and
the integration verifies each candidate address with a **unicast** pyatv query,
which does cross the bridge. Manual addresses cover routed networks and VLANs.

Only the first `network_discovery` entry of a given type is honoured by the core,
so exactly one mDNS service is declared — a second one would silently do nothing.

The mediated capture is only as good as the core's own view of the network, and
that view is not always the LAN. Verified on a Mac running Gladys under
OrbStack: `network_mode: host` puts the core on the virtual machine's bridge
(`192.168.139.0/23`) while the Apple TV lives on `192.168.0.0/24`, so multicast
never arrives and announcements come back partial — with a host name but no
address record. Unicast still routes, which is why `manual_hosts` is a first
class path and not a curiosity: it makes the whole integration work on any
VM-backed Docker (Docker Desktop, OrbStack, Colima). Announcements that cannot
be resolved to an address are named in the log rather than dropped in silence.

### Pairing

tvOS 15+ needs two sets of credentials: **AirPlay** (which carries the tunnelled
MRP stream: metadata, playback, volume) and **Companion** (remote, power, apps).
Each one is a separate PIN shown on the television, so pairing is a two-action
conversation: `pair_start`, then `pair_pin` once per protocol.

Latency is the enemy here — the connection carrying a code closes on its own
after roughly a minute, and the failure surfaces as a bare `not connected` from
pyatv. Two things follow from that, both verified against a real Apple TV 4K:

- `pair_pin` opens the **next** protocol inside the same worker call, reusing the
  configuration object pyatv just wrote the credentials onto. No round trip and
  no rescan between two codes.
- When a step fails because its session died, the worker reopens it and returns
  a **fresh code** in the same answer, so the user reads a new code instead of
  hitting a dead end.

RAOP also advertises itself as "pairing mandatory" but only serves audio
streaming _to_ the device, which this integration does not expose: it is left
unpaired and disabled at connection time, saving the user a third PIN.

Credentials are stored by pyatv in `/data/pyatv.json`, the only writable path in
the sandbox.

### State publication

States are deduplicated before being published: Gladys accepts 300 states per
minute per integration, and an Apple TV pushes a playback update every second
while seeking. Only what actually moved is sent.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

`npm test` runs the Node test suite and compiles the Python worker.

To exercise the worker by hand against a real Apple TV, outside Docker (where
multicast works, so `hosts` can be omitted):

```bash
echo '{"id":1,"method":"scan","params":{"timeout":6}}' | python3 src/pyatv_bridge.py
```

### Trying a change on a real Gladys, without releasing

Every push to `main` republishes a rolling
`ghcr.io/valentinhttr/gladys-apple-tv:dev` image (see
[`.github/workflows/dev.yml`](.github/workflows/dev.yml)). It runs the same
gates as CI first, and never touches the released tags nor `latest`.

Install it once, from **Integrations → Install from GitHub → developer mode**,
with `ghcr.io/valentinhttr/gladys-apple-tv:dev` as the image and the manifest
field left **empty**: the workflow copies the manifest into the
`io.gladysassistant.manifest` image label, which is exactly where Gladys reads
it for an install by image. Two fields are rewritten on the way in — the
`docker_image` names the `:dev` tag, and the version becomes
`<version>-dev.<run number>` so the Supervision tab says which build is
running. The name gets a `(dev)` suffix, so this install and the store one can
sit side by side without any confusion.

To pick up a later build: the integration page → **Supervision → Force update**.
A dev install has no store entry, so there is no "update available" banner; the
force button re-pulls the `:dev` tag and recreates the container.

Each build is also pushed as `:dev-<short sha>`, to pin a specific one.

### Releasing

Run the **Release** workflow from the GitHub Actions tab and pick a bump level.
It updates `package.json` and the manifest (`version` and the `docker_image`
tag), pushes the `vX.Y.Z` tag, builds the multi-arch image and publishes it to
`ghcr.io`. The Gladys store indexer picks it up within the hour.

## Credits

- [pyatv](https://github.com/postlund/pyatv), by the pyatv contributors, provides
  the Apple protocol implementation used for discovery, pairing, metadata and
  remote control.
- [Home Assistant's Apple TV integration](https://www.home-assistant.io/integrations/apple_tv/)
  informed the useful feature set and the pairing UX. It was used strictly as a
  functional reference: no Home Assistant source code was copied.
- [Gladys Assistant](https://github.com/GladysAssistant/Gladys), its
  external-integration documentation, JavaScript SDK and official template
  define the host architecture this project implements.

## License

Apache-2.0. See [LICENSE](LICENSE). pyatv is a separate project, distributed
under the MIT license.
