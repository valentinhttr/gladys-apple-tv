# Apple TV

Control your Apple TV from Gladys Assistant: power, remote, playback, volume and
applications. The integration talks to your Apple TV directly on your local
network, using [pyatv](https://pyatv.dev) — the reference implementation of
Apple's AirPlay and Companion protocols, and the same library Home Assistant
uses. Nothing goes through Apple's servers, and no Apple ID is required.

## Requirements

- An Apple TV (HD, 4K, any generation running tvOS 15 or later).
- The Apple TV and your Gladys server on the **same network**. If they are on
  different VLANs or subnets, see "Different subnets" below.
- Physical access to the television during pairing: Apple displays a code on the
  screen that you have to read and type into Gladys.

## Setting it up

### 1. Find your Apple TV

Open the **Discovery** tab of the integration and run a scan. Gladys listens for
the AirPlay announcements on your network, and the integration checks every
candidate address directly with pyatv. Your Apple TV appears with its name and
its model.

Click **Add** to create the device in Gladys. An Apple TV is usually named after
the room it sits in ("Living room"), so the device is created as "Apple TV
Living room" — clear in a device list, and it is also what makes its selector
readable in scenes. You can rename it afterwards in the Devices tab.

### 2. Pair it

Pairing is what authorizes Gladys to control the device. It happens in the
**Configuration** tab, with the first two buttons:

1. **Pair an Apple TV** — type the IP address of your Apple TV, or its name if
   you already added it. Leave the field empty if you have only one. A code
   appears on your television.
2. **Enter the code** — type the code you see on screen.

You can pair before adding the device: the IP address is enough.

Apple asks for one code **per protocol**: after the first code is accepted, a
second one appears on the television. Two codes is normal.

The second code goes in **the same field as the first one**. The form keeps
what you typed, so you have to **clear the field and type the new code in its
place**, then press the button again. Pressing it a second time without
clearing does nothing useful — the integration recognizes the old code and says
so rather than wasting the new one.

Codes expire fast, and the connection carrying them closes on its own after a
short while. If that happens, the integration says so and immediately puts a
**new code** on your television: read the message, clear the field, enter the
new code, and carry on. There is no need to start over from step 1.

Once pairing is complete, run a scan again (or accept the **Update** that Gladys
offers in the Discovery tab): the integration now knows what your Apple TV can
actually do, and adds the volume control and the application shortcuts.

### 3. Use it

The device exposes:

- **Power** — on/off. "Off" means standby, in Apple's sense: the box stays on the
  network, the screen and the HDMI output go away.
- **Remote** — directional pad, OK, Back, Home, Control Center.
- **Playback** — play, pause, stop, previous, next, rewind, fast forward.
- **Volume** — a slider, plus volume up/down buttons. The slider only appears
  when your setup exposes a readable volume level. An Apple TV controlling a
  soundbar over HDMI-CEC usually only supports the up/down buttons.
- **Now playing** and **Application** — text sensors showing what is on screen.
- **Application shortcuts** — one button per installed application, so a scene
  can open Netflix or Disney+ directly. Disable them, or lower the maximum, in
  the configuration.

### On a dashboard

Two boxes, two ways to use the same Apple TV:

- **Devices in a room** — every remote key is a real button you can press:
  the directional pad, OK, Back, Home, Control Center, play, pause, the
  transport keys, the volume slider and the application shortcuts. This is the
  remote.
- **Music box** — the transport bar of a media player. Add the Apple TV to it
  and drive it like a Sonos.

The device list shows both sets, which is why some keys appear twice: the ones
prefixed with "Media" are what the Music box uses, the short ones are the remote
buttons. Each box only offers the features it can actually use, so you never
have to choose between them.

## Configuration

| Setting                     | What it does                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Discovery duration          | How long Gladys listens for AirPlay announcements. Increase it on a busy or slow network.                                 |
| Manual IPv4 addresses       | Only needed when announcements do not reach Gladys (routed networks, VLANs). Added to the automatic discovery.            |
| Refresh interval            | How often the integration reconciles what the Apple TV does not push by itself, typically the power state on some models. |
| Application shortcuts       | Whether to expose one button per installed application.                                                                   |
| Maximum number of shortcuts | An Apple TV can have a hundred applications; this bound keeps the device readable.                                        |

## Other actions

- **Reconnect and refresh** — reopen the session and read the device again. The
  first thing to try when something looks stale.
- **List the installed applications** — shows the bundle identifier of every
  application, which is what "Launch an application" expects.
- **Launch an application** — opens an application by bundle identifier, e.g.
  `com.netflix.Netflix`.
- **Play a URL** — sends a video URL or a deep link to the Apple TV over AirPlay.
- **Delete the pairing** — forgets the stored credentials. Use it when pairing
  has to be redone, for example after a factory reset of the Apple TV.

## Troubleshooting

**The scan finds nothing.** Gladys captures AirPlay announcements from the host
network. Check that your Apple TV is powered on, that AirPlay is enabled
(Settings → AirPlay and HomeKit), and that Gladys is on the same network. If your
Gladys server is on a different subnet, fill in the manual IPv4 address.

The integration log names what it saw: if it reports announcements that
"carried no IPv4 address", your Apple TV _was_ announced but its address never
reached Gladys — go straight to the manual address.

**You run Gladys in Docker on a Mac or on Windows.** Discovery cannot work
there, and it is not a misconfiguration on your side. Docker Desktop, OrbStack
and Colima run containers inside a Linux virtual machine, so `network_mode:
host` means _the virtual machine's_ network, not your Wi-Fi. Multicast from
your Apple TV never reaches Gladys. Unicast does, so everything else works:
put the IP address of your Apple TV in "Manual IPv4 addresses" and the
integration discovers, pairs and controls it normally. A Gladys running on
Linux (Raspberry Pi, NAS, server) is on the network for real and does not need
this.

**Every command fails with "not paired yet".** The device was added but never
paired. Run the two pairing buttons in the Configuration tab.

**Pairing fails or the code is refused.** The code expires quickly — start again
and enter it right away. If it keeps failing, remove Gladys from the Apple TV
(Settings → General → AirPlay and HomeKit → Allow Access), run "Delete the
pairing" in Gladys, then pair again.

**The device shows as unreachable.** Check that the Apple TV is powered on and
still has the same IP address. A scan refreshes the address the integration uses;
a static lease on your router avoids the problem entirely.

**There is no volume slider.** Your setup does not expose a readable volume
level — a common case with HDMI-CEC. Use the volume up and volume down buttons
instead.

**Different subnets.** mDNS announcements do not cross subnets. Fill in the IPv4
address of each Apple TV in "Manual IPv4 addresses"; the integration queries them
directly, which works as long as the traffic is routed.

## Privacy and storage

The pairing credentials are stored in the integration's own writable volume
(`/data/pyatv.json`), never in the Gladys configuration, and never leave your
network. Deleting the integration deletes them with it.
