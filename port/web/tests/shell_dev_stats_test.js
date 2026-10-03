'use strict';

/* The developer network panel (Ctrl+Shift+L): per-peer round trip, path,
   bytes per channel and loss from the transport and RTCPeerConnection
   .getStats, and the netcode's counters from the game, sampled once a
   second only while the overlay is open. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const onlineClient = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const transportLibrary = fs.readFileSync(path.join(webDirectory, 'library_web_transport.js'), 'utf8');
const webOnlineUiHeader = fs.readFileSync(
  path.join(webDirectory, 'src', 'web_online_ui.h'), 'utf8');
const webOnlineUi = fs.readFileSync(path.join(webDirectory, 'src', 'web_online_ui.c'), 'utf8');

/* ---- markup: inside the hidden overlay, nothing shown until toggled */
const overlay = shell.match(/<section id="diagnostics-overlay"[\s\S]*?<\/section>/);
assert(overlay, 'missing diagnostics overlay');
assert.match(overlay[0], /<section id="diagnostics-overlay"[^>]*\bhidden>/,
  'the overlay stays hidden until toggled');
assert.match(overlay[0], /id="diagnostics-network"/);
assert.match(overlay[0], /<tbody id="net-peer-rows"><\/tbody>/);
['net-summary', 'net-ticks', 'net-distributed', 'net-items', 'net-damage'].forEach(id => {
  assert.match(overlay[0], new RegExp(`id="${id}"`), `missing ${id}`);
});
assert.match(shell, /#diagnostics-overlay \{[\s\S]*?grid-template-rows: auto auto auto minmax\(0, 1fr\) auto;/,
  'the overlay grid needs a row for the network panel');

