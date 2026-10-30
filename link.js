// First http(s) link in a piece of text, without trailing punctuation.
export function extractUrl(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[.,;:!?)\]}]+$/, '') : null;
}

// From the async clipboard's ClipboardItem list, picks what to load: the first
// image/video as a File, else the first text containing a link. null if neither.
export async function pickClipboardContent(items) {
  for (const item of items) {
    const type = item.types.find((t) => /^(image|video)\//.test(t));
    if (type) return { file: new File([await item.getType(type)], 'pasted', { type }) };
  }
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue;
    const text = await (await item.getType('text/plain')).text();
    if (extractUrl(text)) return { text };
  }
  return null;
}

// What to fetch for something the user typed or pasted: Giphy page links become
// the direct GIF, bare domains get https://, everything else is used as given.
export function normalizeUrl(raw) {
  const u = String(raw ?? '').trim();
  const g = u.match(/giphy\.com\/(?:gifs|stickers)\/(?:[^/?#]*-)?([A-Za-z0-9]+)/);
  if (g) return `https://i.giphy.com/${g[1]}.gif`;
  if (!/^https?:\/\//i.test(u) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(u)) return `https://${u}`;
  return u;
}
