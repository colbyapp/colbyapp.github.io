// Colby web UI: wires the core (src/core) to the page. Everything runs in the browser; nothing is sent anywhere.

import { ColbyApp } from '../core/app.js';
import { IndexedDbHistoryStorage, prefs, prefsRuleStore } from '../core/storage.js';
import { soundOf, soundLoops } from '../core/alerts.js';
import { CommandError } from '../core/commands.js';
import * as ble from '../transport/webBluetooth.js';
import { GATT } from '../transport/gatt.js';
import { SimProbe, SimNodeConnection, cookCurve } from '../transport/simulated.js';
import { ALARM_CHANNELS, MAX_PREDICTION_SETPOINT, SENSORS, cString } from '../codec/index.js';
import { Graph, seriesId } from './graph.js';
import * as fmt from './format.js';
import { kitchenGrid } from './kitchenLayout.js';
import { NotificationSink, SoundSink, ScreenWakeLock } from './platform.js';
import { startHeartbeat, watchLifecycle, guardUnload, TitleFlasher } from './background.js';
import { Onboarding, appStoreButton, bluetoothStatus, BROWSER_SUPPORT, CHOOSER_HINT, mobilePlatform, notifyTroubleshooting, unsupportedBrowser } from './onboarding.js';
import { PumpedClock } from '../core/support.js';
import { realSerialFor } from '../core/identity.js';
import { isCooking } from '../core/alerts.js';

const $ = (id) => document.getElementById(id);
const esc = fmt.escapeHtml;
const HOUR = 3_600_000;

const defaultUnit = () => (/^en-(US|LR|MM)|^en$/.test(navigator.language) ? 'F' : 'C');

const state = {
  unit: prefs.get('unit', defaultUnit()),
  primaryTime: prefs.get('primaryTime', 'relative'),
  /** Graph lines turned off from the sensor tiles: 't0'…'t7'. */
  hiddenLines: new Set(prefs.get('hiddenLines', []).filter((k) => /^t[0-7]$/.test(k))),
  names: prefs.get('names', {}),
  selected: null,
  scrub: null,
  viewSession: null,
  samples: [],
  active: [],
  scanStop: null,
  kitchen: false,
  /** Set when the computer woke or the tab unfroze, until every device is back: `{reason: 'wake'|'resume', at}`. */
  wake: null,
  /** Which dialog is open, for the ones that redraw when devices change. */
  dialog: null,
};

/** Probes heard only by advertisement have no log; their graph is built from live values here. */
const liveSeries = new Map();

// MARK: App setup

const sound = new SoundSink(soundOf, soundLoops);
sound.enabled = prefs.get('sound', true);
const wake = new ScreenWakeLock();
wake.enabled = prefs.get('keepAwake', true);
wake.onChange = () => invalidate();
const notifications = new NotificationSink({
  unit: () => state.unit, nameOf: (s) => probeName(s), loops: (source) => soundLoops(soundOf(source)),
});

// The app clock is pumped by a worker heartbeat, so its timers (offline after 60 s, snooze, UART timeouts) keep time in
// a background tab, where Chrome batches main-thread timers to once a minute (ui/background.js).
const clock = new PumpedClock();
const titleFlasher = new TitleFlasher();
/** A heartbeat gap this long means the computer slept (or the tab was frozen); Bluetooth links did not survive it. */
const WAKE_GAP_MS = 20_000;
let lastBeat = Date.now();
const heartbeat = startHeartbeat(() => {
  const now = Date.now();
  const gap = now - lastBeat;
  lastBeat = now;
  clock.pump();
  try {
    if (gap > WAKE_GAP_MS) onWake('wake');
    renderReconnectBand();
  } catch {
    /* the heartbeat can tick before `app` exists (top-level await during startup) */
  }
  const a = state.active.find((x) => x.state === 'firing');
  titleFlasher.tick(a ? `${probeName(a.serial)}: ${fmt.describeAlert(a, state.unit).title}` : null, tabTitle());
});

const app = new ColbyApp({
  clock,
  historyStorage: await IndexedDbHistoryStorage.open(),
  ruleStore: prefsRuleStore,
  sinks: [notifications, sound],
  keepAwake: wake,
});
globalThis.colby = app; // for the console

app.on('probes', (map) => {
  recordLive(map);
  if (!state.selected || !map.has(state.selected)) state.selected = sortedProbes()[0]?.serial ?? null;
  invalidate();
});
app.on('prediction', () => invalidate());
app.on('devices', (devices) => {
  announceIdentified(devices);
  // A direct probe's first session can start while its link is still starting, before `d.link` is set, so the match
  // on 'sessions' skips it; try again when devices change (e.g. it becomes connected).
  resolveStandIns();
  // Keep the Devices dialog's states current; it used to show "Connecting…" until reopened.
  if (dialog.open && state.dialog === 'devices') devicesDialog();
  renderReconnectBand();
  invalidate();
});
app.on('nodes', () => invalidate());
app.alerts.on('active', (list) => {
  state.active = list;
  invalidate();
});
app.history.on('samples', ({ serial }) => {
  if (serial === state.selected && !state.viewSession) reloadSamples();
});
app.history.on('sessions', () => {
  resolveStandIns();
  if (!state.viewSession) reloadSamples();
});

const graph = new Graph($('graph'), (sample) => {
  state.scrub = sample;
  renderReadouts();
  renderGraphLabel();
});

await app.start();

// Any click unlocks audio (browsers block sound until a user gesture).
document.addEventListener('pointerdown', () => sound.unlock(), { capture: true });

// MARK: Helpers

function sortedProbes() {
  return [...app.store.snapshots().values()]
    .filter((p) => !app.hidden.has(p.serial))
    .sort((a, b) => a.probeNumber - b.probeNumber || a.serial.localeCompare(b.serial));
}

/**
 * Tab title: the selected probe's progress and time to ready, e.g. `62% · 2:13 · Colby`. When the selected probe has
 * nothing to show, the soonest other countdown, else a ready probe, else a warming one.
 */
function tabTitle() {
  let status = null;
  try {
    const views = sortedProbes().map((p) => ({ p, view: p.isOffline ? null : app.presenter.view(p.serial) }))
      .map((x) => ({ ...x, text: fmt.titleStatus(x.view, state.primaryTime) }))
      .filter((x) => x.text);
    const rank = ({ view }) => view.state === 'predicting' ? view.secondsRemaining
      : view.state === 'removalPredictionDone' ? 1e9 : 2e9;
    status = (views.find((x) => x.p.serial === state.selected) ?? views.sort((a, b) => rank(a) - rank(b))[0])?.text ?? null;
  } catch {
    /* the heartbeat can tick before `app` exists (top-level await during startup) */
  }
  return status ? `${status} · Colby` : 'Colby';
}

function probeName(serial) {
  const snap = app.store.snapshot(serial);
  return state.names[serial] || (snap ? `Probe ${snap.probeNumber}` : serial);
}

function badge(snap, small = false) {
  const grey = snap?.color === 'grey' ? ' grey' : '';
  return `<span class="badge${grey}${small ? ' small' : ''}" aria-label="Probe ${snap?.probeNumber ?? ''}">${snap?.probeNumber ?? '?'}</span>`;
}

function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function recordLive(map) {
  const now = Date.now();
  for (const [serial, s] of map) {
    if (s.isOffline || s.temperatures.some((t) => t == null)) continue;
    const series = liveSeries.get(serial) ?? [];
    if (series.length && now - series.at(-1).time < 5000) continue;
    const vs = [s.virtual.coreSensor, s.virtual.surfaceSensor, s.virtual.ambientSensor].map((x) => SENSORS.indexOf(x));
    series.push({ time: now, temps: s.temperatures, vs });
    if (series.length > 20_000) series.shift();
    liveSeries.set(serial, series);
  }
}

let renderQueued = false;
function invalidate() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

async function reloadSamples() {
  const key = state.viewSession ?? app.history.currentSession(state.selected)?.key;
  const samples = key ? await app.history.samples(key) : [];
  state.samples = samples.length ? samples : liveSeries.get(state.selected) ?? [];
  updateGraph();
}

// MARK: Rendering

function render() {
  renderToolbar();
  renderAlertBand();
  const probes = sortedProbes();
  const showProbe = state.viewSession || (state.selected && probes.length);
  $('empty').hidden = !!showProbe;
  $('probe-view').hidden = !showProbe;
  if (!showProbe) renderEmpty();
  else {
    renderHeader();
    renderReadouts();
    renderGraphLabel();
    renderChips(probes);
    renderInspector();
    updateGraph();
  }
  if (state.kitchen) renderKitchen(probes);
}

