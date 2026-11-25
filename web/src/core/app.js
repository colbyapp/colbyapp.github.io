// The app facade: devices and their links, routing, and the store → presenter / history / alerts pipeline.
// Web counterpart of CombustionApp.swift. No DOM here, so it runs under Node tests too.
//
// A device is something the user added: `{id, name, open(), identify(connection, isProbe)}`. `open` returns a GATT
// connection (transport/webBluetooth.js or transport/simulated.js). The app reconnects with backoff 1, 2, 4 ... 30 s
// until the device is removed.

import { Emitter, systemClock } from './support.js';
import { ProbeStore } from './probeStore.js';
import { PredictionPresenter } from './presenter.js';
import { HistoryStore, MemoryHistoryStorage } from './history.js';
import { Commands } from './commands.js';
import { AlertEngine, MemoryRuleStore } from './alerts.js';
import { DirectProbeLink, NodeLink } from './links.js';
import { GATT } from '../transport/gatt.js';
import { decodeAdvertisement } from '../codec/index.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/**
 * Most time one connect attempt (open, discover, identify, link start) may take. Only the GATT connect has a timeout of
 * its own; after the computer wakes, Chrome can leave service discovery or the first UART reply pending for good.
 */
export const CONNECT_DEADLINE_MS = 30_000;

/** The device has neither the Probe Status service nor the UART: not a Combustion device. */
class NotCombustion extends Error {
  constructor() {
    super('not a Combustion device');
    this.name = 'NotCombustion';
  }
}

class ConnectTimeout extends Error {
  constructor() {
    super('timed out');
    this.name = 'ConnectTimeout';
  }
}

export class ColbyApp extends Emitter {
  devices = new Map();
  /** Probes the user hid; they are not evaluated for alerts. */
  hidden = new Set();

  constructor({
    clock = systemClock, historyStorage = new MemoryHistoryStorage(), ruleStore = new MemoryRuleStore(), sinks = [],
    keepAwake = null, requestIds,
  } = {}) {
    super();
    this.clock = clock;
    this.requestIds = requestIds;
    this.store = new ProbeStore({ clock });
    this.presenter = new PredictionPresenter({ clock });
    this.history = new HistoryStore({ storage: historyStorage, clock, fetcher: (serial) => this.route(serial) });
    this.commands = new Commands({ store: this.store, route: (serial) => this.route(serial), clock });
    this.alerts = new AlertEngine({ clock, ruleStore, sinks, keepAwake, silencer: this.commands });

    this.store.on('status', (e) => {
      this.presenter.ingest(e);
      this.history.ingest(e).catch((err) => console.error('history', err));
    });
    this.store.on('probes', (map) => {
      this.alerts.ingestSnapshots(map);
      this.#syncFollowed();
      this.emit('probes', map);
    });
    this.store.on('nodes', (nodes) => this.emit('nodes', nodes));
    this.presenter.on('prediction', (v) => {
      this.alerts.ingestPrediction(v);
      this.emit('prediction', v);
    });
  }

  async start() {
    await this.history.load();
  }

  stop() {
    for (const d of [...this.devices.values()]) this.removeDevice(d.id);
    this.store.stop();
    this.presenter.stop();
    this.alerts.stop();
  }

  // MARK: Devices

  /** Adds a device and connects to it. Returns the device record. */
  addDevice({ id, name, open, identify = null, simulated = false }) {
    const existing = this.devices.get(id);
    if (existing) {
      if (existing.state === 'disconnected') this.#connect(existing);
      return existing;
    }
    const device = {
      id, name, open, identify, simulated, kind: null, serial: null, productType: null, link: null,
      state: 'connecting', error: null, attempt: 0, retryTimer: null, removed: false,
      /** When the device last stopped being connected (or was added); null while connected. */
      downSince: this.clock.now(),
      /** When the attempt now running began; null between attempts. */
      attemptStartedAt: null,
      /** Connect attempts since the device was last connected. */
      tries: 0,
      token: 0,
    };
    this.devices.set(id, device);
    this.#connect(device);
    return device;
  }