/* ---- sampling: one hertz, started by the toggle, stopped with it or the tab */
assert.match(shell, /const NET_SAMPLE_INTERVAL = 1000;/);
assert.match(shell, /function setDiagnosticsOpen\(open\) \{[\s\S]*?setNetworkSampling\(open && !document\.hidden\);/,
  'opening the overlay must start sampling and closing it must stop');
assert.match(shell, /addEventListener\("visibilitychange"[\s\S]*?setNetworkSampling\(!diagnosticsOverlay\.hidden && !document\.hidden\);/,
  'a hidden tab must pause sampling');
assert.match(shell, /function setNetworkSampling\(on\) \{[\s\S]*?window\.clearInterval\(netSampleTimer\);[\s\S]*?window\.setInterval\(sampleNetwork, NET_SAMPLE_INTERVAL\);/);

/* ---- the game's counters: one getter, indices in step with the C enum */
assert.match(webOnlineUi, /EMSCRIPTEN_KEEPALIVE int platform_web_net_statistic\(int index\)/);
assert.match(webOnlineUi, /publish_net_statistics\(\);\n#endif/,
  'the game thread publishes the counters once a frame');
assert.match(webOnlineUi, /game_time_initialized\(\) \? game_time_get\(\) : -1/,
  'game time must not be read before the clock exists');
const enumSource = webOnlineUiHeader.match(/enum web_net_statistic\n\{([\s\S]*?)\};/);
assert(enumSource, 'missing enum web_net_statistic');
const enumNames = Array.from(enumSource[1].matchAll(/^\s*_web_net_statistic_(\w+)/gm), m => m[1])
  .filter(name => name !== 'count');
const tableSource = shell.match(/const NET_STATISTIC = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert(tableSource, 'missing NET_STATISTIC');
const table = Function(`return {${tableSource[1]}};`)();
const toCamel = name => name.replace(/_(\w)/g, (_, c) => c.toUpperCase());
assert.deepEqual(Object.keys(table).sort((a, b) => table[a] - table[b]), enumNames.map(toCamel),
  'NET_STATISTIC must list enum web_net_statistic in order');
assert.deepEqual(Object.values(table), enumNames.map((_, index) => index));

/* ---- the page's sources */
assert.match(onlineClient, /diagnostics: function\(\) \{/, 'HaloOnline.diagnostics names the peers');
assert.match(transportLibrary, /listPeers: function\(\) \{[\s\S]*?sendRefusals: record\.sendRefusals,[\s\S]*?reliable: \{[\s\S]*?unreliable: \{/,
  'listPeers must report each channel');

/* ---- run the panel against fakes */
function fakeElement(tag) {
  return {
    tag, textContent: '', title: '', className: '', dataset: {}, children: [], parent: null,
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); },
  };
}
const elements = {};
['net-summary', 'net-peer-rows', 'net-ticks', 'net-distributed', 'net-items', 'net-damage']
  .forEach(id => { elements[id] = fakeElement(id); });
let clock = 0;
const timers = [];
const fakeWindow = {
  setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
  clearInterval(id) { if (id) timers[id - 1] = null; },
};
const fakeDocument = {
  hidden: false,
  getElementById: id => elements[id],
  createElement: fakeElement,
};
let gameTime = -1;
const counters = { sent: 0, received: 0, corrections: 0 };
const fakeModule = {
  _platform_web_net_statistic(index) {
    if (index === table.gameTime) return gameTime;
    if (index === table.distributedSent) return counters.sent;
    if (index === table.distributedReceived) return counters.received;
    if (index === table.distributedCorrections) return counters.corrections;
    return 0;
  },
};
const peer = {
  peerId: 'g_0123456789abcdef', address: '100.64.0.1', state: 'connected',
  droppedDatagrams: 0, sendRefusals: 0,
  reliable: { bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0, queuedBytes: 0, bufferedAmount: 0 },
  unreliable: { bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0, queuedBytes: 0, bufferedAmount: 0 },
};
let rtt = 0.040;
let requests = 0;
let responses = 0;
function chromeReports() {
  return new Map(Object.entries({
    T1: { type: 'transport', selectedCandidatePairId: 'CP1' },
    CP1: { type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded',
      currentRoundTripTime: rtt, totalRoundTripTime: 1.2, responsesReceived: responses, requestsSent: requests },
    L1: { type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
    R1: { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
  }));
}
fakeWindow.HaloWebTransport = {
  listPeers: () => [peer],
  getStats: async () => chromeReports(),
};
fakeWindow.HaloOnline = {
  diagnostics: () => ({
    active: true, role: 'guest', publicLobby: true, connectionPath: 'relay',
    peers: [{ peerId: peer.peerId, name: 'Hostess', role: 'host', spectator: false, state: 'connected' }],
  }),
};

const panelSource = shell.match(/const NET_SAMPLE_INTERVAL = 1000;[\s\S]*?\n    \}\n\n    function updatePerformance\(\)/);
assert(panelSource, 'missing network panel source');
const formatBytesSource = shell.match(/function formatBytes\(value\) \{[\s\S]*?\n    \}/);
assert(formatBytesSource, 'missing formatBytes');
const panel = Function('document', 'window', 'Module', 'performance',
  `${formatBytesSource[0]}\n${panelSource[0].replace(/\n\n    function updatePerformance\(\)$/, '')}\n` +
  'return { summarizeCandidatePair, sparkline, jitterOf, formatRate, sampleNetwork, setNetworkSampling, netPeers };')(
  fakeDocument, fakeWindow, fakeModule, { now: () => clock });

/* pure helpers */
const firefoxReports = new Map(Object.entries({
  CP1: { type: 'candidate-pair', selected: true, localCandidateId: 'L1', remoteCandidateId: 'R1',
    currentRoundTripTime: 0.012 },
  L1: { type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
  R1: { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
}));
assert.deepEqual(panel.summarizeCandidatePair(firefoxReports), {
  path: 'direct', protocol: 'udp', localType: 'host', remoteType: 'host',
  rtt: 12, averageRtt: null, requestsSent: null, responsesReceived: null,
  bytesSent: null, bytesReceived: null, availableOutgoingBitrate: null,
});
requests = 10; responses = 10;
const chrome = panel.summarizeCandidatePair(chromeReports());
assert.equal(chrome.path, 'relay');
assert.equal(chrome.protocol, 'tcp', 'a relay shows the protocol to the TURN server');
assert.equal(chrome.rtt, 40);
assert.equal(chrome.averageRtt, 120);
assert.equal(panel.summarizeCandidatePair(new Map()), null);
assert.equal(panel.sparkline([1, 2, 3, null, 4, 8]), '▁▂▃▄█', 'scaled between lowest and highest, gaps skipped');
assert.equal(panel.sparkline([5, 5]), '▁▁');
assert.equal(panel.sparkline([]), '');
assert.equal(panel.sparkline(Array.from({ length: 100 }, (_, i) => i), 60).length, 60);
assert.equal(panel.jitterOf([10, 14, 10, null, 30]), 4, 'a gap splits the series');
assert.equal(panel.jitterOf([10]), null);
assert.equal(panel.formatRate(0), '0 B/s');
assert.equal(panel.formatRate(1536), '1.5 kB/s');
assert.equal(panel.formatRate(2.5e6), '2.50 MB/s');
assert.equal(panel.formatRate(NaN), '—');

/* the sampler: rows, rates, loss, game clock */
(async () => {
  panel.setNetworkSampling(true);
  assert.equal(timers.filter(Boolean).length, 1);
  assert.equal(timers[0].ms, 1000);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(elements['net-peer-rows'].children.length, 1);
  const row = elements['net-peer-rows'].children[0];
  const cell = name => row.children.find(c => c.className === `net-${name}`);
  assert.equal(cell('peer').textContent, 'Hostess · host\nconnected · 100.64.0.1');
  assert.equal(row.dataset.path, 'relay');
  assert.match(cell('path').textContent, /^relay tcp\nrelay → srflx$/);
  assert.equal(cell('rtt').textContent, '40 ms');
  assert.equal(cell('in').textContent, '— / —\n0 B / 0 B', 'no rate before a second sample');
  assert.equal(elements['net-summary'].textContent, 'guest · public · 1/1 connected · relay');
  assert.equal(elements['net-ticks'].textContent, 'No game running');

  clock = 1000;
  gameTime = 300; counters.sent = 10; counters.corrections = 1;
  peer.reliable.bytesIn = 2000; peer.unreliable.bytesIn = 500; peer.unreliable.bytesOut = 3000;
  peer.droppedDatagrams = 2; peer.sendRefusals = 1;
  rtt = 0.060; requests = 20; responses = 18;
  await timers[0].fn();
  assert.equal(cell('rtt').textContent, '60 ms');
  assert.equal(cell('range').textContent, '40 ms / 50 ms / 60 ms');
  assert.equal(cell('jitter').textContent, '20 ms');
  assert.equal(cell('spark').textContent, '▁█');
  assert.equal(cell('in').textContent, '2.0 kB/s / 500 B/s\n2 KB / 500 B');
  assert.equal(cell('out').textContent, '0 B/s / 3.0 kB/s\n0 B / 3 KB');
  assert.equal(cell('loss').textContent, 'drops 2 (2.0/s) · refused 1\nprobe loss 20.0%');
  assert.equal(elements['net-ticks'].textContent, 'tick 300');
  assert.equal(elements['net-distributed'].textContent,
    'sent 10 (10.0/s) · received 0 (0.0/s) · corrections 1 (1.0/s)');

  clock = 2000; gameTime = 329;
  await timers[0].fn();
  assert.equal(elements['net-ticks'].textContent, 'tick 329 · 29.0 ticks/s · drift -3.3% over 1 s');

  /* the peer leaves: its row goes; the overlay closes: the timer stops */
  fakeWindow.HaloWebTransport.listPeers = () => [];
  clock = 3000;
  await timers[0].fn();
  assert.equal(elements['net-peer-rows'].children.length, 0);
  assert.equal(panel.netPeers.size, 0);
  assert.equal(elements['net-summary'].textContent, 'guest · public · 0/0 connected · relay');
  panel.setNetworkSampling(false);
  assert.equal(timers.filter(Boolean).length, 0);
  fakeWindow.HaloWebTransport.listPeers = () => [peer];
  await panel.sampleNetwork();
  assert.equal(elements['net-peer-rows'].children.length, 0, 'nothing is sampled while closed');

  console.log('shell developer network panel tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
