'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let library;
global.addToLibrary = value => { library = value; };
vm.runInThisContext(fs.readFileSync(
  require('node:path').join(__dirname, '..', 'library_web_transport.js'), 'utf8'));
assert(library && library.$HaloWebTransportRuntime);

global.window = global;
global.HEAPU8 = new Uint8Array(65536);
const localIdentifierPointer = 32;
const ingressPointer = 64;
HEAPU8.set([2, 0, 0, 0, 0, 1], localIdentifierPointer);

const calls = { states: [], received: [], removed: [] };
global.Module = {
  _web_net_remote_local_identifier: () => localIdentifierPointer,
  _web_net_remote_ingress_buffer: () => ingressPointer,
  _web_net_remote_ingress_capacity: () => 16396,
  _web_net_remote_add_peer: () => 0x01004064,
  _web_net_remote_remove_peer: address => {
    calls.removed.push(address >>> 0);
    return 1;
  },
  _web_net_remote_set_peer_state: (address, connected, reliable, unreliable) => {
    calls.states.push([address >>> 0, connected, reliable, unreliable]);
    return 1;
  },
  _web_net_remote_receive: (address, length) => {
    calls.received.push([address >>> 0, HEAPU8.slice(ingressPointer, ingressPointer + length)]);
    return 1;
  },
};

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.ordered = options.ordered !== undefined ? options.ordered : true;
    this.maxRetransmits = options.maxRetransmits !== undefined ? options.maxRetransmits : null;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.sent = [];
  }
  send(value) { this.sent.push(new Uint8Array(value)); }
  close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); }
  open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
}

class FakePeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.channels = [];
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
  }
  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  async setLocalDescription(description) {
    this.localDescription = description || {
      type: this.remoteDescription && this.remoteDescription.type === 'offer' ? 'answer' : 'offer',
      sdp: 'test',
      toJSON() { return { type: this.type, sdp: this.sdp }; },
    };
  }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate() {}
  restartIce() {}
  close() { this.connectionState = 'closed'; }
  async getStats() { return new Map(); }
}
global.RTCPeerConnection = FakePeerConnection;

global.HaloWebTransportRuntime = library.$HaloWebTransportRuntime;
HaloWebTransportRuntime.install();

(async () => {
  const signals = [];
  const states = [];
  HaloWebTransport.configure({
    iceServers: [{ urls: 'stun:test.invalid' }],
    onSignal: event => signals.push(event),
    onStateChange: event => states.push(event),
  });
  assert.equal(HaloWebTransport.getLocalIdentifier(), '020000000001');
  const peer = await HaloWebTransport.addPeer({
    peerId: 'friend',
    remoteIdentifier: '020000000002',
    initiator: true,
  });
  assert.deepEqual(peer, {
    peerId: 'friend',
    address: '100.64.0.1',
    remoteIdentifier: '020000000002',
  });
  const record = HaloWebTransportRuntime.peersById.get('friend');
  assert.equal(record.reliable.label, 'halo-reliable-v1');
  assert.equal(record.reliable.ordered, true);
  assert.equal(record.reliable.maxRetransmits, null);
  assert.equal(record.unreliable.label, 'halo-unreliable-v1');
  assert.equal(record.unreliable.ordered, false);
  assert.equal(record.unreliable.maxRetransmits, 0);
  await assert.rejects(HaloWebTransport.addPeer({
    peerId: 'duplicate-address',
    remoteIdentifier: '020000000003',
    initiator: true,
  }), /virtual peer address is already in use/);

  await record.pc.onnegotiationneeded();
  await Promise.resolve();
  assert.equal(signals[0].peerId, 'friend');
  assert.equal(signals[0].signal.description.type, 'offer');

  record.reliable.open();
  record.unreliable.open();
  assert(calls.states.some(state => state.slice(1).join(',') === '1,1,1'));
  assert(states.some(state => state.state === 'connected'));

  const outbound = new Uint8Array(12);
  outbound[0] = 0x48;
  HEAPU8.set(outbound, 512);
  assert.equal(library.web_transport_send(0x01004064, 1, 512, outbound.length), 1);
  assert.equal(record.reliable.sent.length, 1);

  const inbound = new Uint8Array(12);
  inbound[0] = 0x48;
  record.unreliable.onmessage({ data: inbound.buffer });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.received.length, 1);

  record.reliable.bufferedAmount = HaloWebTransportRuntime.RELIABLE_HIGH_WATER + 1;
  assert.equal(library.web_transport_send(0x01004064, 1, 512, outbound.length), 0);

  /* the developer panel's counters: frames and bytes each way per channel */
  const listed = HaloWebTransport.listPeers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].peerId, 'friend');
  assert.equal(listed[0].state, 'connected');
  assert.equal(listed[0].droppedDatagrams, 0);
  assert.equal(listed[0].sendRefusals, 1, 'a send over the high-water mark is counted');
  assert.deepEqual(listed[0].reliable, {
    bytesIn: 0, bytesOut: 12, packetsIn: 0, packetsOut: 1, queuedBytes: 0,
    bufferedAmount: HaloWebTransportRuntime.RELIABLE_HIGH_WATER + 1,
  });
  assert.deepEqual(listed[0].unreliable, {
    bytesIn: 12, bytesOut: 0, packetsIn: 1, packetsOut: 0, queuedBytes: 0, bufferedAmount: 0,
  });
  for (let index = 0; index <= HaloWebTransportRuntime.UNRELIABLE_PACKET_LIMIT; index++) {
    record.unreliable.onmessage({ data: inbound.buffer });
  }
  const flooded = HaloWebTransport.listPeers()[0];
  assert(flooded.droppedDatagrams >= 1, 'an overfull unreliable queue drops and counts');
  assert.equal(flooded.unreliable.packetsIn, 2 + HaloWebTransportRuntime.UNRELIABLE_PACKET_LIMIT,
    'dropped frames still count as received');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(HaloWebTransport.removePeer('friend'), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls.removed, [0x01004064]);
  console.log('library_web_transport tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