function renderToolbar() {
  const firing = state.active.filter((a) => a.state === 'firing').length;
  $('alerts-button').hidden = state.active.length === 0;
  $('alerts-button').classList.toggle('alerting', firing > 0);
  $('alert-count').textContent = String(state.active.length);
}

function renderAlertBand() {
  const band = $('alert-band');
  const top = state.active[0];
  if (!top || top.state === 'acknowledged' && state.active.every((a) => a.state === 'acknowledged')) {
    band.hidden = true;
    return;
  }
  const a = state.active.find((x) => x.state !== 'acknowledged') ?? top;
  const { title, detail } = fmt.describeAlert(a, state.unit);
  const snap = app.store.snapshot(a.serial);
  const more = state.active.filter((x) => x.state !== 'acknowledged').length - 1;
  band.hidden = false;
  band.classList.toggle('acknowledged', a.state !== 'firing');
  band.innerHTML = `${badge(snap, true)}<div class="grow">${esc(probeName(a.serial))}: ${esc(title)}
    <span class="detail">${esc(detail)}${a.state === 'snoozed' ? ` Snoozed until ${fmt.clock(a.snoozedUntil)}.` : ''}${more > 0 ? ` +${more} more` : ''}</span></div>
    <button data-ack="${esc(a.id)}">Acknowledge</button>
    ${a.state === 'firing' ? `<button class="secondary" data-snooze="${esc(a.id)}">Snooze 5 min</button>` : ''}`;
}

/** After this long without a connection, the band adds what to do if Chrome is holding the device (backlog I-1). */
const STILL_TRYING_MS = 45_000;

/**
 * Band over the top of the page while a real device connects or reconnects, so a reconnect after sleep does not look
 * stuck: which device, which try, how long this try has run or when the next starts, and Retry now. It is a manual
 * popover so it also shows above an open dialog (raised again in openDialog). Updated every heartbeat; the parts are
 * built once so the buttons keep focus and hover.
 */
function renderReconnectBand() {
  const band = $('reconnect-band');
  const down = [...app.devices.values()].filter((d) => !d.simulated && (d.state === 'connecting' || d.state === 'reconnecting'));
  if (!down.length) {
    state.wake = null;
    setBandShown(band, false);
    return;
  }
  if (!band.firstChild) {
    band.innerHTML = `<span class="spinner" aria-hidden="true"></span>
      <div class="grow"><div class="title"></div><div class="detail"></div><div class="hint"></div></div>
      <button data-band="retry">Retry now</button><button class="secondary" data-band="devices">Devices</button>`;
  }
  const now = clock.now();
  const d = down.find((x) => x.attemptStartedAt != null) ?? down[0];
  const verb = down.some((x) => x.kind) ? 'Reconnecting to' : 'Connecting to';
  const who = down.length === 1 ? deviceLabel(d) : `${down.length} devices`;
  const why = state.wake?.reason === 'wake' ? 'Computer woke up. ' : state.wake?.reason === 'resume' ? 'Colby was paused. ' : '';
  const secs = (ms) => Math.max(0, Math.round(ms / 1000));
  const detail = d.attemptStartedAt != null
    ? `Try ${d.tries} · waiting for the device ${secs(now - d.attemptStartedAt)} s`
    : `Try ${d.tries} failed${d.error ? ` (${d.error})` : ''} · next try in ${secs((d.nextRetryAt ?? now) - now)} s`;
  const longest = Math.max(...down.map((x) => now - (x.downSince ?? now)));
  band.querySelector('.title').textContent = `${why}${verb} ${who.replace(/ \(identifying…\)$/, '')}…`;
  band.querySelector('.detail').textContent = detail;
  const hint = band.querySelector('.hint');
  hint.hidden = longest < STILL_TRYING_MS;
  hint.textContent = `Not back after ${fmt.duration(longest)}. Make sure the device is awake and in range. If Chrome is holding an old link, `
    + 'open chrome://bluetooth-internals, click Forget on the device, then use Devices ▸ Connect a device.';
  setBandShown(band, true);
}

const popovers = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

function setBandShown(band, shown) {
  band.hidden = !shown;
  if (!popovers) return;
  const open = band.matches(':popover-open');
  if (shown && !open) band.showPopover();
  else if (!shown && open) band.hidePopover();
}

$('reconnect-band').addEventListener('click', (e) => {
  const b = e.target.closest('[data-band]');
  if (!b) return;
  if (b.dataset.band === 'retry') {
    releaseStaleLinks();
    app.reconnectAll();
  } else devicesDialog();
});

function renderEmpty() {
  const caps = ble.capabilities();
  const devices = [...app.devices.values()];
  const remembered = prefs.get('devices', []).filter((d) => !app.devices.has(d.id));
  const mobile = mobilePlatform();
  const handoff = mobile ? `<div class="app-handoff"><p>Colby is built for desktop computers only. If you're on a mobile device, use the official Combustion app.</p>${appStoreButton(mobile)}</div>` : '';
  const unsupported = !caps.bluetooth
    ? `<p class="warn">${caps.secureContext ? `${esc(unsupportedBrowser() ?? 'This browser')} isn't supported. Use Chrome or Edge.` : 'Open this page over https://.'} The demo works anywhere.</p>`
    : '';
  const deviceList = devices.length
    ? `<ul class="support">${devices.map((d) => `<li class="maybe">${esc(deviceLabel(d))} · ${esc(deviceStateText(d))}</li>`).join('')}</ul>`
    : '';
  const rememberedList = remembered.length && caps.bluetooth
    ? `<p>Previously used: ${remembered.map((d) => esc(d.name)).join(', ')}. ${caps.getDevices ? '' : 'Pick them again after a reload.'}</p>`
    : '';
  $('empty').innerHTML = `<div class="panel">
    <h2>${devices.length ? 'Waiting for data…' : 'Monitor your Combustion thermometer'}</h2>
    <p>Connect a probe, or a Display, Timer or Booster to get all its probes.</p>
    ${handoff}${unsupported}${deviceList}${rememberedList}
    <div class="actions">
      <button class="btn primary" data-action="connect" ${caps.bluetooth ? '' : 'disabled'}>Connect a device</button>
      ${caps.scan ? '<button class="btn" data-action="scan">Scan nearby</button>' : ''}
      <button class="btn" data-action="demo">Try the demo</button>
      <button class="btn" data-action="setup">Setup</button>
      ${app.history.sessions.size ? '<button class="btn" data-action="history">History</button>' : ''}
    </div>
    ${caps.bluetooth ? `<p class="caption">${esc(CHOOSER_HINT)}</p>` : ''}
    <ul class="support">
      <li class="${caps.bluetooth ? '' : 'no'}">Web Bluetooth connections</li>
      <li class="${caps.getDevices ? '' : 'maybe'}">Automatic reconnect after reload ${caps.getDevices ? '' : '(needs Chrome flag “Experimental Web Platform features”)'}</li>
      <li class="${caps.scan ? '' : 'maybe'}">Passive scanning of advertisements ${caps.scan ? '' : '(same flag)'}</li>
      <li class="${NotificationSink.permission === 'granted' ? '' : NotificationSink.supported ? 'maybe' : 'no'}">System notifications ${NotificationSink.permission === 'granted' ? '' : NotificationSink.permission === 'denied' ? '(blocked for this site)' : NotificationSink.supported ? '(not allowed yet)' : ''}</li>
      <li>Alerts keep working while this tab is in the background</li>
      <li class="${ScreenWakeLock.supported ? '' : 'no'}">Keep the screen awake during a cook</li>
    </ul>
  </div>`;
}

function deviceStateText(d) {
  if (d.state === 'connected') return d.kind === 'node' ? `Connected · ${d.link?.snapshot.probes.length ?? 0} probes` : 'Connected';
  if (d.state === 'reconnecting') return `Reconnecting${d.nextRetryAt ? ` in ${Math.max(0, Math.round((d.nextRetryAt - Date.now()) / 1000))} s` : ''}${d.error ? ` (${d.error})` : ''}`;
  if (d.state === 'connecting') return d.tries > 1 ? `Connecting… (try ${d.tries})` : 'Connecting…';
  return 'Disconnected';
}

function currentSnapshot() {
  return state.selected ? app.store.snapshot(state.selected) : null;
}

function viewedSession() {
  return state.viewSession ? app.history.sessions.get(state.viewSession) : null;
}

