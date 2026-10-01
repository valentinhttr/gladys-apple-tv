#!/usr/bin/env python3
"""JSON-lines bridge between the Node.js integration and pyatv.

pyatv is an asyncio Python library and the Gladys SDK is Node.js, so the
integration runs this script as a long-lived child process and talks to it over
stdin/stdout with newline-delimited JSON. A persistent process (rather than one
`atvremote` invocation per command) is what makes the integration usable: an
Apple TV session costs one to two seconds to set up, and push updates only
exist for as long as the connection is held open.

Wire format, one JSON object per line:

  Node -> bridge   {"id": 1, "method": "connect", "params": {...}}
  bridge -> Node   {"id": 1, "ok": true, "result": {...}}
                   {"id": 1, "ok": false, "error": {"message": "...", "kind": "..."}}
  bridge -> Node   {"event": "state", "identifier": "...", "state": {...}}

stdout carries the protocol and nothing else: every log goes to stderr, which
the Gladys supervisor captures (`docker logs`).
"""

import asyncio
import json
import logging
import os
import sys
import traceback
from ipaddress import IPv4Address
from typing import Any, Dict, Iterable, List, Mapping, Optional

import pyatv
from pyatv import exceptions as pyatv_exceptions
from pyatv import interface
from pyatv.const import DeviceModel, FeatureName, FeatureState, PowerState, Protocol
from pyatv.core import mdns
from pyatv.core.scan import BaseScanner
from pyatv.protocols import PROTOCOLS
from pyatv.storage.file_storage import FileStorage

LOGGER = logging.getLogger("pyatv-bridge")

# Directly forwarded to `atv.remote_control.<name>()`. Everything that needs an
# argument or another interface is handled explicitly in `DeviceSession.command`.
REMOTE_ACTIONS = frozenset(
    {
        "up",
        "down",
        "left",
        "right",
        "select",
        "menu",
        "home",
        "home_hold",
        "top_menu",
        "play",
        "pause",
        "play_pause",
        "stop",
        "next",
        "previous",
        "skip_forward",
        "skip_backward",
        "volume_up",
        "volume_down",
        "channel_up",
        "channel_down",
        "screensaver",
        "suspend",
        "wakeup",
        "guide",
        "control_center",
    }
)

# Keys served by Companion whenever Companion is paired, instead of by whichever
# protocol wins the pyatv facade (MRP, tunnelled over AirPlay since tvOS 15).
#
# tvOS does not read a directional key as an event but as a GESTURE: it measures
# the interval between the HID key-down and the key-up, and hands the result to a
# tap or a long-press recognizer (pyatv#792). pyatv sends the two events back to
# back with no delay, but over MRP they travel through the AirPlay tunnel, and
# that latency is enough for the home screen to see a HELD key and auto-repeat —
# one press of Left moves the focus by two applications instead of one.
#
# Companion is the protocol the click ring of a physical Siri Remote speaks: its
# `_hidC` button events go over their own connection, so the down/up pair stays
# short. Only the navigation keys are rerouted; the media commands stay on the
# facade, where MRP carries real playback semantics (`play_pause` reads the
# current playback state) that Companion's blind HID button cannot.
COMPANION_FIRST_ACTIONS = frozenset(
    {
        "up",
        "down",
        "left",
        "right",
        "select",
        "menu",
        "home",
        "control_center",
    }
)

# Capability name reported to Node -> the pyatv feature that backs it. Node uses
# this to decide which Gladys features are worth publishing for a device: an
# Apple TV driven over HDMI-CEC has no readable volume level, publishing a
# volume slider for it would only produce a control that never works.
CAPABILITY_FEATURES = {
    "play": FeatureName.Play,
    "pause": FeatureName.Pause,
    "skip_backward": FeatureName.SkipBackward,
    "skip_forward": FeatureName.SkipForward,
    "power": FeatureName.PowerState,
    "turn_on": FeatureName.TurnOn,
    "turn_off": FeatureName.TurnOff,
    "volume": FeatureName.Volume,
    "set_volume": FeatureName.SetVolume,
    "volume_up": FeatureName.VolumeUp,
    "volume_down": FeatureName.VolumeDown,
    "push_updates": FeatureName.PushUpdates,
    "app": FeatureName.App,
    "app_list": FeatureName.AppList,
    "launch_app": FeatureName.LaunchApp,
    "play_url": FeatureName.PlayUrl,
    "keyboard": FeatureName.TextSet,
    "artwork": FeatureName.Artwork,
    "position": FeatureName.Position,
}

# Protocols the integration pairs, in the order the user is walked through them.
# A tvOS 15+ device also advertises RAOP as "pairing mandatory", but RAOP only
# serves audio STREAMING TO the device, which this integration does not expose:
# pairing it would cost the user a third PIN for nothing. AirPlay carries the
# tunnelled MRP stream (metadata, playback, volume) and Companion carries the
# remote, power and apps.
PAIRABLE_PROTOCOLS = ("AirPlay", "Companion")

# The models this integration controls. A HomePod runs tvOS and speaks the very
# same AirPlay and Companion protocols, so the operating system tells the two
# apart in no way at all — pyatv itself derives `operating_system` FROM the
# model, and answers TvOS for a HomePod. Matching on the hardware model is the
# only honest test, and Apple publishes it in the AirPlay TXT record.
APPLE_TV_MODELS = frozenset(
    {
        DeviceModel.AppleTVGen1,
        DeviceModel.Gen2,
        DeviceModel.Gen3,
        DeviceModel.Gen4,
        DeviceModel.Gen4K,
        DeviceModel.AppleTV4KGen2,
        DeviceModel.AppleTV4KGen3,
    }
)

