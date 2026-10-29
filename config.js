export const APP_VERSION = 'v4.1';

// Tunables. Decoding the Bishop Fox face data shows the mask expects 46x58
// pixels sent column by column (each column top to bottom, left column first).
export const WIDTH = 46;
export const HEIGHT = 58;
export const ORDER = 'cols';   // 'rows' = row-major, 'cols' = column-major
export const FLIP_X = false;
export const FLIP_Y = false;

// First row below the eye holes; "Below the eyes" mode fits the image under it.
export const EYE_LINE_Y = 20;

export const MAX_FRAMES = 10;  // PLAY takes at most 10 slot ids
export const SLOT_START = 1;   // first DIY slot used; frames go to SLOT_START..SLOT_START+n-1

// Masks advertise as MASK-xxxxxx. The chooser only lists names with this prefix,
// so unrelated BLE gear (speakers etc.) never shows up. "Scan all" bypasses it.
export const NAME_PREFIX = 'MASK-';

export const SERVICE ='0000fff0-0000-1000-8000-00805f9b34fb';
export const CMD_CHAR = 'd44bc439-abfd-45a2-b575-925416129600';
export const NOTIFY_CHAR = 'd44bc439-abfd-45a2-b575-925416129601';
export const UPLOAD_CHAR = 'd44bc439-abfd-45a2-b575-92541612960a';

export const AES_KEY = new Uint8Array([
  0x32, 0x67, 0x2f, 0x79, 0x74, 0xad, 0x43, 0x45,
  0x1d, 0x9c, 0x6c, 0x89, 0x4a, 0x0e, 0x87, 0x64,
]);
