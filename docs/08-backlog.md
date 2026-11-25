# 08. Backlog

Feature requests and investigations not yet scheduled. Newest first. Move an item to [03-roadmap.md](03-roadmap.md) when it is scheduled, and delete it here when it is done.

Status: `open` (not started), `blocked` (needs info), `doing`, `done`.

## Investigations

### I-1. Web: device chooser finds no devices

- **Status:** blocked. Need to know which step fixed it.
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

## Feature requests

### F-1. Web: disconnect when the page goes away

- **Status:** open (from I-1)
- On `pagehide`, call `disconnect()` (`web/src/transport/webBluetooth.js`) for every connected device, so closing, reloading or unloading the tab releases the device. At this time nothing calls it on unload.

### F-2. Web: hint when the chooser closes with no device picked

- **Status:** open (from I-1)
- On `NotFoundError` (`web/src/ui/main.js`, `requestDevice` catch), show: "Device not listed? Open `chrome://bluetooth-internals`, Forget the Combustion device, and try again." At this time this case is silent.

### F-3. Web: fallback chooser filter

- **Status:** open (from I-1, do only if cause 2 is confirmed)
- Add a name-prefix filter next to the `manufacturerData` filter, so a Chrome change to manufacturer-data matching cannot hide every device. First confirm the advertised names of the probe, Display and Booster from captures.