  removeDevice(id) {
    const d = this.devices.get(id);
    if (!d) return;
    d.removed = true;
    if (d.retryTimer != null) this.clock.clearTimeout(d.retryTimer);
    d.link?.close().catch(() => {});
    d.connection?.close?.().catch?.(() => {});
    this.devices.delete(id);
    if (d.kind === 'node') this.store.removeNode(d.serial);
    this.#emitDevices();
  }

  /**
   * Reconnects now instead of waiting for the backoff. An attempt that is still running is given up first: after the
   * computer wakes, one can hang, and Retry must not wait for it.
   */
  retry(id) {
    const d = this.devices.get(id);
    if (!d || d.link) return;
    if (d.retryTimer != null) this.clock.clearTimeout(d.retryTimer);
    d.retryTimer = null;
    if (d.attemptStartedAt != null) this.#abandonAttempt(d);
    d.attempt = 0;
    this.#connect(d);
  }

  /** Retries every device that has no link, e.g. after the computer wakes or the browser unfreezes the tab. */
  reconnectAll() {
    for (const d of this.devices.values()) if (!d.link && d.state !== 'disconnected' && d.state !== 'unsupported') this.retry(d.id);
  }

  #emitDevices() { this.emit('devices', [...this.devices.values()]); }

  /** Drops the attempt now running: later steps of it see a stale token and close what they opened. */
  #abandonAttempt(d) {
    d.token++;
    d.attemptStartedAt = null;
    const c = d.connection;
    d.connection = null;
    c?.close?.().catch?.(() => {});
  }

  async #connect(d) {
    const token = ++d.token;
    d.state = d.attempt ? 'reconnecting' : 'connecting';
    d.error = null;
    d.tries++;
    d.attemptStartedAt = this.clock.now();
    d.downSince ??= d.attemptStartedAt;
    this.#emitDevices();
    let connection;
    let deadline = null;
    const timedOut = new Promise((_, reject) => {
      deadline = this.clock.setTimeout(() => reject(new ConnectTimeout()), CONNECT_DEADLINE_MS);
    });
    timedOut.catch(() => {});
    // Each step races the deadline. A step that loses keeps running; `stale()` makes its result be thrown away.
    const step = (p) => Promise.race([p, timedOut]);
    const stale = () => d.removed || d.token !== token;
    try {
      connection = await step(d.open());
      if (stale()) {
        await connection.close();
        return;
      }
      d.connection = connection;
      const chars = await step(connection.discover());
      const isProbe = chars.has(GATT.probeStatus);
      // Picked from the unfiltered chooser, it may be any Bluetooth device. Retrying would never help.
      if (!isProbe && !chars.has(GATT.uartRX)) throw new NotCombustion();
      const ident = (await step(Promise.resolve(d.identify?.(connection, isProbe)))) ?? {};
      if (stale()) return;
      d.kind = isProbe ? 'probe' : 'node';
      d.serial = ident.serial ?? d.serial ?? connection.id;
      d.productType = ident.productType ?? d.productType ?? (isProbe ? null : 'display');
      const options = { clock: this.clock, requestIds: this.requestIds };
      const link = isProbe
        ? new DirectProbeLink(d.serial, connection, options)
        : new NodeLink(d.serial, d.productType, connection, options);
      link.on('observation', (o) => this.store.ingest(o));
      link.on('node', (n) => this.store.ingestNode(n));
      link.on('disconnected', (reason) => this.#lost(d, link, reason));
      const started = link.start();
      try {
        await step(started);
      } catch (e) {
        if (e instanceof ConnectTimeout) started.then(() => link.close(), () => {});
        throw e;
      }
      if (stale()) {
        await link.close();
        return;
      }
      d.link = link;
      d.state = 'connected';
      d.attempt = 0;
      d.tries = 0;
      d.downSince = null;
      d.attemptStartedAt = null;
      this.#emitDevices();
      if (isProbe) this.history.resume(d.serial);
    } catch (e) {
      if (stale()) {
        connection?.close?.().catch?.(() => {});
        return;
      }
      d.error = e?.message ?? String(e);
      console.warn(`[Colby] connect try ${d.tries} to ${d.name} (${d.id}) failed:`, e);
      d.attemptStartedAt = null;
      d.connection = null;
      connection?.close?.().catch?.(() => {});
      if (e instanceof NotCombustion) {
        d.state = 'unsupported';
        this.#emitDevices();
        return;
      }
      this.#scheduleRetry(d);
    } finally {
      this.clock.clearTimeout(deadline);
    }
  }

  #lost(d, link, reason) {
    if (d.link !== link) return;
    d.link = null;
    if (d.removed) return;
    d.downSince = this.clock.now();
    if (reason === 'requested') {
      d.state = 'disconnected';
      this.#emitDevices();
      return;
    }
    this.#scheduleRetry(d);
  }

  #scheduleRetry(d) {
    if (d.removed) return;
    const delay = BACKOFF_MS[Math.min(d.attempt, BACKOFF_MS.length - 1)];
    d.attempt++;
    d.state = 'reconnecting';
    d.nextRetryAt = this.clock.now() + delay;
    this.#emitDevices();
    d.retryTimer = this.clock.setTimeout(() => {
      d.retryTimer = null;
      if (!d.removed && !d.link) this.#connect(d);
    }, delay);
  }

  // MARK: Routing

  /** The link that can carry requests for a probe: a direct link, else the node link with the fewest hops. */
  route(serial) {
    let best = null;
    let bestHops = Infinity;
    for (const d of this.devices.values()) {
      const link = d.link;
      if (!link || !link.covers(serial)) continue;
      if (link.kind === 'probe') return link;
      const hops = link.snapshot.hopCounts[serial] ?? 4;
      if (hops < bestHops) {
        best = link;
        bestHops = hops;
      }
    }
    return best;
  }

  // MARK: Advertisements (flagged scan API)

  /** Feeds one advertisement (`mfrData` with the vendor ID first). */
  ingestAdvertisement({ mfrData, rssi = null }) {
    let packet;
    try {
      packet = decodeAdvertisement(mfrData);
    } catch {
      return;
    }
    const now = this.clock.now();
    // Serial 0: a node with no probe in that slot yet (a Display right after power-on repeats all-zero packets).
    if ((packet.kind === 'probe' || packet.kind === 'repeated') && packet.serial === '00000000') return;
    if (packet.kind === 'probe' || packet.kind === 'repeated') {
      const { kind, hopCount, ...advertisement } = packet;
      this.store.ingest({
        serial: packet.serial,
        source: kind === 'probe'
          ? { kind: 'advertisement', rssi, highRadioPower: packet.preferences?.highRadioPower ?? null, lastSeen: now }
          : { kind: 'nodeAdvertisement', hopCount, rssi, lastSeen: now },
        payload: { advertisement },
        receivedAt: now,
      });
    } else if (packet.kind === 'node') {
      this.store.ingestNodeSighting({ serial: packet.serial, productType: packet.nodeProductType, rssi, time: now });
    }
  }

  // MARK: Probes

  setHidden(serial, hidden) {
    if (hidden) this.hidden.add(serial);
    else this.hidden.delete(serial);
    this.#syncFollowed();
  }

  #followedKey = '';

  #syncFollowed() {
    const followed = [...this.store.mergers.keys()].filter((s) => !this.hidden.has(s)).sort();
    const key = followed.join(',');
    if (key === this.#followedKey) return;
    this.#followedKey = key;
    this.alerts.setFollowed(followed);
  }
}