function renderHeader() {
  const past = viewedSession();
  const snap = past ? app.store.snapshot(past.serial) : currentSnapshot();
  const serial = past?.serial ?? state.selected;
  $('badge').outerHTML = badge(snap).replace('class="badge', 'id="badge" class="badge');
  $('probe-name').textContent = past ? (past.name || probeName(serial)) : probeName(serial);
  const session = past ?? app.history.currentSession(serial);
  const view = past ? null : app.presenter.view(serial);
  const cookType = view && view.mode !== 'none' ? 'Predictive cook' : 'Monitoring';
  $('probe-caption').textContent = past
    ? `History · ${fmt.dayAndTime(past.startedAt)} · ${fmt.duration(past.lastSeen - past.startedAt)}`
    : `${cookType}${session ? ` · started ${fmt.clock(session.startedAt)}` : ''}`;

  const label = $('ready-label');
  const primary = $('ready-primary');
  const secondary = $('ready-secondary');
  primary.className = 'countdown';
  label.textContent = '';
  primary.textContent = '';
  secondary.textContent = '';
  if (past) {
    label.innerHTML = '<button class="btn" data-action="back-live">Back to live</button>';
    return;
  }
  if (snap?.isOffline) {
    label.textContent = 'Offline';
    primary.textContent = fmt.duration(Date.now() - snap.receivedAt);
    primary.classList.add('stale');
    return;
  }
  if (snap?.mode === 'instantRead') {
    label.textContent = 'Instant Read';
    return;
  }
  if (!view) return;
  if (view.state === 'predicting' && view.secondsRemaining != null) {
    const relative = fmt.countdown(view.secondsRemaining);
    const at = fmt.clock(view.readyAt);
    label.textContent = view.isStale ? 'Stale' : view.type === 'resting' ? 'Resting' : state.primaryTime === 'clock' ? 'Ready at' : 'Ready in';
    primary.textContent = state.primaryTime === 'clock' ? at : relative;
    secondary.textContent = state.primaryTime === 'clock' ? `in ${relative}` : `at ${at}`;
    if (view.isStale) primary.classList.add('stale');
  } else if (view.state === 'removalPredictionDone') {
    primary.textContent = 'Ready';
    primary.classList.add('ready');
    if (view.readySince) secondary.textContent = `since ${fmt.clock(view.readySince)}`;
  } else if (view.mode === 'none') {
    label.textContent = view.state === 'notInserted' ? 'Not inserted' : 'No target set';
  } else {
    label.textContent = fmt.predictionStateText(view.state);
  }
}

function readoutValues() {
  const s = state.scrub;
  if (s) return { core: s.temps[s.vs[0]], surface: s.temps[s.vs[1]], ambient: s.temps[s.vs[2]] };
  const snap = state.viewSession ? null : currentSnapshot();
  return snap?.virtual ?? {};
}

function renderReadouts() {
  const snap = state.viewSession ? null : currentSnapshot();
  if (snap?.mode === 'instantRead' && !state.scrub) {
    const value = state.unit === 'F' ? snap.instantReadFahrenheit : snap.instantRead;
    $('readouts').innerHTML = `<div class="readout"><span class="pill core">Instant Read</span><div class="value">${value == null ? '—' : Math.round(value)}<small>°${state.unit}</small></div></div>`;
    return;
  }
  const v = readoutValues();
  $('readouts').innerHTML = ['core', 'surface', 'ambient'].map((k) =>
    `<div class="readout"><span class="pill ${k}">${fmt.channelName(k)}</span><div class="value">${fmt.temp(v[k], state.unit)}<small>°${state.unit}</small></div></div>`).join('');
}

function renderGraphLabel() {
  const view = state.viewSession ? null : app.presenter.view(state.selected);
  $('graph-state').textContent = state.scrub
    ? fmt.predictionStateText(state.scrub.state ?? view?.state)
    : view ? (view.isStale ? 'Stale' : fmt.predictionStateText(view.state)) : state.viewSession ? 'History' : 'Live';
  $('graph-time').textContent = state.scrub ? fmt.clock(state.scrub.time) : state.viewSession ? '' : `Now · ${fmt.clock(Date.now())}`;
}

function graphWindow() {
  const samples = state.samples;
  const now = Date.now();
  if (state.viewSession) {
    return { from: samples[0]?.time ?? now - HOUR, to: samples.at(-1)?.time ?? now };
  }
  const start = app.history.currentSession(state.selected)?.startedAt ?? samples[0]?.time ?? now - 30 * 60_000;
  return { from: Math.min(start, now - 10 * 60_000), to: now };
}

function updateGraph() {
  if ($('probe-view').hidden) return;
  const snap = state.viewSession ? null : currentSnapshot();
  const session = viewedSession() ?? app.history.currentSession(state.selected);
  const target = snap?.prediction && snap.prediction.mode !== 'none' ? snap.prediction.setpoint
    : state.samples.at(-1)?.setpoint || null;
  graph.set({
    samples: state.samples, ...graphWindow(), target, unit: state.unit, hidden: state.hiddenLines,
    period: session?.samplePeriodMs ?? 5000,
  });
  const empty = $('graph-empty');
  empty.hidden = state.samples.length > 0;
  empty.textContent = snap?.isOffline ? 'Probe offline.' : 'Loading the cook so far…';
}

function chipStatus(snap) {
  const view = app.presenter.view(snap.serial);
  if (snap.isOffline) return { text: `Offline ${fmt.duration(Date.now() - snap.receivedAt)}`, cls: '' };
  if (snap.overheating.length) return { text: 'Overheat', cls: 'critical' };
  if (snap.mode === 'instantRead') return { text: 'Instant Read', cls: '' };
  if (!view) return { text: '', cls: '' };
  if (view.isStale) return { text: 'Stale', cls: '' };
  if (view.state === 'removalPredictionDone') return { text: 'Ready', cls: 'ready' };
  if (view.state === 'predicting' && view.secondsRemaining != null) {
    return { text: state.primaryTime === 'clock' ? fmt.clock(view.readyAt) : fmt.countdown(view.secondsRemaining), cls: '' };
  }
  if (view.state === 'warming') return { text: 'Warming', cls: '' };
  if (view.state === 'notInserted') return { text: 'Not inserted', cls: '' };
  return { text: '', cls: '' };
}

function renderChips(probes) {
  const chips = $('chips');
  if (probes.length < 2 || state.viewSession) {
    chips.innerHTML = '';
    return;
  }
  const alerting = new Set(state.active.filter((a) => a.state === 'firing').map((a) => a.serial));
  chips.innerHTML = probes.map((p) => {
    const st = chipStatus(p);
    const target = p.prediction && p.prediction.mode !== 'none' ? ` → ${fmt.temp(p.prediction.setpoint, state.unit, { degree: true })}` : '';
    return `<button class="chip${alerting.has(p.serial) ? ' alerting' : ''}" data-select="${esc(p.serial)}" aria-current="${p.serial === state.selected}">
      ${badge(p, true)}<span><span class="name">${esc(probeName(p.serial))}</span><br><span class="core">${fmt.temp(p.virtual.core, state.unit, { degree: true })}</span><span class="caption">${target}</span>${p.batteryLow ? ' <span class="warn">Battery</span>' : ''}</span>
      <span class="status ${st.cls}">${esc(st.text)}</span></button>`;
  }).join('');
}

function connectionText(snap) {
  const p = snap?.link.primary;
  if (!p) return 'Offline';
  const node = p.via ? app.store.nodes.get(p.via) : null;
  const nodeName = node ? node.productType[0].toUpperCase() + node.productType.slice(1) : 'node';
  if (p.kind === 'directConnection') return 'Direct';
  if (p.kind === 'nodeConnection') return `Via ${nodeName} · ${p.hopCount} hop${p.hopCount === 1 ? '' : 's'}`;
  if (p.kind === 'advertisement') return `Advertising${p.rssi != null ? ` · ${p.rssi} dBm` : ''}`;
  return `Repeated · ${p.hopCount} hops`;
}

