// fonts.js — the TrueType fonts a Win32 image names (`machine.fonts`), found in the page before it
// starts: MIRAGE ships no Windows font. The visitor's own copy first — Chrome's Local Font Access API
// (window.queryLocalFonts) reads an installed font's file, after asking; macOS and Windows install
// Tahoma — else DejaVu Sans, a free font, from jsDelivr: the text is then not the font the program asked
// for, in another shape and width, but it is there.

const DEJAVU = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';

/**
 * `families` (["Tahoma"]) as win32Apis's `fonts`: { "tahoma": bytes, "tahoma:bold": bytes }. `say(text)`
 * tells which font each one is.
 */
export async function pageFonts(families, say = () => {}) {
  const out = {};
  for (const family of families) {
    const ps = family.replace(/\s+/g, ''), key = family.toLowerCase();
    const wanted = [[key, ps, 'DejaVuSans.ttf'], [`${key}:bold`, `${ps}-Bold`, 'DejaVuSans-Bold.ttf']];
    let local = [];
    try {
      if (typeof window !== 'undefined' && window.queryLocalFonts) local = await window.queryLocalFonts({ postscriptNames: wanted.map((w) => w[1]) });
    } catch (e) { say(`fonts: ${family} from this computer: ${e.message || e}`); }
    for (const [k, name, free] of wanted) {
      const f = local.find((l) => l.postscriptName === name);
      if (f) { out[k] = new Uint8Array(await (await f.blob()).arrayBuffer()); say(`fonts: ${name}, this computer's`); continue; }
      try {
        out[k] = new Uint8Array(await (await fetch(DEJAVU + free)).arrayBuffer());
        say(`fonts: ${name} is not here; ${free.replace('.ttf', '')} in its place`);
      } catch (e) { say(`fonts: no ${name}, and ${free}: ${e.message || e}`); }
    }
  }
  return out;
}
