import { SERVICE, CMD_CHAR, NOTIFY_CHAR, UPLOAD_CHAR, AES_KEY } from './config.js';

const enc = new TextEncoder();
const ZERO_IV = new Uint8Array(16);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MaskClient {
  constructor(log = () => {}) {
    this.log = log;
    this.device = null;
    this.cmdChar = null;
    this.uploadChar = null;
    this.inbox = [];
    this.waiters = [];
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  async connect() {
    if (this.connected) return;
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available (use Chrome on Android over HTTPS)');
    this.device ??= await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }, { namePrefix: 'MASK' }],
      optionalServices: [SERVICE],
    });
    this.log(`Connecting to ${this.device.name ?? 'mask'}...`);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.cmdChar = await service.getCharacteristic(CMD_CHAR);
    this.uploadChar = await service.getCharacteristic(UPLOAD_CHAR);
    const notify = await service.getCharacteristic(NOTIFY_CHAR);
    notify.addEventListener('characteristicvaluechanged', (ev) => this.onNotify(ev));
    await notify.startNotifications();
    this.log('Connected');
  }

  disconnect() {
    if (this.connected) this.device.gatt.disconnect();
    this.log('Disconnected');
  }

  async onNotify(ev) {
    const dv = ev.target.value;
    const raw = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    if (raw.length !== 16) return;
    const p = await decryptBlock(raw);
    this.inbox.push(String.fromCharCode(...p.slice(1, 1 + p[0])));
    this.flush();
  }

  flush() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex((m) => m.startsWith(w.prefix));
      if (i < 0) continue;
      this.inbox.splice(i, 1);
      clearTimeout(w.timer);
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve();
    }
  }

  waitFor(prefix, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const w = { prefix, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`Timed out waiting for ${prefix}`));
      }, timeout);
      this.waiters.push(w);
      this.flush();
    });
  }

  async cmd(name, args = []) {
    await this.cmdChar.writeValueWithResponse(await encryptBlock(buildCmd(name, args)));
  }

  setLight(level) {
    return this.cmd('LIGHT', [level]);
  }

  // Plays up to 10 DIY slots in order, looping.
  play(slots) {
    return this.cmd('PLAY', [slots.length, ...slots]);
  }

  async uploadImage(slot, rgb, onProgress = () => {}) {
    const total = rgb.length;
    this.inbox.length = 0;
    await this.cmd('DATS', [total >> 8, total & 255, slot >> 8, slot & 255, 1]);
    await this.waitFor('DATSOK');

    let counter = 0;
    for (let off = 0; off < total; off += 98) {
      const chunk = rgb.subarray(off, off + 98);
      const pkt = new Uint8Array(100);
      pkt[0] = chunk.length + 1;
      pkt[1] = counter++ & 255;
      pkt.set(chunk, 2);
      this.inbox.length = 0;
      await this.uploadChar.writeValueWithoutResponse(pkt);
      // Not every firmware acks each packet; fall back to a short pause.
      await this.waitFor('REOK', 1000).catch(() => sleep(100));
      onProgress(Math.min(1, (off + 98) / total));
    }

    const t = Math.floor(Date.now() / 1000);
    await this.cmd('DATCP', [(t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255]);
    await this.waitFor('DATCPOK');
  }
}