function renderInspector() {
  const past = viewedSession();
  const snap = past ? null : currentSnapshot();
  const el = $('inspector');
  if (past) {
    el.innerHTML = `<div class="section-title">Cook</div>
      <dl class="facts"><dt>Probe</dt><dd>${esc(past.serial)}</dd><dt>Start</dt><dd>${fmt.dayAndTime(past.startedAt)}</dd>
      <dt>Length</dt><dd>${fmt.duration(past.lastSeen - past.startedAt)}</dd><dt>Samples</dt><dd>${state.samples.length}</dd></dl>
      <div class="actions"><button class="btn" data-action="export" data-key="${esc(past.key)}">Export CSV</button><button class="btn" data-action="back-live">Back to live</button></div>`;
    return;
  }
  if (!snap) {
    el.innerHTML = '';
    return;
  }
  const p = snap.prediction;
  const reachable = !!app.route(snap.serial);
  const pct = p && p.mode !== 'none' && p.setpoint > p.heatStart
    ? Math.min(100, Math.max(0, ((p.estimatedCore - p.heatStart) / (p.setpoint - p.heatStart)) * 100)) : null;
  const target = p && p.mode !== 'none'
    ? `<div class="progress-row"><span>Cooking to ${fmt.temp(p.setpoint, state.unit, { degree: true })}${state.unit}</span><span>${pct == null ? '' : `${Math.round(pct)}% to target`}</span></div>
       <div class="progress"><div style="width:${pct ?? 0}%"></div></div>`
    : `<div class="progress-row"><span>No target set</span></div>`;
  const roles = { [snap.virtual.coreSensor]: 'core', [snap.virtual.surfaceSensor]: 'surface', [snap.virtual.ambientSensor]: 'ambient' };
  const sensors = SENSORS.map((s, i) => {
    const role = roles[s];
    const hot = snap.overheating.includes(s);
    const off = state.hiddenLines.has(seriesId(i));
    const plotted = !off;
    const label = `${s.toUpperCase()}${role ? ` (${fmt.channelName(role)})` : ''}`;
    const title = `${plotted ? 'Hide' : 'Show'} ${label} on the graph`;
    return `<button type="button" class="sensor ${role ?? ''}${hot ? ' hot' : ''}${off ? ' off' : ''}" data-sensor="${i}" data-role="${role ?? ''}"
      aria-pressed="${plotted}" title="${esc(title)}"><div class="label">${s.toUpperCase()}</div><div class="t">${fmt.temp(snap.temperatures[i], state.unit)}</div>${role ? `<span class="tag">${fmt.channelName(role)}</span>` : ''}</button>`;
  }).join('');
  const session = app.history.currentSession(snap.serial);
  const food = snap.foodSafe ? { notSafe: 'Not yet safe', safe: 'Safe', safetyImpossible: 'Not reachable' }[snap.foodSafe.state] : null;
  el.innerHTML = `${target}
    <div class="actions">
      <button class="btn primary" data-action="target" ${reachable ? '' : 'disabled title="Needs a connection to the probe or a node"'}>Set target</button>
      <button class="btn" data-action="alarms">Alarms &amp; alerts</button>
    </div>
    ${reachable ? '' : '<p class="caption">Connect to change these.</p>'}
    <div class="section-title">Sensors, tip to handle <span class="caption">· click to show or hide</span></div>
    <div class="sensors">${sensors}</div>
    <dl class="facts">
      <dt>Probe</dt><dd>${snap.color === 'grey' ? 'Grey' : snap.color === 'yellow' ? 'Yellow' : 'Probe'} · ${esc(snap.serial)}</dd>
      <dt>Battery</dt><dd class="${snap.batteryLow ? 'warn' : ''}">${snap.batteryLow ? 'Low' : 'OK'}</dd>
      <dt>Connection</dt><dd>${esc(connectionText(snap))}</dd>
      ${session ? `<dt>Start</dt><dd>${fmt.clock(session.startedAt)}</dd>` : ''}
      ${food ? `<dt>Food safe</dt><dd>${food}</dd>` : ''}
      ${wake.held ? '<dt>Screen</dt><dd>Kept awake</dd>' : ''}
      <dt>Alerts</dt><dd class="${NotificationSink.permission === 'granted' ? '' : 'warn'}">${NotificationSink.permission === 'granted' ? 'Sound + notifications' : 'Sound and this tab only'}</dd>
    </dl>`;
}

/** A sensor tile was clicked: hide or show its line. */
function toggleSensorLine(tile) {
  const line = seriesId(Number(tile.dataset.sensor));
  if (state.hiddenLines.has(line)) state.hiddenLines.delete(line);
  else state.hiddenLines.add(line);
  prefs.set('hiddenLines', [...state.hiddenLines]);
  invalidate();
}

function renderKitchen(probes) {
  const k = $('kitchen');
  const alerting = new Set(state.active.filter((a) => a.state === 'firing').map((a) => a.serial));
  const tiles = probes.map((p) => {
    const view = app.presenter.view(p.serial);
    const st = chipStatus(p);
    const big = view?.state === 'predicting' && view.secondsRemaining != null ? fmt.countdown(view.secondsRemaining)
      : st.text || fmt.temp(p.virtual.core, state.unit, { degree: true });
    const target = p.prediction && p.prediction.mode !== 'none' ? ` → ${fmt.temp(p.prediction.setpoint, state.unit, { degree: true })}` : '';
    const alert = state.active.find((a) => a.serial === p.serial && a.state === 'firing');
    return `<div class="tile${alerting.has(p.serial) ? ' alerting' : ''}">
      <div class="head">${badge(p)} ${esc(probeName(p.serial))}</div>
      <div class="big">${esc(alert ? fmt.describeAlert(alert, state.unit).title : big)}</div>
      <div class="sub"><span style="color:var(--core)">${fmt.temp(p.virtual.core, state.unit, { degree: true })}</span>${target}${view?.readyAt && view.state === 'predicting' ? ` · ${fmt.clock(view.readyAt)}` : ''}</div>
    </div>`;
  }).join('');
  // Clock and cook time sit quietly in the top corner; the cook runs from the earliest live session's start.
  const starts = probes.map((p) => app.history.currentSession(p.serial)?.startedAt).filter((t) => t != null);
  const now = Date.now();
  const meta = `<div class="meta"><span>${fmt.clock(now)}</span>${starts.length ? `<span>Cook ${fmt.duration(now - Math.min(...starts))}</span>` : ''}</div>`;
  k.innerHTML = `<div class="bar"><div class="brand">Colby · Kitchen</div><div class="end">${meta}<button class="btn" data-action="kitchen-exit">Exit</button></div></div>
    <div class="tiles">${tiles || '<div class="tile"><div class="sub">No probes</div></div>'}</div>
    ${alerting.size ? '<p class="caption" style="text-align:center">Tap anywhere or press any key to acknowledge</p>' : ''}`;
  layoutKitchen();
}

/** Sizes the kitchen grid for the tile count and the space the tiles get (see kitchenLayout.js). */
function layoutKitchen() {
  const area = $('kitchen').querySelector('.tiles');
  if (!area) return;
  const { cols, rows, tileHeight } = kitchenGrid(area.children.length, area.clientWidth, area.clientHeight);
  area.style.setProperty('--cols', cols);
  area.style.setProperty('--rows', rows);
  if (tileHeight) area.style.setProperty('--tile-h', `${tileHeight}px`);
  else area.style.removeProperty('--tile-h');
}

// MARK: Dialogs

const dialog = $('dialog');
const form = $('dialog-form');
let dialogHandlers = {};

function openDialog(html, handlers = {}, name = null) {
  form.innerHTML = html;
  dialogHandlers = handlers;
  state.dialog = name;
  if (!dialog.open) {
    dialog.showModal();
    // The modal joined the top layer above the reconnect band: put the band back on top so it stays visible.
    const band = $('reconnect-band');
    if (popovers && band.matches(':popover-open')) {
      band.hidePopover();
      band.showPopover();
    }
  }
  form.querySelector('[autofocus]')?.focus();
}
dialog.addEventListener('close', () => (state.dialog = null));

form.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-do]');
  if (!b) return;
  e.preventDefault();
  const fn = dialogHandlers[b.dataset.do];
  if (fn) await fn(b, new FormData(form));
});
form.addEventListener('change', (e) => dialogHandlers.change?.(e.target, new FormData(form)));
// Enter runs the dialog's primary action instead of closing it.
form.addEventListener('submit', (e) => {
  e.preventDefault();
  form.querySelector('.btn.primary:not(:disabled)')?.click();
});

const closeDialog = () => dialog.close();

