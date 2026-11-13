// fonts.js — the TrueType fonts a Win32 image names (`machine.fonts`), found in the page before it
// starts: MIRAGE ships no Windows font. The visitor's own copy first — Chrome's Local Font Access API
// (window.queryLocalFonts) reads an installed font's file, after asking, by its PostScript name; macOS
// and Windows install Tahoma, Times New Roman, Arial — else a DejaVu font, free, from jsDelivr: DejaVu
// Serif for a serif face, DejaVu Sans Mono for a fixed one, DejaVu Sans for the rest. The text is then
// not the font the program asked for, in another shape and width, but it is there.

const DEJAVU = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';

/*
 * Windows' faces by the PostScript names their files carry (regular, bold), and the free face that
 * stands in: a face not listed is looked for as its name without spaces ("Tahoma", "Tahoma-Bold").
 */
const FACES = {
  'times new roman': ['TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'DejaVuSerif'],
  arial: ['ArialMT', 'Arial-BoldMT', 'DejaVuSans'],
  'courier new': ['CourierNewPSMT', 'CourierNewPS-BoldMT', 'DejaVuSansMono'],
};

/** The PostScript names and the free stand-in for `family`: [regular, bold, free file's stem]. */
export function faceNames(family) {
  const key = family.toLowerCase(), ps = family.replace(/\s+/g, '');
  return FACES[key] || [ps, `${ps}-Bold`, 'DejaVuSans'];
}

/**
 * `families` (["Tahoma"]) as win32Apis's `fonts`: { "tahoma": bytes, "tahoma:bold": bytes }. `say(text)`
 * tells which font each one is. `local` false: the free stand-in at once, the visitor not asked -- the
 * default text face every Windows program gets (its dialogs, buttons and message boxes).
 */
export async function pageFonts(families, say = () => {}, local0 = true) {
  const out = {};
  for (const family of families) {
    const key = family.toLowerCase(), [regular, bold, free] = faceNames(family);
    const wanted = [[key, regular, `${free}.ttf`], [`${key}:bold`, bold, `${free}-Bold.ttf`]];
    let local = [];
    try {
      if (local0 && typeof window !== 'undefined' && window.queryLocalFonts) local = await window.queryLocalFonts({ postscriptNames: wanted.map((w) => w[1]) });
    } catch (e) { say(`fonts: ${family} from this computer: ${e.message || e}`); }
    for (const [k, name, file] of wanted) {
      const f = local.find((l) => l.postscriptName === name);
      if (f) { out[k] = new Uint8Array(await (await f.blob()).arrayBuffer()); say(`fonts: ${name}, this computer's`); continue; }
      try {
        out[k] = new Uint8Array(await (await fetch(DEJAVU + file)).arrayBuffer());
        say(`fonts: ${name} is not here; ${file.replace('.ttf', '')} in its place`);
      } catch (e) { say(`fonts: no ${name}, and ${file}: ${e.message || e}`); }
    }
  }
  return out;
}