# Reconnection backoff, in seconds. An Apple TV unplugged for the evening must
# not be retried in a tight loop, and one that just rebooted must come back
# quickly.
RECONNECT_DELAYS = (2, 5, 10, 30, 60, 120, 300)

# A device answering its unicast mDNS query is enough to build a config: no need
# to wait for the full multicast window.
DEFAULT_SCAN_TIMEOUT = 5


class MediatedScanner(BaseScanner):
    """Build pyatv configurations from announcements captured by the Gladys core.

    pyatv normally learns about a device by browsing mDNS itself, which the
    integration container cannot do (no multicast on a Docker bridge network),
    and then by querying each candidate address directly. That direct query is
    what fails across routed VLANs: an Apple TV ignores a unicast mDNS query
    whose source sits outside its own subnet, so the candidate never answers and
    no configuration is ever built.

    The Gladys core runs on the host network and already receives the relayed
    announcements. Since Gladys 5.0.0 it browses EVERY mDNS service declared in
    the manifest, so what it hands back is the same set of SRV/TXT records
    pyatv's own scanner would have parsed. Replaying them through pyatv's real
    scan handlers produces a genuine configuration — identifier, model, pairing
    requirements and all — without a single packet leaving the container.
    """

    def __init__(self, responses: List[mdns.Response]) -> None:
        super().__init__()
        self._responses = responses

    async def process(self, timeout: int) -> None:
        """Replay the captured announcements. Nothing is sent on the network."""
        for response in self._responses:
            self.handle_response(response)


def _properties_of(announcement: Mapping[str, Any]) -> Dict[str, str]:
    """Turn the core's `key=value` TXT strings into the mapping pyatv expects.

    Keys are lowercased because that is what the scan handlers look up, and a
    responder is free to announce `rpMac` or `rpmac`.
    """
    properties: Dict[str, str] = {}
    for entry in announcement.get("txt") or []:
        key, separator, value = str(entry).partition("=")
        if separator:
            properties[key.lower()] = value
    return properties


def responses_from_announcements(
    announcements: Iterable[Mapping[str, Any]],
) -> List[mdns.Response]:
    """Group raw mediated announcements into one pyatv response per address.

    An announcement is `{name, host, addresses, port, txt}`, where `name` is the
    full instance name (`Living Room._airplay._tcp.local`) — its suffix is the
    service type pyatv dispatches on. Grouping by address is what lets pyatv
    merge the services of one device into a single configuration.
    """
    services_by_address: Dict[IPv4Address, List[mdns.Service]] = {}
    for announcement in announcements or []:
        name = str(announcement.get("name") or "")
        short_name, separator, service_type = name.partition(".")
        port = announcement.get("port")
        if not separator or not isinstance(port, int) or port == 0:
            continue
        properties = _properties_of(announcement)
        for raw_address in announcement.get("addresses") or []:
            try:
                address = IPv4Address(str(raw_address))
            except ValueError:
                # AAAA records come through the same field; pyatv is IPv4 only.
                continue
            services_by_address.setdefault(address, []).append(
                mdns.Service(service_type, short_name, address, port, properties)
            )
    return [
        mdns.Response(services=services, deep_sleep=False, model=None)
        for services in services_by_address.values()
    ]


def _feature_state(atv: interface.AppleTV, feature: FeatureName) -> FeatureState:
    try:
        return atv.features.get_feature(feature).state
    except Exception:  # noqa: BLE001 - a capability probe must never break a session
        return FeatureState.Unknown


def _enum_name(value: Any) -> Optional[str]:
    return value.name.lower() if value is not None and hasattr(value, "name") else None


def is_apple_tv(info: interface.DeviceInfo) -> bool:
    """Tell an Apple TV from the other Apple devices an AirPlay scan finds.

    A scan also returns HomePods, AirPort Express, Macs and third-party AirPlay
    speakers. None of them can be driven by this integration, and a HomePod is
    the trap: it runs tvOS and announces both AirPlay and Companion, so it looks
    exactly like an Apple TV to everything except its model.

    pyatv resolves the model of the hardware it knows; anything newer than the
    installed pyatv falls back to the raw identifier, which Apple has always
    prefixed with `AppleTV` (`AppleTV14,1`) — HomePods use `AudioAccessory`.
    So an Apple TV released after this pyatv is still recognised.

    :param info: Device information of a scanned configuration.
    :returns: True when the device is an Apple TV.
    """
    if info.model in APPLE_TV_MODELS:
        return True
    if info.model != DeviceModel.Unknown:
        # A model pyatv resolved to something else (HomePod, AirPort Express,
        # the Music app) is a definitive no, whatever the raw string says.
        return False
    return (info.raw_model or "").startswith("AppleTV")


def describe_config(config: interface.BaseConfig) -> Dict[str, Any]:
    """Serialize a scanned pyatv configuration for the Node side."""
    info = config.device_info
    services = []
    for service in config.services:
        services.append(
            {
                "protocol": service.protocol.name,
                "port": service.port,
                "pairing": service.pairing.name,
                "enabled": service.enabled,
                "has_credentials": bool(service.credentials),
                "requires_password": bool(service.requires_password),
            }
        )
    raw_model = info.raw_model or ""
    return {
        "identifier": config.identifier,
        "all_identifiers": sorted(config.all_identifiers),
        "name": config.name,
        "address": str(config.address),
        "model": info.model_str,
        "raw_model": raw_model,
        "operating_system": _enum_name(info.operating_system),
        "version": info.version,
        "mac": info.mac,
        "services": services,
        # Readable before any pairing, which is what lets the scan filter the
        # devices it cannot control before offering them to the user.
        "is_apple_tv": is_apple_tv(info),
        # A protocol we pair whose pairing is mandatory and that has no stored
        # credentials yet is exactly what the pairing action has to walk the
        # user through, in this order.
        "pairing_needed": [
            protocol
            for protocol in PAIRABLE_PROTOCOLS
            for service in services
            if service["protocol"] == protocol
            and service["pairing"] == "Mandatory"
            and not service["has_credentials"]
        ],
    }