function setTargetDialog(serial) {
  const snap = app.store.snapshot(serial);
  const p = snap?.prediction;
  const u = state.unit;
  const current = p && p.mode !== 'none' ? Math.round(fmt.toUnit(p.setpoint, u)) : u === 'F' ? 203 : 95;
  const max = Math.floor(fmt.toUnit(MAX_PREDICTION_SETPOINT, u));
  const presets = [['Beef rare', 49], ['Beef medium', 57], ['Pork', 63], ['Chicken', 74], ['Brisket', 95]];
  openDialog(`<h2>Set target for ${esc(probeName(serial))}</h2>
    <label class="field">Nickname<input type="text" name="name" value="${esc(state.names[serial] ?? '')}" placeholder="${esc(`Probe ${snap?.probeNumber ?? ''}`)}"></label>
    <label class="field">Target core temperature <span><input type="number" name="target" min="${u === 'F' ? 32 : 0}" max="${max}" step="1" value="${current}" autofocus required> °${u}</span></label>
    <div class="actions">${presets.map(([n, c]) => `<button class="btn" data-do="preset" data-c="${c}">${n} ${fmt.temp(c, u, { degree: true })}</button>`).join('')}</div>
    <fieldset><legend>Mode</legend>
      <label><input type="radio" name="mode" value="timeToRemoval" ${p?.mode !== 'removalAndResting' ? 'checked' : ''}> Time to removal</label>
      <label><input type="radio" name="mode" value="removalAndResting" ${p?.mode === 'removalAndResting' ? 'checked' : ''}> Removal and resting</label>
    </fieldset>
    <p class="note">Range ${u === 'F' ? '32' : '0'}–${max} °${u}. Current core ${fmt.temp(snap?.virtual.core, u, { degree: true })}${u}.</p>
    <p class="error" id="target-error" hidden></p>
    <div class="row">
      ${p && p.mode !== 'none' ? '<button class="btn danger" data-do="clear">Clear target</button>' : ''}
      <button class="btn" data-do="cancel">Cancel</button>
      <button class="btn primary" data-do="set">Set</button>
    </div>`, {
    preset: (b) => (form.elements.target.value = Math.round(fmt.toUnit(Number(b.dataset.c), u))),
    cancel: closeDialog,
    clear: (b) => runCommand(b, () => app.commands.cancelPrediction(serial)),
    set: (b, data) => {
      saveName(serial, data.get('name'));
      const c = Math.round(fmt.fromUnit(Number(data.get('target')), u) * 10) / 10;
      if (!(c >= 0 && c <= MAX_PREDICTION_SETPOINT)) return showError(`Enter ${u === 'F' ? '32' : '0'}–${max} °${u}.`);
      return runCommand(b, () => app.commands.setPrediction(serial, data.get('mode'), c));
    },
  });
}

function saveName(serial, name) {
  const n = String(name ?? '').trim();
  if (n) state.names[serial] = n;
  else delete state.names[serial];
  prefs.set('names', state.names);
  invalidate();
}

function showError(text) {
  const e = form.querySelector('#target-error, .error');
  if (e) {
    e.hidden = false;
    e.textContent = text;
  }
}

