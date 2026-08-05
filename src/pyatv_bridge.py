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
from typing import Any, Dict, List, Optional

import pyatv
from pyatv import exceptions as pyatv_exceptions
from pyatv import interface
from pyatv.const import FeatureName, FeatureState, PowerState, Protocol
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

# Capability name reported to Node -> the pyatv feature that backs it. Node uses
# this to decide which Gladys features are worth publishing for a device: an
# Apple TV driven over HDMI-CEC has no readable volume level, publishing a
# volume slider for it would only produce a control that never works.
CAPABILITY_FEATURES = {
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

# Reconnection backoff, in seconds. An Apple TV unplugged for the evening must
# not be retried in a tight loop, and one that just rebooted must come back
# quickly.
RECONNECT_DELAYS = (2, 5, 10, 30, 60, 120, 300)

# A device answering its unicast mDNS query is enough to build a config: no need
# to wait for the full multicast window.
DEFAULT_SCAN_TIMEOUT = 5


def _feature_state(atv: interface.AppleTV, feature: FeatureName) -> FeatureState:
    try:
        return atv.features.get_feature(feature).state
    except Exception:  # noqa: BLE001 - a capability probe must never break a session
        return FeatureState.Unknown


def _enum_name(value: Any) -> Optional[str]:
    return value.name.lower() if value is not None and hasattr(value, "name") else None


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
        # An AirPlay scan also returns Macs, AirPlay speakers and smart TVs.
        # Only tvOS boxes are what this integration controls, and the OS is
        # readable before any pairing.
        "is_apple_tv": _enum_name(info.operating_system) == "tvos"
        or raw_model.startswith("AppleTV"),
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

    async def command(self, action: str, value: Any = None) -> Dict[str, Any]:
        atv = self._require_atv()

        if action in REMOTE_ACTIONS:
            await getattr(atv.remote_control, action)()
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

    async def scan_configs(
        self,
        hosts: Optional[List[str]] = None,
        identifier: Optional[str] = None,
        timeout: int = DEFAULT_SCAN_TIMEOUT,
    ) -> List[interface.BaseConfig]:
        """Unicast scan.

        The integration container sits on a Docker bridge network, where
        multicast never arrives: mDNS browsing is done by the Gladys core on the
        host and the addresses it finds are verified here, one unicast query per
        candidate. `hosts=None` (multicast) only works outside Docker, during
        development.
        """
        return await pyatv.scan(
            self.loop,
            timeout=timeout,
            hosts=hosts,
            identifier=identifier,
            storage=self.storage,
        )

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
        configs = await self.scan_configs(hosts=hosts, timeout=timeout)
        return {"devices": [describe_config(config) for config in configs]}

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
        # all load in the final image.
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
