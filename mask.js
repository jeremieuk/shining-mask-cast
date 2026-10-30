import { SERVICE, CMD_CHAR, NOTIFY_CHAR, UPLOAD_CHAR, AES_KEY, NAME_PREFIX } from './config.js';

const enc = new TextEncoder();
const ZERO_IV = new Uint8Array(16);
const VERIFY_TIMEOUT = 2000;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STALL_MISSES = 2; // consecutive missing packet acks (about 1 s each) before giving up

// Thrown when a connected device turns out not to be a Shining mask.
export class NotMaskError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NotMaskError';
  }
}

// The device is a mask (named MASK-..., right service and characteristics) but it
// connects and then never answers: its processor has most likely hung.
export class MaskNotRespondingError extends Error {
  constructor(name) {
    super(`Connected to ${name || 'the mask'}, but it isn't answering. It may have hung after an interrupted upload. ` +
      'Switch it off for a minute (or put it on a charger for a minute), switch it on and try again. Only a status query was sent.');
    this.name = 'MaskNotRespondingError';
    this.userFacing = true; // the message already says what to do
  }
}

// The mask stopped acknowledging an upload part-way through, or disconnected.
export class MaskStalledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaskStalledError';
    this.userFacing = true;
  }
}

// Web Crypto has no ECB, so single 16-byte blocks go through CBC with a zero IV.
let keyPromise;
const getKey = () =>
  (keyPromise ??= crypto.subtle.importKey('raw', AES_KEY, 'AES-CBC', false, ['encrypt', 'decrypt']));

async function encryptBlock(block) {
  const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, await getKey(), block);
  return new Uint8Array(out).slice(0, 16);
}

async function decryptBlock(block) {
  const key = await getKey();
  // Forge the PKCS7 padding block so Web Crypto will decrypt a bare 16-byte block.
  const pad = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: block }, key, new Uint8Array(16).fill(16));
  const full = new Uint8Array(32);
  full.set(block);
  full.set(new Uint8Array(pad).slice(0, 16), 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, full));
}

// [len][ASCII name][args], zero padded to 16 bytes.
function buildCmd(name, args = []) {
  const body = [...enc.encode(name), ...args];
  if (body.length > 15) throw new Error(`Command ${name} too long`);
  const buf = new Uint8Array(16);
  buf[0] = body.length;
  buf.set(body, 1);
  return buf;
}

const PROPS = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate'];
const propNames = (p) => PROPS.filter((k) => p[k]);