async function runCommand(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Waiting for the probe…';
  try {
    await fn();
    closeDialog();
    toast('Confirmed by the probe.');
  } catch (e) {
    const text = e instanceof CommandError
      ? { notReachable: "Can't reach this probe.", notConfirmed: "The probe didn't confirm. Try again.", alarmStateUnknown: 'Alarms are still loading. Try again in a few seconds.', outOfRange: 'Value out of range.', uart: `The probe didn't answer (${e.detail}). Try again.` }[e.kind]
      : String(e?.message ?? e);
    showError(text);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const RULE_LABELS = {
  predictionDone: 'Ready (repeats until acknowledged)',
  restingDone: 'Resting done',
  predictionWithin: '5-minute warning',
  probeOffline: 'Disconnected during a cook',
  batteryLow: 'Low battery',
};

async function alarmsDialog(serial) {
  const snap = app.store.snapshot(serial);
  const u = state.unit;
  const rules = await app.alerts.rules(serial);
  const reachable = !!app.route(serial);
  const alarmRow = (channel, kind) => {
    const a = snap?.alarms?.[kind]?.[channel];
    const value = a?.set ? Math.round(fmt.toUnit(a.temperature, u)) : '';
    return `<div class="alarm-row"><span>${fmt.channelName(channel)} ${kind}</span>
      <input type="number" name="alarm.${kind}.${channel}" value="${value}" placeholder="off" step="1" aria-label="${fmt.channelName(channel)} ${kind} alarm °${u}" ${reachable && snap?.alarms ? '' : 'disabled'}>
      <span>°${u}</span></div>`;
  };
  const builtIn = rules.filter((r) => RULE_LABELS[r.kind.type]);
  const custom = rules.filter((r) => !RULE_LABELS[r.kind.type]);
  openDialog(`<h2>Alarms &amp; alerts for ${esc(probeName(serial))}</h2>
    <fieldset><legend>Probe alarms</legend>
      ${alarmRow('core', 'high')}${alarmRow('surface', 'high')}${alarmRow('surface', 'low')}${alarmRow('ambient', 'high')}${alarmRow('ambient', 'low')}
      <p class="note">Saved on the probe. Leave empty to turn off.${reachable ? '' : ' Connect to change these.'}</p>
      <div class="row"><button class="btn primary" data-do="save-alarms" ${reachable && snap?.alarms ? '' : 'disabled'}>Save probe alarms</button></div>
    </fieldset>
    <fieldset><legend>App alerts</legend>
      ${builtIn.map((r) => `<label><input type="checkbox" data-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}> ${RULE_LABELS[r.kind.type]}</label>`).join('')}
      ${custom.map((r) => `<div class="item"><span class="grow">${esc(fmt.describeAlert({ source: { type: 'rule', kind: r.kind }, value: null }, u).title)}</span><button class="btn danger" data-do="remove-rule" data-id="${esc(r.id)}">Remove</button></div>`).join('')}
      <div class="alarm-row"><select name="newKind"><option value="temperatureAbove">Core above</option><option value="temperatureBelow">Core below</option><option value="ambientAbove">Ambient above</option><option value="ambientBelow">Ambient below</option></select>
        <input type="number" name="newTemp" step="1" placeholder="°${u}"><button class="btn" data-do="add-rule">Add</button></div>
      <p class="note">Overheat warnings are always on. App alerts only work while this page is open.</p>
    </fieldset>
    <p class="error" hidden></p>
    <div class="row"><button class="btn" data-do="cancel">Done</button></div>`, {
    cancel: closeDialog,
    change: async (target) => {
      if (!target.dataset.rule) return;
      const next = (await app.alerts.rules(serial)).map((r) => (r.id === target.dataset.rule ? { ...r, enabled: target.checked } : r));
      await app.alerts.setRules(serial, next);
    },
    'remove-rule': async (b) => {
      await app.alerts.setRules(serial, (await app.alerts.rules(serial)).filter((r) => r.id !== b.dataset.id));
      alarmsDialog(serial);
    },
    'add-rule': async (_b, data) => {
      const v = Number(data.get('newTemp'));
      if (!data.get('newTemp') || !Number.isFinite(v)) return showError('Enter a temperature.');
      const choice = data.get('newKind');
      const channel = choice.startsWith('ambient') ? 'ambient' : 'core';
      const type = choice.endsWith('Below') ? 'temperatureBelow' : 'temperatureAbove';
      const rule = { id: `${serial}.custom.${Date.now()}`, kind: { type, channel, celsius: fmt.fromUnit(v, u), hysteresis: 1 }, enabled: true };
      await app.alerts.setRules(serial, [...(await app.alerts.rules(serial)), rule]);
      alarmsDialog(serial);
    },
    'save-alarms': async (b, data) => {
      const current = app.store.snapshot(serial)?.alarms;
      const changes = [];
      for (const [key, raw] of data.entries()) {
        if (!key.startsWith('alarm.')) continue;
        const [, kind, channel] = key.split('.');
        const wanted = raw === '' ? null : Math.round(fmt.fromUnit(Number(raw), u) * 10) / 10;
        const have = current?.[kind]?.[channel];
        const same = wanted == null ? !have?.set : have?.set && Math.abs(have.temperature - wanted) < 0.06;
        if (!same) changes.push([channel, kind, wanted]);
      }
      if (!changes.length) return closeDialog();
      await runCommand(b, async () => {
        for (const [channel, kind, t] of changes) await app.commands.setAlarm(serial, channel, kind, t);
      });
    },
  });
}

function devicesDialog() {
  const caps = ble.capabilities();
  const devices = [...app.devices.values()];
  const probes = [...app.store.snapshots().values()];
  openDialog(`<h2>Devices</h2>
    <div class="list">${devices.map((d) => `<div class="item"><div class="grow"><strong>${esc(deviceLabel(d))}</strong>${d.simulated ? ' <span class="caption">demo</span>' : ''}<br>
      <span class="caption">${d.kind === 'node' ? esc(d.productType ?? 'Node') : d.kind === 'probe' ? 'Probe' : ''} ${esc(d.serial ?? '')} · ${esc(deviceStateText(d))}</span></div>
      ${d.state !== 'connected' ? `<button class="btn" data-do="retry" data-id="${esc(d.id)}">Retry</button>` : ''}
      <button class="btn danger" data-do="remove" data-id="${esc(d.id)}">Remove</button></div>`).join('') || '<p class="note">No devices yet.</p>'}</div>
    <div class="row" style="justify-content:flex-start">
      <button class="btn primary" data-do="connect" ${caps.bluetooth ? '' : 'disabled'}>Connect a device</button>
      ${caps.scan ? `<button class="btn" data-do="scan">${state.scanStop ? 'Stop scanning' : 'Scan nearby'}</button>` : ''}
      <button class="btn" data-do="demo">Add demo devices</button>
    </div>
    ${probes.length ? `<fieldset><legend>Probes</legend>${probes.map((p) => `<label><input type="checkbox" data-probe="${esc(p.serial)}" ${app.hidden.has(p.serial) ? '' : 'checked'}> ${esc(probeName(p.serial))} <span class="caption">${esc(p.serial)} · ${esc(connectionText(p))}</span></label>`).join('')}
      <p class="note">Unchecked probes are hidden and don't alert.</p></fieldset>` : ''}
    <p class="note">${caps.bluetooth ? `${esc(CHOOSER_HINT)} ` : `${BROWSER_SUPPORT} `}${caps.getDevices ? '' : 'Pick devices again after a reload. '}</p>
    <div class="row"><button class="btn" data-do="close">Done</button></div>`, {
    close: closeDialog,
    retry: (b) => app.retry(b.dataset.id),
    remove: (b) => {
      app.removeDevice(b.dataset.id);
      prefs.set('devices', prefs.get('devices', []).filter((d) => d.id !== b.dataset.id));
      devicesDialog();
    },
    connect: async () => {
      await connectDevice();
      devicesDialog();
    },
    scan: async () => {
      await toggleScan();
      devicesDialog();
    },
    demo: () => {
      startDemo();
      closeDialog();
    },
    change: (target) => {
      if (target.dataset.probe) app.setHidden(target.dataset.probe, !target.checked);
      invalidate();
    },
  }, 'devices');
}

function historyDialog() {
  const sessions = app.history.list();
  openDialog(`<h2>History</h2>
    <div class="list">${sessions.map((s) => `<div class="item"><div class="grow"><strong>${esc(s.name || probeName(s.serial))}</strong><br>
      <span class="caption">${fmt.dayAndTime(s.startedAt)} · ${fmt.duration(s.lastSeen - s.startedAt)} · ${esc(s.serial)}</span></div>
      <button class="btn" data-do="open" data-key="${esc(s.key)}">Open</button>
      <button class="btn" data-do="export" data-key="${esc(s.key)}">CSV</button>
      <button class="btn danger" data-do="delete" data-key="${esc(s.key)}">Delete</button></div>`).join('') || '<p class="note">No cooks yet.</p>'}</div>
    <p class="note">Cooks are saved in this browser. Clearing site data deletes them.</p>
    <div class="row"><button class="btn" data-do="close">Done</button></div>`, {
    close: closeDialog,
    open: async (b) => {
      state.viewSession = b.dataset.key;
      state.scrub = null;
      closeDialog();
      await reloadSamples();
      invalidate();
    },
    export: (b) => exportCsv(b.dataset.key),
    delete: async (b) => {
      if (!confirm("Delete this cook? You can't undo this.")) return;
      if (state.viewSession === b.dataset.key) state.viewSession = null;
      await app.history.deleteSession(b.dataset.key);
      historyDialog();
    },
  });
}

async function exportCsv(key) {
  const s = app.history.sessions.get(key);
  const samples = await app.history.samples(key);
  const u = state.unit;
  const head = ['time', 'seq', ...SENSORS.map((x) => `${x.toUpperCase()} °${u}`), `core °${u}`, `surface °${u}`, `ambient °${u}`, 'prediction state'];
  const rows = samples.map((r) => [new Date(r.time).toISOString(), r.seq, ...r.temps.map((t) => fmt.toUnit(t, u).toFixed(1)),
    ...r.vs.map((i) => fmt.toUnit(r.temps[i], u).toFixed(1)), r.state]);
  const csv = [head, ...rows].map((r) => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `colby-${(s?.name || s?.serial || 'cook').replace(/[^\w-]+/g, '_')}-${new Date(s?.startedAt ?? Date.now()).toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Set by build.mjs on a release tag: `{version, date, notes: [{title, url}]}`. The unbuilt source has no release.
const RELEASE = typeof __COLBY_RELEASE__ === 'undefined' ? null : __COLBY_RELEASE__;
const RELEASES_URL = 'https://github.com/colbyapp/colbyapp.github.io/releases';

/** Settings' last section: what changed in this version, and a link to every release on GitHub. */
function changelogSection() {
  const all = `<p class="note"><a href="${RELEASES_URL}" target="_blank" rel="noopener">See all changes</a></p>`;
  if (!RELEASE) return `<fieldset><legend>What's new</legend><p class="note">Development build (not a release).</p>${all}</fieldset>`;
  const date = new Date(`${RELEASE.date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const list = RELEASE.notes.length
    ? `<ul class="changes">${RELEASE.notes.map((n) => `<li>${esc(n.title)}</li>`).join('')}</ul>`
    : '<p class="note">Small fixes.</p>';
  return `<fieldset><legend>What's new in ${esc(RELEASE.version)}</legend>
    <p class="note">Released ${esc(date)}</p>${list}${all}</fieldset>`;
}

function settingsDialog() {
  const caps = ble.capabilities();
  openDialog(`<h2>Settings</h2>
    <label class="field">Temperature unit<select name="unit"><option value="F" ${state.unit === 'F' ? 'selected' : ''}>°F</option><option value="C" ${state.unit === 'C' ? 'selected' : ''}>°C</option></select></label>
    <label class="field">Prediction time<select name="primaryTime"><option value="relative" ${state.primaryTime === 'relative' ? 'selected' : ''}>Ready in (countdown)</option><option value="clock" ${state.primaryTime === 'clock' ? 'selected' : ''}>Ready at (clock)</option></select></label>
    <label><input type="checkbox" name="sound" ${sound.enabled ? 'checked' : ''}> Alert sounds <button class="btn" data-do="test">Test</button></label>
    <label><input type="checkbox" name="keepAwake" ${wake.enabled ? 'checked' : ''} ${ScreenWakeLock.supported ? '' : 'disabled'}> Keep the screen awake during a cook${ScreenWakeLock.supported ? '' : ' (not supported here)'}</label>
    <div class="item"><span class="grow">System notifications: ${esc({ granted: 'on', default: 'not asked yet', denied: 'blocked', unsupported: 'not supported' }[NotificationSink.permission])}</span>
      ${NotificationSink.permission === 'default' ? '<button class="btn" data-do="notify">Allow</button>' : ''}
      ${NotificationSink.permission === 'granted' ? '<button class="btn" data-do="test-notify">Test</button>' : ''}</div>
    ${NotificationSink.permission === 'granted' ? `<details class="note"><summary>Notification not showing?</summary>${notifyTroubleshooting()}</details>` : ''}
    ${NotificationSink.permission === 'granted' ? '' : `<p class="note">Without notifications, alerts only show in this tab.${NotificationSink.permission === 'denied' ? ' To allow them, use Site settings, then reload.' : ''}</p>`}
    <p class="note">Alerts work in background tabs while this tab is open and your computer is awake.</p>
    <div class="row" style="justify-content:flex-start"><button class="btn" data-do="setup">Run setup again</button></div>
    <fieldset><legend>This browser</legend>
      <ul class="support">
        <li class="${caps.bluetooth ? '' : 'no'}">Web Bluetooth</li>
        <li class="${caps.getDevices ? '' : 'maybe'}">Reconnect after reload (getDevices)</li>
        <li class="${caps.watchAdvertisements ? '' : 'maybe'}">Probe serial and signal strength (watchAdvertisements)</li>
        <li class="${caps.scan ? '' : 'maybe'}">Passive scanning (requestLEScan)</li>
      </ul>
      <p class="note">Items marked – need chrome://flags/#enable-experimental-web-platform-features.</p>
    </fieldset>
    <p class="note">Colby is open source: <a href="https://github.com/colbyapp/colbyapp.github.io" target="_blank" rel="noopener">github.com/colbyapp/colbyapp.github.io</a></p>
    ${changelogSection()}
    <div class="row"><button class="btn danger" data-do="wipe">Delete all data</button><button class="btn" data-do="close">Done</button></div>`, {
    close: closeDialog,
    test: () => sound.test('ready'),
    notify: async () => {
      if ((await NotificationSink.requestPermission()) === 'granted') await notifications.test();
      settingsDialog();
    },
    'test-notify': async () => {
      sound.test('ready');
      toast((await notifications.test()) ? 'Test sent.'
        : 'The browser blocked the notification.', 6000);
    },
    setup: () => {
      closeDialog();
      onboarding.open('welcome');
    },
    wipe: async () => {
      if (!confirm('Delete all Colby data in this browser?')) return;
      for (const s of app.history.list()) await app.history.deleteSession(s.key);
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith('colby.')) localStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
      location.reload();
    },
    change: (target) => {
      if (target.name === 'unit') state.unit = target.value;
      if (target.name === 'primaryTime') state.primaryTime = target.value;
      if (target.name === 'sound') sound.enabled = target.checked;
      if (target.name === 'keepAwake') {
        wake.enabled = target.checked;
        wake.refresh();
      }
      prefs.set('unit', state.unit);
      prefs.set('primaryTime', state.primaryTime);
      prefs.set('sound', sound.enabled);
      prefs.set('keepAwake', wake.enabled);
      invalidate();
    },
  });
}

function alertsDialog() {
  openDialog(`<h2>Alerts</h2>
    <div class="list">${state.active.map((a) => {
      const { title, detail } = fmt.describeAlert(a, state.unit);
      return `<div class="item"><div class="grow"><strong>${esc(probeName(a.serial))}: ${esc(title)}</strong><br><span class="caption">${esc(detail)} · ${a.state} since ${fmt.clock(a.firedAt)}</span></div>
        ${a.state !== 'acknowledged' ? `<button class="btn" data-do="ack" data-id="${esc(a.id)}">Acknowledge</button>` : ''}</div>`;
    }).join('') || '<p class="note">No active alerts.</p>'}</div>
    <div class="row"><button class="btn" data-do="all">Acknowledge all</button><button class="btn" data-do="close">Done</button></div>`, {
    close: closeDialog,
    ack: async (b) => {
      await app.alerts.acknowledge(b.dataset.id);
      alertsDialog();
    },
    all: async () => {
      await app.alerts.silenceAll();
      closeDialog();
    },
  });
}

// MARK: Devices

const PRODUCT_NAMES = { display: 'Display', booster: 'Booster', gauge: 'Gauge', engine: 'Engine' };

/**
 * What to call a device: what it turned out to be once connected (Display, Booster, probe number and color), else the
 * browser's name for it. Never a Bluetooth address: Chrome uses one when the device advertises no name.
 */
function deviceLabel(d) {
  if (d.kind === 'node') return `${PRODUCT_NAMES[d.productType] ?? 'Node'} ${d.serial ?? ''}`.trim();
  if (d.kind === 'probe') {
    const snap = d.serial ? app.store.snapshot(d.serial) : null;
    const color = snap?.color === 'grey' ? ' (grey)' : snap?.color === 'yellow' ? ' (yellow)' : '';
    return snap ? `Probe ${snap.probeNumber}${color}` : 'Probe';
  }
  return d.name && d.name !== 'Combustion device' ? d.name : 'Combustion device (identifying…)';
}

/** Says once what each newly connected device is, and remembers that name for the "previously used" list. */
const announced = new Set();
function announceIdentified(devices) {
  for (const d of devices) {
    if (d.state !== 'connected' || !d.kind || announced.has(d.id)) continue;
    announced.add(d.id);
    if (d.simulated) continue;
    const label = deviceLabel(d);
    toast(`Connected: ${label}`);
    const known = prefs.get('devices', []);
    if (known.some((k) => k.id === d.id)) prefs.set('devices', known.map((k) => (k.id === d.id ? { ...k, name: label } : k)));
  }
  for (const id of announced) if (!app.devices.has(id)) announced.delete(id);
}

/** Shown when the chooser closes with nothing picked (backlog F-2): the device may be asleep or held by Chrome. */
const CHOOSER_EMPTY_HINT = 'Device not listed? Take the probe out of its charger to wake it. Still missing? Open '
  + 'chrome://bluetooth-internals, click Forget on the Combustion device, close other Colby tabs, and try again.';

/** Opens the browser's chooser and adds the picked device. Resolves true when a device was added. */
async function connectDevice() {
  if (!ble.capabilities().bluetooth) {
    onboarding.open('bluetooth');
    return false;
  }
  releaseStaleLinks();
  let device;
  try {
    device = await ble.requestDevice();
  } catch (e) {
    // NotFoundError: the chooser was cancelled. SecurityError / NotAllowedError: Bluetooth blocked for the site.
    if (e?.name === 'SecurityError' || e?.name === 'NotAllowedError') onboarding.open('bluetooth');
    else if (e?.name === 'NotFoundError') toast(CHOOSER_EMPTY_HINT, 12000);
    else toast(`Could not open the device chooser: ${e?.message ?? e}`);
    return false;
  }
  addBleDevice(device);
  const known = prefs.get('devices', []).filter((d) => d.id !== device.id);
  prefs.set('devices', [...known, { id: device.id, name: ble.advertisedName(device) ?? 'Combustion device' }]);
  return true;
}

/** Tells what a connected device is: probe serial or node serial and type. */
async function identify(device, connection, isProbe) {
  const fromAd = ble.capabilities().watchAdvertisements ? await ble.identifyFromAdvertisement(device, 3000) : null;
  if (isProbe) {
    if (fromAd?.kind === 'probe') return { serial: fromAd.serial };
    return { serial: prefs.get('probeSerials', {})[device.id] ?? ble.pseudoSerial(device.id) };
  }
  let model = '';
  try {
    model = cString(Array.from(await connection.read(GATT.modelNumber)));
  } catch {
    /* not readable */
  }
  // Model Number strings per the Android SDK (CombustionProductType.fromModelString): a Display reports "Timer", a
  // Booster "Charger".
  const byModel = { Timer: 'display', Charger: 'booster', Gauge: 'gauge', Engine: 'engine' }[model.trim()];
  const productType = fromAd?.kind === 'node' ? fromAd.productType : byModel ?? 'display';
  return { serial: fromAd?.kind === 'node' ? fromAd.serial : ble.advertisedName(device) || ble.pseudoSerial(device.id), productType };
}

/**
 * Browser Bluetooth devices by id, so their GATT links can be released (page hide, chooser, wake) and so a direct
 * probe can be connected again under its real serial.
 */
const bleDevices = new Map();

/** Releases Chrome's link to every device Colby has no live link to; a stale one can hide it from the chooser (I-1). */
function releaseStaleLinks() {
  for (const [id, device] of bleDevices) if (!app.devices.get(id)?.link) ble.releaseDevice(device);
}

/**
 * A direct probe without the advertisement flag gets a stand-in serial, so the same probe also seen through a Display
 * showed up twice (e.g. 773DF86D and 1000D027). When the two report the same session ID, remember the real serial for
 * this browser device, move the nickname over, and connect again under the real serial (core/identity.js).
 */
function resolveStandIns() {
  const sessionIdOf = (serial) => app.history.currentSession(serial)?.sessionId ?? 0;
  const direct = [...app.devices.values()]
    .filter((d) => d.kind === 'probe' && !d.simulated && d.link && bleDevices.has(d.id) && d.serial === ble.pseudoSerial(d.id));
  const standIns = new Set(direct.map((d) => d.serial));
  const candidates = [...app.store.snapshots().keys()].filter((s) => !standIns.has(s));
  for (const d of direct) {
    const standIn = d.serial;
    const real = realSerialFor(standIn, candidates, sessionIdOf);
    if (!real) {
      const hex = (s) => (sessionIdOf(s) >>> 0).toString(16).toUpperCase();
      console.info(`[Colby] stand-in ${standIn} (session ${hex(standIn)}) not matched; others: ${candidates.map((s) => `${s}=${hex(s)}`).join(', ') || 'none'}`);
      continue;
    }
    prefs.set('probeSerials', { ...prefs.get('probeSerials', {}), [d.id]: real });
    if (state.names[standIn]) {
      state.names[real] ??= state.names[standIn];
      delete state.names[standIn];
      prefs.set('names', state.names);
    }
    if (state.selected === standIn) state.selected = real;
    const device = bleDevices.get(d.id);
    app.removeDevice(d.id);
    app.store.forget(standIn);
    addBleDevice(device);
    toast(`Matched the direct probe to ${probeName(real)} (${real}).`);
  }
}

function addBleDevice(device) {
  bleDevices.set(device.id, device);
  app.addDevice({
    id: device.id,
    name: ble.advertisedName(device) ?? 'Combustion device',
    open: () => ble.WebBleConnection.connect(device),
    identify: (connection, isProbe) => identify(device, connection, isProbe),
  });
}

async function toggleScan() {
  if (state.scanStop) {
    state.scanStop();
    state.scanStop = null;
    return;
  }
  try {
    state.scanStop = await ble.startScan((ad) => app.ingestAdvertisement(ad));
    toast('Scanning for nearby probes…');
  } catch (e) {
    toast(`Scanning failed: ${e?.message ?? e}`);
  }
}

/** Demo: a Display relaying simulated probes, one mid-cook and one about to be ready. `#demo=N` (1-8) sets the count. */
const DEMO_EXTRA = [
  ['3000C0DE', 'Chicken thighs', { tauHours: 1, asymptote: 85, oven: 190 }, 79.5, 0.6],
  ['4000FACE', 'Pork shoulder', { tauHours: 4 }, 93, 0.5],
  ['5000D00D', 'Salmon', { tauHours: 0.6, asymptote: 60, oven: 135 }, 52, 0.7],
  ['6000CAFE', 'Lamb rack', { tauHours: 1.2, asymptote: 70, oven: 180 }, 57, 0.4],
  ['7000BABE', 'Turkey breast', { tauHours: 2, asymptote: 80, oven: 165 }, 71, 0.55],
  ['8000F00D', 'Wings', { tauHours: 0.8, asymptote: 90, oven: 200 }, 82, 0.3],
];

function startDemo(count = 2) {
  if (app.devices.has('demo-display')) return;
  const now = Date.now();
  const brisket = new SimProbe({
    serial: '10005A3F', probeNumber: 1, color: 'yellow', sessionId: 0x1a2b3c4d, startedAt: now - 3.33 * HOUR,
    setpoint: 95, mode: 'timeToRemoval', curve: cookCurve({ tauHours: 3 }),
  });
  const ribsCurve = cookCurve({ tauHours: 2, asymptote: 108, oven: 115 });
  const ribs = new SimProbe({
    serial: '2000BEEF', probeNumber: 2, color: 'grey', sessionId: 0x55aa1234,
    startedAt: now - (ribsCurve.timeTo(90.5) * 1000 - 6 * 60_000), setpoint: 90.5, mode: 'timeToRemoval', curve: ribsCurve,
  });
  const probes = [brisket, ribs];
  const names = [[brisket.serial, 'Brisket'], [ribs.serial, 'Ribs']];
  DEMO_EXTRA.forEach(([serial, name, curveOpts, setpoint, progress], i) => {
    const curve = cookCurve(curveOpts);
    probes.push(new SimProbe({
      serial, probeNumber: i + 3, color: 'yellow', sessionId: 0x60000000 + i,
      startedAt: now - curve.timeTo(setpoint) * 1000 * progress, setpoint, mode: 'timeToRemoval', curve,
    }));
    names.push([serial, name]);
  });
  const n = Math.min(8, Math.max(1, count | 0));
  probes.length = n;
  for (const [serial, name] of names.slice(0, n)) state.names[serial] ??= name;
  app.addDevice({
    id: 'demo-display', name: 'Demo Display', simulated: true,
    open: async () => new SimNodeConnection({ serial: 'DEMODISPLY', probes, hops: 1 }),
    identify: async () => ({ serial: 'DEMODISPLY', productType: 'display' }),
  });
  toast('Demo mode: simulated probes.');
}

// MARK: Events

$('alerts-button').addEventListener('click', alertsDialog);
$('history-button').addEventListener('click', historyDialog);
$('devices-button').addEventListener('click', devicesDialog);
$('settings-button').addEventListener('click', settingsDialog);
$('kitchen-button').addEventListener('click', () => {
  state.kitchen = true;
  $('kitchen').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  invalidate();
});

window.addEventListener('resize', () => { if (state.kitchen) layoutKitchen(); });

function exitKitchen() {
  state.kitchen = false;
  $('kitchen').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function acknowledgeTop() {
  const a = state.active.find((x) => x.state === 'firing');
  if (a) app.alerts.acknowledge(a.id);
  return !!a;
}

$('kitchen').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="kitchen-exit"]')) return exitKitchen();
  acknowledgeTop();
});
document.addEventListener('keydown', (e) => {
  if (!state.kitchen) return;
  if (e.key === 'Escape') return exitKitchen();
  if (acknowledgeTop()) e.preventDefault();
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action], [data-select], [data-ack], [data-snooze], [data-sensor]');
  if (!t || t.closest('dialog') || t.closest('#kitchen')) return;
  if (t.dataset.sensor) return toggleSensorLine(t);
  if (t.dataset.select) {
    state.selected = t.dataset.select;
    state.scrub = null;
    await reloadSamples();
    return invalidate();
  }
  if (t.dataset.ack) return app.alerts.acknowledge(t.dataset.ack);
  if (t.dataset.snooze) return app.alerts.snooze(t.dataset.snooze, 5 * 60_000);
  switch (t.dataset.action) {
    case 'connect': return connectDevice();
    case 'scan': return toggleScan();
    case 'demo': return startDemo();
    case 'setup': return onboarding.open(ble.capabilities().bluetooth ? 'welcome' : 'bluetooth');
    case 'history': return historyDialog();
    case 'target': return setTargetDialog(state.selected);
    case 'alarms': return alarmsDialog(state.selected);
    case 'export': return exportCsv(t.dataset.key);
    case 'back-live':
      state.viewSession = null;
      state.scrub = null;
      await reloadSamples();
      return invalidate();
    default:
  }
});

// Clock-driven parts (countdowns between statuses, "Now · 13:20", offline durations) refresh every second.
setInterval(invalidate, 1000);
// Live graph data for probes without a log follows the store.
setInterval(() => {
  if (!state.viewSession && !app.history.currentSession(state.selected)) reloadSamples();
}, 5000);

// MARK: Background

const onboarding = new Onboarding({
  el: $('onboarding'),
  connect: () => connectDevice(),
  demo: () => startDemo(),
  notifications,
  testAlert: () => sound.test('ready'),
  onDone: () => {
    prefs.set('onboarded', true);
    try {
      sessionStorage.setItem('colby.setupDismissed', '1');
    } catch {
      /* storage blocked */
    }
    invalidate();
  },
});

/** A cook is under way on a probe that has a live link: closing the tab would stop its alerts. */
const cookAtRisk = () => [...app.store.snapshots().values()].some((s) => !s.isOffline && isCooking(s))
  && [...app.devices.values()].some((d) => d.link && !d.simulated);

const lifecycle = watchLifecycle({
  onHidden: () => notifications.pageHidden(),
  onVisible: () => {
    wake.refresh();
    render();
  },
  // Chrome froze the tab (no events meanwhile): reconnect what dropped.
  onResume: () => onWake('resume'),
});
guardUnload(cookAtRisk);
// Closing, reloading or leaving the page releases every device, so Chrome does not hold a link that hides it from
// the next chooser (backlog F-1).
addEventListener('pagehide', () => {
  for (const device of bleDevices.values()) ble.releaseDevice(device);
});
addEventListener('pageshow', (e) => {
  if (e.persisted) onWake('resume');
});

/**
 * After the computer wakes or the tab unfreezes: drop the links Chrome may still report from before, and reconnect now
 * instead of waiting out the backoff. The reconnect band says so until every device is back.
 */
function onWake(reason) {
  if (![...app.devices.values()].some((d) => !d.simulated)) return;
  state.wake = { reason, at: Date.now() };
  releaseStaleLinks();
  app.reconnectAll();
  renderReconnectBand();
}

// Acknowledge / Snooze pressed on a notification (service worker, sw.js).
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'colby-alert') return;
  if (e.data.action === 'ack') app.alerts.acknowledge(e.data.id);
  else if (e.data.action === 'snooze') app.alerts.snooze(e.data.id, 5 * 60_000);
});
navigator.serviceWorker?.startMessages?.();
navigator.bluetooth?.addEventListener?.('availabilitychanged', (e) => {
  if (!e.value) toast('Bluetooth is off. Turn it on to reconnect.', 8000);
});

