// Telling which probe a direct Web Bluetooth connection is. Without Chrome's experimental flag the page cannot read
// advertisements, and the Serial Number characteristic (0x2A25) is on the Web Bluetooth GATT blocklist, so a direct
// probe first gets a stand-in serial (webBluetooth.pseudoSerial). The probe's session ID (new each time it leaves the
// charger) is also reported, with the real serial, by any node that relays the probe; a match tells the real serial.

/**
 * The real serial of the probe known as `standIn`: the one serial in `candidates` whose current cook has the same
 * non-zero session ID. Null when the stand-in has no session ID yet, or when none or several match.
 */
export function realSerialFor(standIn, candidates, sessionIdOf) {
  const sid = sessionIdOf(standIn);
  if (!sid) return null;
  const matches = candidates.filter((s) => s !== standIn && sessionIdOf(s) === sid);
  return matches.length === 1 ? matches[0] : null;
}
