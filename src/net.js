// P2P networking via Trystero: WebRTC data channels, signaling over public
// MQTT brokers — no game server anywhere. (Switched from the Nostr strategy:
// volunteer Nostr relays proved flaky — some ack publishes but never forward
// the ephemeral SDP events, silently killing the WebRTC handshake. The MQTT
// brokers are commercially operated and reliable.)
//
// Trystero 0.25 API: makeAction(name, {onMessage}) returns {send}, and
// onPeerJoin/onPeerLeave are assignable properties on the room.
import { joinRoom, selfId } from '@trystero-p2p/mqtt';

export { selfId };

const APP_ID = 'driftamania-v1';

export class Net {
  // handlers: { onPeers, onState(id, state), onRace(msg, fromId), onFin(fin, id) }
  constructor(code, profile, handlers) {
    this.code = code;
    this.profile = profile;
    this.handlers = handlers;
    this.peers = new Map(); // id -> { profile, state, stateAt }

    // STUN diversity helps NAT traversal. KNOWN GAP: peers behind the SAME
    // NAT (e.g. two tabs on one machine) often can't connect — Chrome masks
    // host candidates behind mDNS (.local) which may not resolve, and
    // reflexive candidates need router hairpinning. The fix is a TURN relay
    // (needs credentials — e.g. a Cloudflare or metered.ca key); free
    // anonymous TURN services no longer exist.
    this.room = joinRoom({
      appId: APP_ID,
      rtcConfig: {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        ],
      },
    }, code);

    const profileAction = this.room.makeAction('profile', {
      onMessage: (data, { peerId }) => {
        const p = this.peers.get(peerId) ?? { state: null, stateAt: 0 };
        p.profile = data;
        this.peers.set(peerId, p);
        handlers.onPeers?.();
      },
    });
    const stateAction = this.room.makeAction('state', {
      onMessage: (data, { peerId }) => {
        const p = this.peers.get(peerId);
        if (!p) return;
        p.state = data;
        p.stateAt = performance.now();
        handlers.onState?.(peerId, data);
      },
    });
    const raceAction = this.room.makeAction('race', {
      onMessage: (data, { peerId }) => {
        // Only honor race-control messages from the elected host.
        if (peerId === this.hostId) handlers.onRace?.(data, peerId);
      },
    });
    const finAction = this.room.makeAction('fin', {
      onMessage: (data, { peerId }) => handlers.onFin?.(data, peerId),
    });
    const pickupAction = this.room.makeAction('pickup', {
      onMessage: (data, { peerId }) => handlers.onPickup?.(data, peerId),
    });

    this.sendState = (data) => stateAction.send(data).catch(() => {});
    this.sendRace = (data) => raceAction.send(data).catch(() => {});
    this.sendFin = (data) => finAction.send(data).catch(() => {});
    this.sendPickup = (data) => pickupAction.send(data).catch(() => {});
    this._sendProfile = (data, target) =>
      profileAction.send(data, target ? { target } : undefined).catch(() => {});

    this.room.onPeerJoin = (id) => {
      this.peers.set(id, { profile: null, state: null, stateAt: 0 });
      this._sendProfile(this.profile, id); // introduce ourselves to the newcomer
      handlers.onPeers?.();
    };
    this.room.onPeerLeave = (id) => {
      this.peers.delete(id);
      handlers.onPeers?.();
    };
  }

  // Deterministic host election: everyone agrees on the lowest peer id.
  get hostId() {
    let min = selfId;
    for (const id of this.peers.keys()) if (id < min) min = id;
    return min;
  }

  get isHost() {
    return this.hostId === selfId;
  }

  updateProfile(profile) {
    this.profile = profile;
    this._sendProfile(profile);
  }

  leave() {
    this.room.leave().catch(() => {});
  }
}

export function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no ambiguous glyphs
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