class DeviceSession(
    interface.DeviceListener,
    interface.PushListener,
    interface.PowerListener,
    interface.AudioListener,
):
    """One persistent connection to one Apple TV.

    pyatv holds listeners through weak references, so this object must stay
    referenced by `Bridge.sessions` for its callbacks to keep firing.
    """

    def __init__(self, bridge: "Bridge", identifier: str, host: str) -> None:
        self.bridge = bridge
        self.identifier = identifier
        self.host = host
        self.atv: Optional[interface.AppleTV] = None
        self.capabilities: Dict[str, bool] = {}
        self.connected = False
        self.closing = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._reconnect_attempt = 0

    # -- lifecycle ----------------------------------------------------------

    async def connect(self) -> Dict[str, Any]:
        """Open the session. Raises when the device cannot be reached or is unpaired."""
        configs = await self.bridge.scan_configs(hosts=[self.host], identifier=self.identifier)
        if not configs:
            raise pyatv_exceptions.ConnectionFailedError(
                f"No Apple TV answered at {self.host}. Check that it is powered on "
                "and reachable from the Gladys host."
            )
        config = configs[0]
        self.host = str(config.address)

        described = describe_config(config)
        if described["pairing_needed"]:
            raise pyatv_exceptions.NoCredentialsError(
                "This Apple TV is not paired yet ("
                + ", ".join(described["pairing_needed"])
                + "). Run the pairing from the integration configuration screen."
            )

        # RAOP is advertised as "pairing mandatory" on tvOS 15+ and we
        # deliberately never pair it (see PAIRABLE_PROTOCOLS). Left enabled, it
        # makes pyatv keep retrying an authentication that can only fail.
        for service in config.services:
            if service.pairing.name == "Mandatory" and not service.credentials:
                LOGGER.debug(
                    "Disabling the unpaired %s service of %s",
                    service.protocol.name,
                    self.identifier,
                )
                service.enabled = False

        atv = await pyatv.connect(config, self.bridge.loop, storage=self.bridge.storage)
        self.atv = atv
        self.connected = True
        self._reconnect_attempt = 0

        atv.listener = self
        atv.power.listener = self
        atv.audio.listener = self
        atv.push_updater.listener = self

        self.capabilities = {
            name: _feature_state(atv, feature) != FeatureState.Unsupported
            for name, feature in CAPABILITY_FEATURES.items()
        }
        # A device that can be switched on and off is worth a power switch even
        # when it does not report a readable power state.
        self.capabilities["power"] = (
            self.capabilities["power"]
            or self.capabilities["turn_on"]
            or self.capabilities["turn_off"]
        )

        if self.capabilities.get("push_updates"):
            try:
                atv.push_updater.start()
            except pyatv_exceptions.NotSupportedError:
                self.capabilities["push_updates"] = False

        state = await self.snapshot()
        self.bridge.emit_event(
            "connection", identifier=self.identifier, connected=True, capabilities=self.capabilities
        )
        return {"capabilities": self.capabilities, "state": state, "address": self.host}

    async def close(self) -> None:
        self.closing = True
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            self._reconnect_task = None
        await self._teardown()

    async def _teardown(self) -> None:
        atv, self.atv = self.atv, None
        self.connected = False
        if atv is None:
            return
        try:
            await asyncio.gather(*atv.close(), return_exceptions=True)
        except Exception:  # noqa: BLE001 - closing must never raise
            LOGGER.debug("Error while closing %s", self.identifier, exc_info=True)

    def _schedule_reconnect(self, reason: str) -> None:
        if self.closing or self._reconnect_task is not None:
            return
        self.bridge.emit_event(
            "connection", identifier=self.identifier, connected=False, error=reason
        )
        self._reconnect_task = self.bridge.loop.create_task(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        try:
            while not self.closing:
                delay = RECONNECT_DELAYS[min(self._reconnect_attempt, len(RECONNECT_DELAYS) - 1)]
                self._reconnect_attempt += 1
                await asyncio.sleep(delay)
                if self.closing:
                    return
                await self._teardown()
                try:
                    await self.connect()
                    LOGGER.info("Reconnected to %s", self.identifier)
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as err:  # noqa: BLE001 - keep retrying, whatever it was
                    LOGGER.info("Reconnection to %s failed: %s", self.identifier, err)
        except asyncio.CancelledError:
            pass
        finally:
            self._reconnect_task = None

    # -- pyatv listeners ----------------------------------------------------

    def connection_lost(self, exception: Exception) -> None:
        LOGGER.warning("Connection to %s lost: %s", self.identifier, exception)
        self.connected = False
        self._schedule_reconnect(str(exception) or "connection lost")

    def connection_closed(self) -> None:
        LOGGER.info("Connection to %s closed by the device", self.identifier)
        self.connected = False
        self._schedule_reconnect("connection closed by the device")

    def playstatus_update(self, updater, playstatus: interface.Playing) -> None:
        self.bridge.emit_event(
            "state", identifier=self.identifier, state=self._playing_state(playstatus)
        )

    def playstatus_error(self, updater, exception: Exception) -> None:
        LOGGER.debug("Push update error on %s: %s", self.identifier, exception)

    def powerstate_update(self, old_state: PowerState, new_state: PowerState) -> None:
        self.bridge.emit_event(
            "state", identifier=self.identifier, state={"power": _enum_name(new_state)}
        )

    def volume_update(self, old_level: float, new_level: float) -> None:
        self.bridge.emit_event(
            "state", identifier=self.identifier, state={"volume": round(new_level)}
        )

    def volume_device_update(self, output_device, old_level: float, new_level: float) -> None:
        # Per-output-device volume (an AirPlay group): the device-wide
        # `volume_update` above is the one Gladys exposes.
        LOGGER.debug("Output device volume changed on %s", self.identifier)

    def outputdevices_update(self, old_devices, new_devices) -> None:
        LOGGER.debug("Output devices changed on %s", self.identifier)

    # -- state --------------------------------------------------------------

    @staticmethod
    def _playing_state(playing: interface.Playing) -> Dict[str, Any]:
        return {
            "playback_state": _enum_name(playing.device_state),
            "media_type": _enum_name(playing.media_type),
            "title": playing.title,
            "artist": playing.artist,
            "album": playing.album,
            "series_name": playing.series_name,
            "season_number": playing.season_number,
            "episode_number": playing.episode_number,
            "position": playing.position,
            "total_time": playing.total_time,
        }

    async def snapshot(self) -> Dict[str, Any]:
        """Read everything the device exposes right now.

        Every block is optional: a HomePod has no apps, an Apple TV without a
        controllable audio output has no volume level. A failure to read one
        block must never cost the others.
        """
        atv = self._require_atv()
        state: Dict[str, Any] = {"connected": True}

        if self.capabilities.get("power"):
            state["power"] = _enum_name(atv.power.power_state)

        try:
            state.update(self._playing_state(await atv.metadata.playing()))
        except pyatv_exceptions.NotSupportedError:
            pass
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Could not read what is playing on %s: %s", self.identifier, err)

        if self.capabilities.get("app"):
            state["app_name"] = None
            state["app_identifier"] = None
            app = atv.metadata.app
            if app is not None:
                state["app_name"] = app.name
                state["app_identifier"] = app.identifier

        if self.capabilities.get("volume"):
            try:
                state["volume"] = round(atv.audio.volume)
            except Exception as err:  # noqa: BLE001
                LOGGER.debug("Could not read the volume of %s: %s", self.identifier, err)

        return state

    # -- commands -----------------------------------------------------------

    def _require_atv(self) -> interface.AppleTV:
        if self.atv is None or not self.connected:
            raise pyatv_exceptions.ConnectionFailedError(
                f"Not connected to {self.identifier}. The Apple TV is unreachable, "
                "or its pairing was revoked."
            )
        return self.atv

    async def _remote_key(self, atv: interface.AppleTV, action: str) -> None:
        """Press one remote key, over Companion when that is the better path.

        See COMPANION_FIRST_ACTIONS. Falls back to the facade when Companion is
        not paired, or when it turns out not to implement the key after all: a
        navigation key that works over a slower protocol beats one that raises.
        """
        if action in COMPANION_FIRST_ACTIONS:
            companion = atv.remote_control.get(Protocol.Companion)
            if companion is not None:
                LOGGER.debug("Sending %s over Companion to %s", action, self.identifier)
                try:
                    await getattr(companion, action)()
                    return
                except pyatv_exceptions.NotSupportedError:
                    LOGGER.debug("Companion does not serve %s, falling back", action)

        LOGGER.debug("Sending %s over %s", action, atv.remote_control.main_protocol)
        await getattr(atv.remote_control, action)()

    async def command(self, action: str, value: Any = None) -> Dict[str, Any]:
        atv = self._require_atv()

        if action in REMOTE_ACTIONS:
            await self._remote_key(atv, action)
        elif action == "turn_on":
            await atv.power.turn_on()
        elif action == "turn_off":
            await atv.power.turn_off()
        elif action == "set_volume":
            await atv.audio.set_volume(float(value))
        elif action == "set_position":
            await atv.remote_control.set_position(int(value))
        elif action == "launch_app":
            await atv.apps.launch_app(str(value))
        elif action == "play_url":
            await atv.stream.play_url(str(value))
        elif action == "text_set":
            await atv.keyboard.text_set(str(value))
        elif action == "text_append":
            await atv.keyboard.text_append(str(value))
        elif action == "text_clear":
            await atv.keyboard.text_clear()
        else:
            raise ValueError(f"Unknown Apple TV command: {action}")

        # Power and volume have no reliable push update on every model: read the
        # value back so Gladys shows the real state and not the requested one.
        if action in ("turn_on", "turn_off", "set_volume", "launch_app"):
            await asyncio.sleep(0.5)
            try:
                self.bridge.emit_event(
                    "state", identifier=self.identifier, state=await self.snapshot()
                )
            except Exception:  # noqa: BLE001 - the command itself did succeed
                LOGGER.debug("Post-command refresh failed for %s", self.identifier, exc_info=True)

        return {}

    async def app_list(self) -> List[Dict[str, str]]:
        atv = self._require_atv()
        if not self.capabilities.get("app_list"):
            raise pyatv_exceptions.NotSupportedError(
                "This Apple TV does not expose the list of installed applications."
            )
        apps = await atv.apps.app_list()
        return sorted(
            ({"identifier": app.identifier, "name": app.name} for app in apps),
            key=lambda app: app["name"].lower(),
        )


class PairingSession:
    """One in-flight pairing, kept alive between the two user actions.

    The PIN shown on the television belongs to the session opened by
    `pair_begin`: closing it and opening a new one for `pair_pin` would
    invalidate the code the user is reading on their screen.

    The scanned configuration is kept with the session, because pyatv writes the
    freshly obtained credentials straight onto its service objects: after a
    successful step, the same object already tells which protocols are left, and
    the next one can be started without paying for another scan. That latency
    matters — the connection carrying the code does not stay open forever.
    """

    def __init__(self, identifier: str, host: str, protocol: Protocol, handler, config) -> None:
        self.identifier = identifier
        self.host = host
        self.protocol = protocol
        self.handler = handler
        self.config = config

    async def close(self) -> None:
        try:
            await self.handler.close()
        except Exception:  # noqa: BLE001 - closing must never raise
            LOGGER.debug("Error while closing the pairing session", exc_info=True)


class Bridge:
    def __init__(self, storage_file: str, loop: asyncio.AbstractEventLoop) -> None:
        self.storage_file = storage_file
        self.loop = loop
        self.storage: Optional[interface.Storage] = None
        self.sessions: Dict[str, DeviceSession] = {}
        self.pairing: Optional[PairingSession] = None
        self._tasks: set = set()
        # Configurations built from the last mediated scan, keyed by every
        # identifier and by address. They are what makes a connection possible
        # when the device never answers a direct query (see MediatedScanner):
        # `connect` and the pairing go through `scan_configs` too, and a scan
        # only happens when the user asks for one.
        self.announced: Dict[str, interface.BaseConfig] = {}

    # -- transport ----------------------------------------------------------

    def _write(self, payload: Dict[str, Any]) -> None:
        try:
            sys.stdout.write(json.dumps(payload, default=str) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            # Node is gone: nothing left to talk to.
            os._exit(0)

    def emit_event(self, event: str, **fields: Any) -> None:
        self._write({"event": event, **fields})

    # -- pyatv helpers ------------------------------------------------------

    async def remember_announcements(
        self, announcements: Optional[List[Mapping[str, Any]]]
    ) -> List[interface.BaseConfig]:
        """Rebuild the mediated configurations from a fresh set of announcements.

        Stored credentials are applied here, exactly as `pyatv.scan` does, so a
        mediated configuration is indistinguishable from a scanned one — without
        it every device would look unpaired.
        """
        if not announcements:
            return []
        scanner = MediatedScanner(responses_from_announcements(announcements))
        for protocol, methods in PROTOCOLS.items():
            scanner.add_service_info(protocol, methods.service_info)
            for service_type, handler in methods.scan().items():
                scanner.add_service(service_type, handler, methods.device_info)

        configs = [config for config in (await scanner.discover(0)).values() if config.ready]
        # Replaced rather than merged: a scan returns the whole current picture,
        # so keeping older entries would let a device that changed address be
        # reached at the previous one forever. An empty capture is left alone
        # above, so a transient failure never wipes what still works.
        announced: Dict[str, interface.BaseConfig] = {}
        for config in configs:
            if self.storage is not None:
                config.apply(await self.storage.get_settings(config))
            for key in [*config.all_identifiers, str(config.address)]:
                announced[key] = config
        self.announced = announced
        LOGGER.debug(
            "Built %d configuration(s) from %d mediated announcement(s)",
            len(configs),
            len(announcements),
        )
        return configs

    def _announced_configs(
        self, hosts: Optional[List[str]], identifier: Optional[str]
    ) -> List[interface.BaseConfig]:
        """The mediated configurations matching a scan request, without duplicates."""
        keys = [identifier] if identifier else list(hosts or [])
        configs: List[interface.BaseConfig] = []
        for key in keys:
            config = self.announced.get(key)
            if config is not None and not any(
                existing.identifier == config.identifier for existing in configs
            ):
                configs.append(config)
        return configs

    async def scan_configs(
        self,
        hosts: Optional[List[str]] = None,
        identifier: Optional[str] = None,
        timeout: int = DEFAULT_SCAN_TIMEOUT,
        announcements: Optional[List[Mapping[str, Any]]] = None,
    ) -> List[interface.BaseConfig]:
        """Unicast scan, completed by what the Gladys core announced.

        The integration container sits on a Docker bridge network, where
        multicast never arrives: mDNS browsing is done by the Gladys core on the
        host and the addresses it finds are verified here, one unicast query per
        candidate. `hosts=None` (multicast) only works outside Docker, during
        development.

        That verification is also the step that fails across routed VLANs, where
        an Apple TV ignores a query coming from another subnet. The direct answer
        stays authoritative when it arrives — it proves the device is reachable
        and reports its live state — and the mediated configuration takes over
        for the candidates that stayed silent, which would otherwise be lost.
        """
        if announcements is not None:
            await self.remember_announcements(announcements)
        configs = await pyatv.scan(
            self.loop,
            timeout=timeout,
            hosts=hosts,
            identifier=identifier,
            storage=self.storage,
        )
        answered = {config.identifier for config in configs}
        answered.update(str(config.address) for config in configs)
        for config in self._announced_configs(hosts, identifier):
            if config.identifier in answered or str(config.address) in answered:
                continue
            LOGGER.debug(
                "Using the mediated configuration for %s (%s): no direct answer",
                config.name,
                config.address,
            )
            configs.append(config)
        return configs

    def _session(self, identifier: str) -> DeviceSession:
        session = self.sessions.get(identifier)
        if session is None:
            raise KeyError(f"Apple TV {identifier} is not connected")
        return session

    # -- methods ------------------------------------------------------------

    async def method_ping(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        return {"pong": True, "pyatv_version": pyatv.const.__version__}

    async def method_scan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        hosts = params.get("hosts") or None
        timeout = int(params.get("timeout") or DEFAULT_SCAN_TIMEOUT)
        configs = await self.scan_configs(
            hosts=hosts, timeout=timeout, announcements=params.get("announcements")
        )
        # A mediated configuration is the very object held in the cache, so
        # identity tells the two apart. Node reports it: a device rebuilt from an
        # announcement was never actually reached, and saying so is the
        # difference between "it works" and "it will fail at the first command".
        mediated = {id(config) for config in self.announced.values()}
        return {
            "devices": [
                dict(
                    describe_config(config),
                    source="announced" if id(config) in mediated else "direct",
                )
                for config in configs
            ]
        }

    async def method_announcements(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Refresh the mediated configurations without running a scan.

        Sessions are opened at startup, before the user has asked for anything,
        so the addresses of a routed network have to be known by then or every
        reconnection would fail until the next manual scan.
        """
        configs = await self.remember_announcements(params.get("announcements"))
        return {"count": len(configs)}

    async def method_connect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        identifier = params["identifier"]
        host = params["host"]
        existing = self.sessions.pop(identifier, None)
        if existing is not None:
            await existing.close()
        session = DeviceSession(self, identifier, host)
        self.sessions[identifier] = session
        try:
            return await session.connect()
        except pyatv_exceptions.NoCredentialsError:
            # Retrying would never help: only the user, through the pairing
            # action, can unblock this one.
            self.sessions.pop(identifier, None)
            raise
        except Exception as err:
            # Keep the session registered so it keeps retrying in the
            # background: an Apple TV that is simply unplugged right now must
            # come back on its own, without a new user gesture.
            session._schedule_reconnect(str(err) or "initial connection failed")  # noqa: SLF001
            raise

    async def method_disconnect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self.sessions.pop(params["identifier"], None)
        if session is not None:
            await session.close()
        return {}

    async def method_snapshot(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"state": await self._session(params["identifier"]).snapshot()}

    async def method_command(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self._session(params["identifier"])
        return await session.command(params["action"], params.get("value"))

    async def method_app_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"apps": await self._session(params["identifier"]).app_list()}

    async def method_status(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "sessions": [
                {
                    "identifier": session.identifier,
                    "host": session.host,
                    "connected": session.connected,
                    "capabilities": session.capabilities,
                }
                for session in self.sessions.values()
            ]
        }

    # -- pairing ------------------------------------------------------------

    async def _begin_protocol(self, config, host: str) -> Dict[str, Any]:
        """Open a pairing session for the first protocol still missing credentials.

        Returns the step to show the user, or `{"done": True}` when there is
        nothing left to pair.
        """
        described = describe_config(config)
        pending = described["pairing_needed"]
        if not pending:
            return {"done": True, "device": described}

        protocol = Protocol[pending[0]]
        # A live session holds the protocol we are about to pair: drop it first,
        # the Apple TV refuses to pair a protocol it is already serving.
        session = self.sessions.pop(described["identifier"], None)
        if session is not None:
            await session.close()

        handler = await pyatv.pair(config, protocol, self.loop, storage=self.storage)
        await handler.begin()
        self.pairing = PairingSession(described["identifier"], host, protocol, handler, config)

        step = {
            "done": False,
            "protocol": protocol.name,
            "device_provides_pin": handler.device_provides_pin,
            "remaining": pending,
            "device": described,
        }
        if not handler.device_provides_pin:
            # The device expects US to provide the code: pick one and tell the
            # user to type it on the television, then confirm the same value.
            pin = "1111"
            handler.pin(pin)
            step["pin"] = pin
        return step

    async def method_pair_begin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        host = params["host"]
        identifier = params.get("identifier")
        await self.method_pair_cancel({})

        configs = await self.scan_configs(hosts=[host], identifier=identifier)
        if not configs:
            raise pyatv_exceptions.ConnectionFailedError(
                f"No Apple TV answered at {host}. Check that it is powered on and "
                "on the same network as Gladys."
            )
        return await self._begin_protocol(configs[0], host)

    async def method_pair_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Confirm the code, then walk straight on to the next protocol.

        The whole sequence is driven from here rather than from a second call:
        the connection that carries a code does not stay open indefinitely, and
        a round trip plus a rescan between two steps is enough to lose it. For
        the same reason, a step that fails because the session died reopens
        itself and comes back with a fresh code instead of a dead end.
        """
        if self.pairing is None:
            raise RuntimeError(
                "No pairing is in progress. Start the pairing again, then enter "
                "the code displayed by the Apple TV."
            )
        pairing = self.pairing
        self.pairing = None
        pairing.handler.pin(str(params["pin"]).strip())

        failure: Optional[str] = None
        try:
            await pairing.handler.finish()
            if not pairing.handler.has_paired:
                failure = f"The Apple TV refused the code for {pairing.protocol.name}."
        except Exception as err:  # noqa: BLE001 - reported to the user, not raised
            failure = str(err) or type(err).__name__
        finally:
            await pairing.close()

        # pyatv writes the credentials onto the service objects of the config it
        # was given, so `pairing.config` already knows what is left to pair —
        # no rescan needed. Only `save()` makes them survive a restart.
        if failure is None and self.storage is not None:
            await self.storage.save()

        try:
            step = await self._begin_protocol(pairing.config, pairing.host)
        except Exception as err:  # noqa: BLE001
            if failure is not None:
                raise
            raise pyatv_exceptions.PairingError(
                f"{pairing.protocol.name} is paired, but the next step could not "
                f"be started: {err}"
            ) from err

        return {
            "paired_protocol": None if failure else pairing.protocol.name,
            "failure": failure,
            "done": step.get("done", False),
            "remaining": step.get("remaining", []),
            "next": None if step.get("done") else step,
            "device": step.get("device"),
        }

    async def method_pair_cancel(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        pairing, self.pairing = self.pairing, None
        if pairing is not None:
            await pairing.close()
        return {}

    async def method_forget(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Drop the stored credentials of a device (unpair)."""
        identifier = str(params["identifier"]).lower()
        session = self.sessions.pop(params["identifier"], None)
        if session is not None:
            await session.close()

        removed = False
        if self.storage is not None:
            # Settings are keyed by the device identity, not by the identifier
            # Gladys knows: match on every id pyatv could have derived it from.
            for settings in list(self.storage.settings):
                info = settings.info
                known = {
                    str(value).lower()
                    for value in (info.mac, info.device_id, info.rp_id)
                    if value
                }
                if identifier in known:
                    removed = await self.storage.remove_settings(settings) or removed
            if removed:
                await self.storage.save()
        return {"removed": removed}

    # -- dispatch -----------------------------------------------------------

    async def handle(self, request: Dict[str, Any]) -> None:
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        handler = getattr(self, f"method_{method}", None)
        if handler is None:
            self._write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"message": f"Unknown method: {method}", "kind": "UnknownMethod"},
                }
            )
            return
        try:
            result = await handler(params)
            self._write({"id": request_id, "ok": True, "result": result})
        except Exception as err:  # noqa: BLE001 - every failure travels to Node
            LOGGER.info("%s failed: %s", method, err)
            LOGGER.debug("%s", traceback.format_exc())
            self._write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"message": str(err) or type(err).__name__, "kind": type(err).__name__},
                }
            )

    async def run(self) -> None:
        self.storage = FileStorage(self.storage_file, self.loop)
        await self.storage.load()
        LOGGER.info("pyatv %s bridge ready (storage: %s)", pyatv.const.__version__, self.storage_file)
        self.emit_event("ready", pyatv_version=pyatv.const.__version__)

        reader = asyncio.StreamReader()
        await self.loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
        )

        while True:
            line = await reader.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                LOGGER.warning("Ignoring a malformed request")
                continue
            # One task per request: a slow command (a device waking up) must not
            # block the ones behind it.
            task = self.loop.create_task(self.handle(request))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        await self.shutdown()

    async def shutdown(self) -> None:
        await self.method_pair_cancel({})
        sessions = list(self.sessions.values())
        self.sessions.clear()
        for session in sessions:
            await session.close()
        if self.storage is not None:
            await self.storage.save()


def _self_test() -> None:
    """Check the assumptions this file makes about pyatv, against real pyatv.

    Only one so far, and it is the one that silently breaks on an upgrade: that
    a remote key can be steered to a specific protocol. `Relayer.get` is how
    COMPANION_FIRST_ACTIONS reaches Companion instead of the facade's own
    choice; if pyatv ever renames it, or stops ranking MRP above Companion, the
    navigation keys go back to moving the focus two applications at a time and
    nothing else would tell us.
    """
    from pyatv.core.facade import FacadeRemoteControl

    calls = []

    class _Probe(interface.RemoteControl):
        """A RemoteControl that records which protocol was asked, and for what.

        The keys are declared as real methods: pyatv's Relayer routes to the
        instance that OVERRIDES the interface method, so a __getattr__ trick
        would be invisible to it.
        """

        def __init__(self, tag: str) -> None:
            self.tag = tag

        async def up(self, action=None) -> None:
            calls.append((self.tag, "up"))

        async def down(self, action=None) -> None:
            calls.append((self.tag, "down"))

        async def left(self, action=None) -> None:
            calls.append((self.tag, "left"))

        async def right(self, action=None) -> None:
            calls.append((self.tag, "right"))

        async def select(self, action=None) -> None:
            calls.append((self.tag, "select"))

        async def menu(self, action=None) -> None:
            calls.append((self.tag, "menu"))

        async def home(self, action=None) -> None:
            calls.append((self.tag, "home"))

        async def control_center(self) -> None:
            calls.append((self.tag, "control_center"))

    facade = FacadeRemoteControl()
    facade.register(_Probe("mrp"), Protocol.MRP)
    facade.register(_Probe("companion"), Protocol.Companion)

    assert facade.main_protocol is Protocol.MRP, (
        f"pyatv no longer prefers MRP ({facade.main_protocol}): re-check whether "
        "the navigation keys still need to be steered to Companion"
    )

    class _Atv:
        remote_control = facade

    session = object.__new__(DeviceSession)
    session.identifier = "self-test"
    for action in sorted(COMPANION_FIRST_ACTIONS):
        asyncio.run(session._remote_key(_Atv(), action))  # noqa: SLF001

    served_by = {tag for tag, _ in calls}
    assert served_by == {"companion"}, f"navigation keys served by {served_by}, expected Companion"
    # Also catches a key added to COMPANION_FIRST_ACTIONS without a probe for
    # it: the relay would then answer from the interface stub, recording nothing.
    assert {name for _, name in calls} == COMPANION_FIRST_ACTIONS, (
        f"keys actually sent: {sorted(name for _, name in calls)}"
    )

    _self_test_model_filter()
    _self_test_mediated_scan()


def _self_test_model_filter() -> None:
    """Check the Apple TV filter against pyatv's own model table.

    The scan offers the user everything it calls an Apple TV, so a device that
    slips through here is one they can add and never control. Both branches are
    covered: the models pyatv resolves, and the raw fallback for hardware newer
    than the installed pyatv. That pyatv maps `AudioAccessory5,1` onto
    HomePodMini in the first place is proven end to end by the mediated scan.
    """
    for model, raw_model, expected in [
        (DeviceModel.AppleTV4KGen3, "AppleTV14,1", True),
        (DeviceModel.Gen2, "AppleTV2,1", True),  # legacy software, not tvOS at all
        (DeviceModel.HomePodMini, "AudioAccessory5,1", False),  # runs tvOS
        (DeviceModel.HomePodGen2, "AudioAccessory6,1", False),
        (DeviceModel.AirPortExpressGen2, "AirPort10,115", False),
        (DeviceModel.Unknown, "AppleTV99,1", True),  # released after this pyatv
        (DeviceModel.Unknown, "MacBookPro18,3", False),
        (DeviceModel.Unknown, "", False),
    ]:
        info = interface.DeviceInfo(
            {
                interface.DeviceInfo.MODEL: model,
                interface.DeviceInfo.RAW_MODEL: raw_model,
            }
        )
        assert is_apple_tv(info) is expected, (
            f"{raw_model or '<no model>'}: is_apple_tv={is_apple_tv(info)}, expected {expected}"
        )


def _self_test_mediated_scan() -> None:
    """Check that announcements alone still build a usable configuration.

    MediatedScanner is what makes a routed network work at all, and it is built
    on pyatv internals no unit test can reach: `BaseScanner.handle_response`,
    the `PROTOCOLS` scan handlers, and the shape of `mdns.Service`. If an
    upgrade changes any of them, discovery keeps "working" on a flat network and
    silently stops recovering anything across VLANs — the exact failure this
    exists to fix. So it is asserted against real pyatv, on records shaped like
    what a tvOS box actually announces.
    """
    announcements = [
        {
            "name": "Living Room._airplay._tcp.local",
            "host": "Apple-TV.local",
            "addresses": ["192.168.1.50"],
            "port": 7000,
            "txt": [
                "deviceid=AA:BB:CC:DD:EE:FF",
                "model=AppleTV14,1",
                "osvers=17.4",
                "flags=0x18644",
                "pk=abcdef0123456789",
                "acl=0",
            ],
        },
        {
            "name": "Living Room._companion-link._tcp.local",
            "host": "Apple-TV.local",
            "addresses": ["192.168.1.50"],
            "port": 49152,
            "txt": ["rpMac=1", "rpMd=AppleTV14,1", "rpFl=0x36782", "rpAD=1234abcd"],
        },
        # A HomePod mini, announcing the very same two services from the same
        # network. It must survive the scan as a device and be rejected on its
        # model alone: it runs tvOS, so anything reading the operating system
        # would offer it to the user as an Apple TV it can never control.
        {
            "name": "Kitchen._airplay._tcp.local",
            "host": "HomePod.local",
            "addresses": ["192.168.1.51"],
            "port": 7000,
            "txt": [
                "deviceid=11:22:33:44:55:66",
                "model=AudioAccessory5,1",
                "osvers=17.4",
                "flags=0x18644",
                "pk=fedcba9876543210",
                "acl=0",
            ],
        },
        {
            "name": "Kitchen._companion-link._tcp.local",
            "host": "HomePod.local",
            "addresses": ["192.168.1.51"],
            "port": 49152,
            "txt": ["rpMac=1", "rpMd=AudioAccessory5,1", "rpFl=0x36782", "rpAD=5678efab"],
        },
    ]

    bridge = object.__new__(Bridge)
    bridge.storage = None
    bridge.announced = {}
    configs = asyncio.run(bridge.remember_announcements(announcements))

    assert len(configs) == 2, f"expected two devices, got {len(configs)}"
    by_address = {str(entry.address): entry for entry in configs}
    assert set(by_address) == {"192.168.1.50", "192.168.1.51"}, f"addresses: {sorted(by_address)}"

    homepod = describe_config(by_address["192.168.1.51"])
    assert not homepod["is_apple_tv"], f"a HomePod was taken for an Apple TV: {homepod}"
    # pyatv resolving the model is what the rejection rests on, so a change in
    # its lookup table has to fail here rather than silently pass the HomePod.
    assert homepod["model"] == "HomePod Mini", f"model: {homepod['model']}"

    config = by_address["192.168.1.50"]
    assert config.identifier == "AA:BB:CC:DD:EE:FF", f"identifier: {config.identifier}"
    assert config.name == "Living Room", f"name: {config.name}"
    assert str(config.address) == "192.168.1.50", f"address: {config.address}"

    described = describe_config(config)
    assert described["is_apple_tv"], f"not recognised as an Apple TV: {described}"
    # The two protocols the integration pairs have to be there and to be
    # reported as needing a PIN: this is what the pairing action walks through,
    # and Companion is the one the single-service scan could never deliver.
    protocols = {service["protocol"] for service in described["services"]}
    assert {"AirPlay", "Companion"} <= protocols, f"protocols: {sorted(protocols)}"
    assert described["pairing_needed"] == ["AirPlay", "Companion"], (
        f"pairing_needed: {described['pairing_needed']}"
    )

    # Looked up by identifier (how `connect` finds it) and by address (how a
    # scan does), because those are the two entry points that must not fail.
    assert bridge._announced_configs(None, config.identifier) == [config]  # noqa: SLF001
    assert bridge._announced_configs(["192.168.1.50"], None) == [config]  # noqa: SLF001

    # An announcement with no address record cannot be rebuilt: pyatv needs
    # somewhere to connect. It must be dropped, not turned into a broken config.
    bridge.announced = {}
    assert asyncio.run(bridge.remember_announcements([dict(announcements[0], addresses=[])])) == []


def main() -> int:
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("PYATV_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s [pyatv-bridge] %(message)s",
    )
    # pyatv is chatty at DEBUG and its protocol logs leak credentials.
    logging.getLogger("pyatv").setLevel(
        os.environ.get("PYATV_LIB_LOG_LEVEL", "WARNING").upper()
    )

    storage_file = os.environ.get("PYATV_STORAGE_FILE", "/data/pyatv.json")
    if "--self-test" in sys.argv:
        # Used by the Docker build to prove the interpreter, pyatv and this file
        # all load in the final image — and to check the few assumptions this
        # file makes about pyatv internals, which no unit test can cover
        # (the CI has no pyatv, the image does).
        _self_test()
        print(json.dumps({"ok": True, "pyatv": pyatv.const.__version__}))
        return 0

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bridge = Bridge(storage_file, loop)
    try:
        loop.run_until_complete(bridge.run())
    except KeyboardInterrupt:
        loop.run_until_complete(bridge.shutdown())
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
