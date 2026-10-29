// First http(s) link in a piece of text, without trailing punctuation.
export function extractUrl(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[.,;:!?)\]}]+$/, '') : null;
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
