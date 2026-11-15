// fonts.js — the TrueType fonts a Win32 image names (`machine.fonts`), found in the page before it
// starts: MIRAGE ships no Windows font. The visitor's own copy first — Chrome's Local Font Access API
// (window.queryLocalFonts) reads an installed font's file, after asking, by its PostScript name; macOS
// and Windows install Tahoma, Times New Roman, Arial — else a free font from jsDelivr. Arial, Times New
// Roman and Courier New have free faces drawn to their metrics (Arimo, Tinos, Cousine: Apache 2.0), so
// text takes the room it takes on Windows — Storm, the library of Diablo's menus, sizes its dialogs by
// Arial's width, and DejaVu Sans made them larger than the screen. Any other face: DejaVu Sans (DejaVu
// Serif, DejaVu Sans Mono), in another shape and width, but there.

const DEJAVU = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';
const GOOGLE = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/';
const metric = (pkg, stem) => [`${GOOGLE}${pkg}/400Regular/${stem}_400Regular.ttf`, `${GOOGLE}${pkg}/700Bold/${stem}_700Bold.ttf`];
const dejavu = (stem) => [`${DEJAVU}${stem}.ttf`, `${DEJAVU}${stem}-Bold.ttf`];

/*
 * Windows' faces by the PostScript names their files carry (regular, bold), and the free files that
 * stand in (regular, bold): a face not listed is looked for as its name without spaces ("Tahoma",
 * "Tahoma-Bold"), with DejaVu Sans in its place.
 */
const FACES = {
  'times new roman': ['TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', metric('tinos@0.4.2', 'Tinos')],
  arial: ['ArialMT', 'Arial-BoldMT', metric('arimo@0.4.3', 'Arimo')],
  'courier new': ['CourierNewPSMT', 'CourierNewPS-BoldMT', metric('cousine@0.4.3', 'Cousine')],
};

/**
 * The win metrics GDI measures a line by (OS/2 usWinAscent, usWinDescent) set to the font's hhea
 * ascender and descender: Arimo, Tinos and Cousine keep Arial's, Times New Roman's and Courier New's
 * there, but the builds served today raised their win metrics for other scripts (Arimo's 2136/797
 * against Arial's 1854/434), and a 17-pixel Arial line measured 25 pixels -- Diablo's menus a third
 * taller than the screen.
 */
export function windowsMetrics(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tables = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) tables[String.fromCharCode(...bytes.subarray(12 + 16 * i, 16 + 16 * i))] = dv.getUint32(12 + 16 * i + 8);
  if (tables.hhea === undefined || tables['OS/2'] === undefined) return bytes;
  dv.setUint16(tables['OS/2'] + 74, dv.getInt16(tables.hhea + 4)); dv.setUint16(tables['OS/2'] + 76, -dv.getInt16(tables.hhea + 6));
  return bytes;
}

/** The PostScript names and the free stand-ins for `family`: [regular, bold, [regular URL, bold URL]]. */
export function faceNames(family) {
  const key = family.toLowerCase(), ps = family.replace(/\s+/g, '');
  return FACES[key] || [ps, `${ps}-Bold`, dejavu('DejaVuSans')];
}

/**
 * `families` (["Tahoma"]) as win32Apis's `fonts`: { "tahoma": bytes, "tahoma:bold": bytes }. `say(text)`
 * tells which font each one is. `local` false: the free stand-in at once, the visitor not asked -- the
 * default text face every Windows program gets (its dialogs, buttons and message boxes).
 */
export async function pageFonts(families, say = () => {}, local0 = true) {
  const out = {};
  for (const family of families) {
    const key = family.toLowerCase(), [regular, bold, [freeR, freeB]] = faceNames(family);
    const wanted = [[key, regular, freeR], [`${key}:bold`, bold, freeB]];
    let local = [];
    try {
      if (local0 && typeof window !== 'undefined' && window.queryLocalFonts) local = await window.queryLocalFonts({ postscriptNames: wanted.map((w) => w[1]) });
    } catch (e) { say(`fonts: ${family} from this computer: ${e.message || e}`); }
    for (const [k, name, url] of wanted) {
      const f = local.find((l) => l.postscriptName === name), file = url.split('/').pop().replace('.ttf', '');
      if (f) { out[k] = new Uint8Array(await (await f.blob()).arrayBuffer()); say(`fonts: ${name}, this computer's`); continue; }
      try {
        out[k] = new Uint8Array(await (await fetch(url)).arrayBuffer());
        if (url.startsWith(GOOGLE)) windowsMetrics(out[k]);
        say(`fonts: ${name} is not here; ${file} in its place`);
      } catch (e) { say(`fonts: no ${name}, and ${file}: ${e.message || e}`); }
    }
  }
  return out;
}
