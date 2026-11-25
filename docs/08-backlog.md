# 08. Backlog

Feature requests and investigations not yet scheduled. Newest first. Move an item to [03-roadmap.md](03-roadmap.md) when it is scheduled, and delete it here when it is done.

Status: `open` (not started), `blocked` (needs info), `doing`, `done`.

## Investigations

### I-1. Web: device chooser finds no devices

- **Status:** doing. Fixes for cause 1 are in (below); confirm on hardware after the computer sleeps mid-cook.
- **Opened:** 2026-11-24
- **Platform:** web (colbyapp.github.io), Chrome 158.0.8127.88, macOS 26.3

**Symptom:** The "Pair device" chooser kept searching and listed nothing. It worked before. The probe showed in the Combustion phone app and on the extender.

**Facts:**
- The `requestDevice` filter (`web/src/transport/webBluetooth.js`, manufacturer ID `0x09C7` or the Probe Status service) has not changed since the first commit. A Colby code change is not the cause.
- Mac Bluetooth was on. Chrome had the macOS Bluetooth permission. Restarting Chrome and turning Bluetooth off and on did not fix it.
- `chrome://bluetooth-internals` listed `00:57:36:27:81:11` at −42 dBm as **Connected**, with services `180a`, `fe59` and `6e400001` (UART). It had no Probe Status service, so it is likely the extender, not the probe. No Colby or Combustion app was running, so Chrome was likely holding the link.
- The Kitchen display (`41:70:96:40:BC:C2`, −91 dBm) was in range but did not show in the chooser either.

**Possible causes:**
1. A stale GATT connection held by Chrome (from an old Colby tab or the Inspect button), so macOS leaves the device out of new scans.
2. Chrome 158 changed how `manufacturerData` filters work, so nothing matches.

**To find out:** Forget the device in `chrome://bluetooth-internals`, close all Colby tabs and try again. If the chooser is still empty, compare a `manufacturerData`-only chooser with an `acceptAllDevices` chooser from the DevTools console.

**Fixes this leads to:** F-1 for cause 1, F-2 for both causes, F-3 for cause 2.

**Done (2026-11-25):**
- F-1: `pagehide` releases every device (`releaseDevice` in `web/src/transport/webBluetooth.js`). It fires only on close, reload or navigation, not on a tab switch, and the link ends with the page anyway, so it adds no connect cycles.
- F-2: when the chooser closes with nothing picked, a toast says to wake the probe, then Forget the device in `chrome://bluetooth-internals`.
- Reconnect after sleep: a heartbeat gap over 20 s counts as a wake; Colby releases stale links and reconnects at once. Each connect attempt has a 30 s deadline (only the GATT connect had one), and Retry gives up a hung attempt (it used to do nothing while "Connecting…"). A band over the top of the page shows which device, which try and the countdown, with Retry now; after 45 s it adds the `chrome://bluetooth-internals` hint.
- Before opening the chooser and before each connect, Colby drops the GATT link Chrome still reports for any device it has no live link to. A connect that times out is cancelled the same way.

**Findings (2026-11-25, 127.0.0.1 server, after the Mac slept):**
1. The chooser spun on "Scanning" with nothing listed. A first `chrome://bluetooth-internals` scan showed no device with
   the Probe Status service (`00000100-caab-…`); the strong "Unknown or Unsupported Device" entries had `1805`, `180a`,
   `180f` and two Apple Continuity services (`9fa480e0-…`, `d0611e78-…`): Apple devices, not the probe.
2. A later scan did show the probe: `B0:7B:1A:D7:83:C8`, −51 dBm, `00000100-caab-…`. The chooser still listed only the
   Display already connected (`00:57:36:27:81:11 – Paired`), not the probe. So the probe was in range and seen by Chrome,
   but did not match the chooser filter: cause 2 is back on the table. (bluetooth-internals may show services from an
   earlier GATT discovery, not from the advertisement.)
3. Later the same day (branch `worktree-web-i1-chooser`, stale links released before the chooser) the **filtered**
   chooser listed the probe: `[Colby] picked unnamed device (XcItg8E322jXRfMy7/SfgQ==) from the filtered chooser`. So
   the filter matches the probe, and cause 2 is unlikely. Findings 1 and 2 were most likely the probe not advertising
   (asleep, or not yet back after the Mac slept) or a link held from before; which one is not known.

**Next:** with the probe showing in bluetooth-internals, open an `acceptAllDevices` chooser from the DevTools console. If
it lists the probe, do F-3 as a "Show all devices" chooser (`acceptAllDevices` plus `optionalManufacturerData: [0x09C7]`);
a name-prefix filter cannot work, because the probe advertises no name.

**Still to check on hardware:** sleep the Mac 10+ minutes mid-cook, wake it, and see whether Colby reconnects by itself and whether the chooser lists the probe. If the chooser is still empty after the release, cause 2 is more likely: do F-3.

## Feature requests

### F-3. Web: fallback chooser filter

- **Status:** open (from I-1, do only if cause 2 is confirmed; finding 2 points to it)
- Offer a "Show all devices" chooser (`acceptAllDevices` with `optionalManufacturerData: [0x09C7]`) when the filtered one finds nothing, so a Chrome change to filter matching cannot hide every device. A name-prefix filter will not work: the probe advertises no name.