export class MaskClient {
  constructor({ trace = () => {}, onState = () => {} } = {}) {
    this.trace = trace;   // trace(direction, text): feeds the diagnostics log
    this.onState = onState;
    this.device = null;
    this.known = false;    // this device passed verification at least once
    this.verified = false; // currently connected AND verified
    this.cmdChar = null;
    this.uploadChar = null;
    this.inbox = [];
    this.waiters = [];
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  get ready() {
    return this.verified && this.connected;
  }

  // Shows the chooser (names starting with NAME_PREFIX only, or everything for
  // acceptAll), then connects and verifies. Nothing is written before verify passes.
  async connect({ acceptAll = false } = {}) {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available (use Chrome on Android over HTTPS)');
    if (!acceptAll && this.known) return this.ensureConnected();
    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE] };
    const device = await navigator.bluetooth.requestDevice(options);
    this.trace('i', `Chosen: ${device.name ?? '(no name)'} [${device.id}]`);
    this.setDevice(device);
    await this.openAndVerify();
  }

  // Reconnects to the already-verified mask without a chooser.
  async ensureConnected() {
    if (this.ready) return;
    if (!this.known) throw new Error('No verified mask yet. Tap Connect first.');
    await this.openAndVerify();
  }

  setDevice(device) {
    this.device?.removeEventListener('gattserverdisconnected', this.onDisc);
    this.device = device;
    this.known = false;
    this.verified = false;
    device.addEventListener('gattserverdisconnected', this.onDisc);
  }

  onDisc = () => {
    this.verified = false;
    this.trace('i', 'Disconnected');
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('Mask disconnected'));
    }
    this.onState();
  };

  disconnect() {
    if (this.connected) this.device.gatt.disconnect();
    this.verified = false;
    this.onState();
  }

  async openAndVerify() {
    this.verified = false;
    try {
      await this.verify();
      this.verified = true;
      this.known = true;
      this.trace('i', `Verified mask ${this.device.name ?? ''}`);
    } catch (e) {
      if (e instanceof NotMaskError) this.known = false;
      this.disconnect();
      throw e;
    } finally {
      this.onState();
    }
  }

  async describeGatt(server) {
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      this.trace('gatt', `could not list services: ${e.name}`);
    }
    if (!services.length) this.trace('gatt', 'no accessible services');
    for (const s of services) {
      let chars = [];
      try {
        chars = await s.getCharacteristics();
      } catch { /* ignore */ }
      this.trace('gatt', `${s.uuid}${chars.length ? '' : ' (no characteristics)'}`);
      for (const c of chars) this.trace('gatt', `  ${c.uuid} [${propNames(c.properties).join(',')}]`);
    }
  }

  // Proves the device is a Shining mask before anything is sent to it:
  // service + the three vendor characteristics must exist, and it must answer a
  // read-only CHEC query with a frame that decrypts with the mask key.
  async verify() {
    this.trace('i', 'Connecting GATT...');
    const server = await this.device.gatt.connect();
    await this.describeGatt(server);

    let service;
    try {
      service = await server.getPrimaryService(SERVICE);
    } catch {
      throw new NotMaskError(`service ${SERVICE.slice(4, 8)} not found`);
    }
    const get = async (uuid, label, prop) => {
      let c;
      try {
        c = await service.getCharacteristic(uuid);
      } catch {
        throw new NotMaskError(`${label} characteristic missing`);
      }
      if (!c.properties[prop]) throw new NotMaskError(`${label} characteristic lacks ${prop}`);
      return c;
    };
    const cmdChar = await get(CMD_CHAR, 'command', 'write');
    const notify = await get(NOTIFY_CHAR, 'notify', 'notify');
    const uploadChar = await get(UPLOAD_CHAR, 'upload', 'writeWithoutResponse');

    notify.addEventListener('characteristicvaluechanged', (ev) => this.onNotify(ev));
    await notify.startNotifications();
    this.cmdChar = cmdChar;
    this.uploadChar = uploadChar;
    this.inbox.length = 0;
    await this.cmd('CHEC');
    try {
      await this.waitFor('', VERIFY_TIMEOUT);
    } catch {
      // The service and all three vendor characteristics exist. A device named MASK-...
      // is a mask that isn't answering; anything else just doesn't speak the protocol.
      if (this.device.name?.startsWith(NAME_PREFIX)) throw new MaskNotRespondingError(this.device.name);
      throw new NotMaskError('no valid reply to the CHEC query (device does not speak the mask protocol)');
    }
  }

  async onNotify(ev) {
    const dv = ev.target.value;
    const raw = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    if (raw.length !== 16) {
      this.trace('←', `unexpected ${raw.length}-byte notification: ${hex(raw)}`);
      return;
    }
    const p = await decryptBlock(raw);
    // A real frame is [len 1..15][printable ASCII ...]; anything else is noise.
    const plausible = p[0] >= 1 && p[0] <= 15 && p[1] >= 0x20 && p[1] <= 0x7e;
    const text = String.fromCharCode(...p.slice(1, 1 + p[0]));
    this.trace('←', `${hex(raw)} => ${hex(p)} ${plausible ? JSON.stringify(text) : '(not a valid frame)'}`);
    if (!plausible) return;
    this.inbox.push(text);
    this.flush();
  }

  removeWaiter(w) {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  flush() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex((m) => m.startsWith(w.prefix));
      if (i < 0) continue;
      this.inbox.splice(i, 1);
      clearTimeout(w.timer);
      this.removeWaiter(w);
      w.resolve();
    }
  }

  waitFor(prefix, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const w = { prefix, resolve, reject };
      w.timer = setTimeout(() => {
        this.removeWaiter(w);
        reject(new Error(`Timed out waiting for ${prefix || 'any reply'}`));
      }, timeout);
      this.waiters.push(w);
      this.flush();
    });
  }

  async cmd(name, args = []) {
    this.trace('→', `${name}${args.length ? ` ${hex(args)}` : ''}`);
    await this.cmdChar.writeValueWithResponse(await encryptBlock(buildCmd(name, args)));
  }

  setLight(level) {
    return this.cmd('LIGHT', [level]);
  }

  // Plays up to 10 DIY slots in order, looping.
  play(slots) {
    return this.cmd('PLAY', [slots.length, ...slots]);
  }

  // Shows one of the mask's built-in pictures (so no DIY slot is being displayed).
  showBuiltIn(id) {
    return this.cmd('IMAG', [id]);
  }

  // ctx = { frame, frames } only labels error messages ("frame 8 of 10").
  async uploadImage(slot, rgb, onProgress = () => {}, ctx = {}) {
    const total = rgb.length;
    const where = ctx.frame ? ` (frame ${ctx.frame} of ${ctx.frames})` : '';
    const stalled = (what) => new MaskStalledError(
      `${what}${where}. The mask has probably hung. Switch it off for a minute (or put it on a charger for a minute), ` +
      'switch it on and reconnect. Nothing more was sent to it.',
    );
    this.inbox.length = 0;
    await this.cmd('DATS', [total >> 8, total & 255, slot >> 8, slot & 255, 1]);
    await this.waitFor('DATSOK').catch(() => {
      throw stalled(this.connected ? "The mask didn't accept the upload" : 'The mask disconnected');
    });

    const packets = Math.ceil(total / 98);
    let counter = 0;
    let acked = false; // has this mask acknowledged any packet of this upload?
    let misses = 0;
    for (let off = 0; off < total; off += 98) {
      const chunk = rgb.subarray(off, off + 98);
      const pkt = new Uint8Array(100);
      pkt[0] = chunk.length + 1;
      pkt[1] = counter & 255;
      pkt.set(chunk, 2);
      this.inbox.length = 0;
      await this.uploadChar.writeValueWithoutResponse(pkt);
      if (counter % 20 === 0 || counter === packets - 1) this.trace('→', `packet ${counter + 1}/${packets}`);
      counter++;
      try {
        await this.waitFor('REOK', 1000);
        acked = true;
        misses = 0;
      } catch {
        if (!this.connected) throw stalled(`The mask disconnected at packet ${counter} of ${packets}`);
        if (!acked) {
          // A firmware that never acks packets: fall back to a short pause.
          this.trace('i', `no REOK for packet ${counter}, continuing`);
          await sleep(100);
        } else if (++misses >= STALL_MISSES) {
          // It was acking and then went silent: stop instead of pushing more data at it.
          this.trace('i', `no REOK for ${misses} packets in a row, stopping`);
          throw stalled(`The mask stopped answering at packet ${counter} of ${packets}`);
        } else {
          this.trace('i', `no REOK for packet ${counter} (${misses}/${STALL_MISSES})`);
        }
      }
      onProgress(Math.min(1, (off + 98) / total));
    }

    const t = Math.floor(Date.now() / 1000);
    await this.cmd('DATCP', [(t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255]);
    await this.waitFor('DATCPOK').catch((e) => {
      if (acked) throw stalled("The mask didn't confirm the finished upload");
      throw e;
    });
  }
}
