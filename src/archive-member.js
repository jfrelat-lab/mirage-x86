// archive-member.js — one file out of an archive fetched from its authors' site: an example of the
// manifest that is not kept here (`url` and `member` instead of `file`, YOLP's Linux intros) comes as a
// .tar.bz2, a .tar.gz, a .tar or a .zip, and the page wants the one binary inside it.
import { bunzip2 } from './bunzip2.js';
import { gunzip, tarEntries } from './oasis-layers.js';
import { unzip } from './zip.js';

/** The bytes of `member` (a path inside the archive) in `bytes`, the archive named by `name`. */
export async function archiveMember(bytes, name, member) {
  const n = name.toLowerCase();
  let files;
  if (n.endsWith('.zip')) files = (await unzip(bytes)).map((f) => ({ path: f.path, data: f.bytes }));
  else {
    const tar = /\.(tar\.bz2|tbz2?)$/.test(n) ? bunzip2(bytes) : /\.(tar\.gz|tgz)$/.test(n) ? await gunzip(bytes) : bytes;
    files = tarEntries(tar).filter((e) => e.type === 'file' || e.data);
  }
  const clean = (p) => p.replace(/^\.?\//, '');
  const f = files.find((e) => clean(e.path) === clean(member));
  if (!f) throw new Error(`${member} is not in ${name}`);
  return f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
}
