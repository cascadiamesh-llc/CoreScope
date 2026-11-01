# Connecting Your Observer to the CascadiaMesh Analyzer

The CascadiaMesh analyzer ([analyzer.cascadiamesh.org](https://analyzer.cascadiamesh.org)) shows
the main mesh and **MediaMesh**, the second, faster channel that carries photos and voice. A test
copy runs at [mediamesh-test.cascadiamesh.org](https://mediamesh-test.cascadiamesh.org).

Any observer can send the main mesh. To also show MediaMesh traffic, and to mark your repeater as a
MediaMesh repeater on the map, the observer has to be a **Keymind Cascade repeater with MediaMesh
turned on**, reporting through its built-in MQTT or through the CascadiaMesh version of MCtoMQTT.

## Broker settings

Nearly identical to LetsMesh US. Only the **host** and **audience** differ.

| Setting   | LetsMesh US               | CascadiaMesh               |
|-----------|---------------------------|----------------------------|
| Host      | `mqtt-us-v1.letsmesh.net` | `mqtt-v1.cascadiamesh.org` |
| Audience  | `mqtt-us-v1.letsmesh.net` | `mqtt-v1.cascadiamesh.org` |
| Port      | `443`                     | `443`                      |
| Transport | `websockets`              | `websockets`               |
| TLS       | `true`                    | `true`                     |
| Auth      | Token (JWT)               | Token (JWT)                |

## Which setup do I have?

| Your observer | Main mesh | MediaMesh | What to do |
|---|---|---|---|
| **Keymind Cascade repeater with built-in MQTT** (ESP32 on WiFi) | ✅ | ✅ | [Turn on MediaMesh](#1-turn-on-mediamesh-on-the-repeater), then [Option A](#option-a-built-in-mqtt-keymind-cascade) |
| **Repeater on USB + MCtoMQTT** (Raspberry Pi etc.) | ✅ | ✅ with the CascadiaMesh MCtoMQTT | [Turn on MediaMesh](#1-turn-on-mediamesh-on-the-repeater), then [Option B](#option-b-mctomqtt) |
| **Companion + meshcore-packet-capture** | ✅ | Arrives, but not labelled MediaMesh | [Option C](#option-c-meshcore-packet-capture) |
| **OpenHop** | ✅ | Coming soon | [Option D](#option-d-openhop) |

Why companions can't label MediaMesh: a companion radio doesn't tell the app which radio heard a
packet, so there's nothing for the capture software to pass on. For MediaMesh, use a repeater.

---

## 1. Turn on MediaMesh on the repeater

*For options A and B.*

1. Flash **Keymind Cascade newer than v1.18.0.1** (built on or after Oct 29, 2026). v1.18.0.1 can
   run MediaMesh, but it doesn't yet tell observers which packets were MediaMesh. Use the
   [MediaMesh Flasher](https://cascadiamesh.org/mediamesh-flasher/) (Keymind Cascade tab).
2. In the repeater's CLI (USB console or remote admin login):
   ```
   set radio2 mediamesh
   ```
3. Check it's on:
   ```
   get radio2
   ```
   You should see `911.150,250.000,7,5,rxtx,…`.

The repeater keeps repeating the main mesh exactly as before. It shares one radio between the two
channels, so it spends a little time listening to MediaMesh instead of the main mesh.

---

## Option A: Built-in MQTT (Keymind Cascade)

Keymind Cascade ships a `cascadiamesh` broker preset. Put it in a free slot (slots 1 and 2 are
LetsMesh US and EU by default):

```
get mqtt3.preset
set mqtt3.preset cascadiamesh
set mqtt.enabled on
reboot
```

If slot 3 is already in use, use `mqtt4` (up to `mqtt6`). After the reboot, check that it connected:

```
get mqtt.status
```

**That's all for MediaMesh.** The firmware tags MediaMesh packets and reports its MediaMesh setting
by itself.

Haven't set up MQTT on this repeater yet (WiFi, region code)? Follow Keymind Cascade's
[MQTT quick start](https://github.com/mikecarper/MeshCore/blob/keymindCascade/MQTT_IMPLEMENTATION.md#quick-start-guide)
first. In short: `set wifi.ssid …`, `set wifi.pwd …`, `set mqtt.iata SEA` (your region), then the
commands above.

---

## Option B: MCtoMQTT

MediaMesh needs the **CascadiaMesh version of MCtoMQTT**. It's the regular
[meshcoretomqtt](https://github.com/Cisien/meshcoretomqtt) plus MediaMesh support. On a repeater
without MediaMesh it behaves exactly like the regular one.

### New install

```bash
curl -fsSL https://raw.githubusercontent.com/cascadiamesh-llc/meshcoretomqtt/mediamesh/install.sh | \
  sudo bash -s -- --repo cascadiamesh-llc/meshcoretomqtt --branch mediamesh
```

The installer walks you through brokers. Add the CascadiaMesh broker there, or afterwards as shown
[below](#add-the-cascadiamesh-broker). Future updates come from the CascadiaMesh version
automatically.

### Switching an existing install

1. Open your user config file, `/etc/mctomqtt/config.d/99-user.toml` (older installs:
   `00-user.toml`), and point updates at the CascadiaMesh version. If the file already has an
   `[update]` section, **change those two lines**. Don't add a second `[update]`, or the config won't load.
   ```toml
   [update]
   repo = "cascadiamesh-llc/meshcoretomqtt"
   branch = "mediamesh"
   ```
2. Update:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cascadiamesh-llc/meshcoretomqtt/mediamesh/scripts/update.sh | sudo bash
   ```

From now on, the normal update command keeps you on the CascadiaMesh version.

### Add the CascadiaMesh broker

In the same user config file, add a `[[broker]]` block. Don't edit `/etc/mctomqtt/config.toml`
directly, because updates overwrite it.

```toml
[[broker]]
name = "cascadiamesh"
enabled = true
server = "mqtt-v1.cascadiamesh.org"
port = 443
transport = "websockets"

[broker.tls]
enabled = true

[broker.auth]
method = "token"
audience = "mqtt-v1.cascadiamesh.org"
```

Then restart:

```bash
sudo systemctl restart mctomqtt
```

With MediaMesh on, the log shows a line like
`Second radio profile (radio2): {'radio': '911.150,250.000,7,5', 'mode': 'rxtx', …}` at startup.

---

## Option C: meshcore-packet-capture

Edit `.env.local` in your installation directory (default `~/.meshcore-packet-capture/.env.local`)
and add the CascadiaMesh broker on the next free slot (MQTT2, MQTT3 or MQTT4). For example, if
MQTT2 is LetsMesh US and MQTT3 is free:

```bash
# CascadiaMesh Broker
PACKETCAPTURE_MQTT3_ENABLED=true
PACKETCAPTURE_MQTT3_SERVER=mqtt-v1.cascadiamesh.org
PACKETCAPTURE_MQTT3_PORT=443
PACKETCAPTURE_MQTT3_TRANSPORT=websockets
PACKETCAPTURE_MQTT3_USE_TLS=true
PACKETCAPTURE_MQTT3_USE_AUTH_TOKEN=true
PACKETCAPTURE_MQTT3_TOKEN_AUDIENCE=mqtt-v1.cascadiamesh.org
```

Restart:

```bash
sudo systemctl restart meshcore-capture
```

This sends the main mesh. If your companion also listens on MediaMesh, those packets arrive too,
but they show as ordinary main-mesh traffic.

---

## Option D: OpenHop

Connect OpenHop to the CascadiaMesh broker the same way you connect it to other analyzers, using
the host and audience above. MediaMesh support for OpenHop is in progress with Ceres. Until it
lands, OpenHop observers send the main mesh.

---

## Checking it works

Watch the logs for a successful MQTT connection to `mqtt-v1.cascadiamesh.org`:

```bash
sudo journalctl -u mctomqtt -f            # MCtoMQTT
sudo journalctl -u meshcore-capture -f    # meshcore-packet-capture
```

On a Keymind Cascade repeater with built-in MQTT: `get mqtt.status`.

Then open the analyzer and find your observer on the **Observers** page. Once MediaMesh traffic
passes through your repeater:

- **Live** draws MediaMesh packets as hollow rings.
- **Map** and **Nodes** mark your repeater as a MediaMesh repeater.

Questions? Ask on the CascadiaMesh Discord or email cascadiamesh@gmail.com.