// MARK: Start

if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!heartbeat.worker) console.warn('No Web Worker: timers may run late while this tab is in the background.');
if (lifecycle.discarded) toast('The browser closed Colby in the background. Reconnect your devices.', 10000);

// Reconnect devices this origin was allowed before (needs the getDevices flag).
const remembered = prefs.get('devices', []);
if (remembered.length) {
  for (const device of await ble.knownDevices()) {
    if (remembered.some((d) => d.id === device.id)) addBleDevice(device);
  }
}
const demoHash = /^#demo(?:=([1-8]))?$/.exec(location.hash);
if (demoHash) startDemo(demoHash[1] ? +demoHash[1] : 2);
render();

// Setup on the first load, and again while Bluetooth cannot be used and nothing is set up (once per browser session).
let setupDismissed = false;
try {
  setupDismissed = sessionStorage.getItem('colby.setupDismissed') === '1';
} catch {
  /* storage blocked */
}
// On a phone or tablet the first screen points to the official Combustion app instead.
const bt = await bluetoothStatus();
const firstStep = (step) => (mobilePlatform() ? 'mobile' : step);
if (location.hash === '#setup') onboarding.open('welcome');
else if (!prefs.get('onboarded', false) && !demoHash) onboarding.open(firstStep('welcome'));
else if (bt !== 'ready' && app.devices.size === 0 && !setupDismissed) onboarding.open(firstStep('bluetooth'));
