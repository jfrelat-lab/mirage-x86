// vfs.js — an in-memory MS-DOS-style filesystem (drive C:), with 8.3 paths,
// a DOS file-handle table, and ingestion helpers for drag-and-drop / URL loads.
// Pure data — no DOM — so it is testable in Node and serialisable for snapshots.

const ATTR_RO = 0x01, ATTR_HIDDEN = 0x02, ATTR_SYS = 0x04, ATTR_VOL = 0x08,
      ATTR_DIR = 0x10, ATTR_ARCHIVE = 0x20;

function dirNode(name) { return { type: 'dir', name, attr: ATTR_DIR, mtime: 0, children: new Map() }; }
function fileNode(name, data) { return { type: 'file', name, attr: ATTR_ARCHIVE, mtime: 0, data: data || new Uint8Array(0) }; }

export class VFS {
  constructor() {
    this.root = dirNode('');
    this.cwd = [];                 // path components from root, uppercased
    this.handles = new Map();      // fd -> { node, pos, path, write }
    this.nextFd = 5;               // 0..4 reserved for std streams
    this.label = 'MIRAGE';
  }

  // ---- path handling ------------------------------------------------------
  _split(path) {
    let p = String(path).toUpperCase().replace(/\//g, '\\');
    let abs = false;
    if (/^[A-Z]:/.test(p)) { p = p.slice(2); abs = true; }
    if (p.startsWith('\\')) { abs = true; p = p.slice(1); }
    const parts = abs ? [] : this.cwd.slice();
    for (let seg of p.split('\\')) {
      if (seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      seg = seg.replace(/\.+$/, '');   // trailing dots are an empty extension: "SKIEGA." ≡ "SKIEGA"
      if (seg === '') continue;
      parts.push(seg);
    }
    return parts;
  }

  /** Resolve to { parent, name, node }. node is null if the leaf doesn't exist. */
  resolve(path) {
    const parts = this._split(path);
    if (parts.length === 0) return { parent: null, name: '', node: this.root };
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur.children.get(parts[i]);
      if (!next || next.type !== 'dir') return { parent: null, name: parts[i], node: null };
      cur = next;
    }
    const name = parts[parts.length - 1];
    return { parent: cur, name, node: cur.children.get(name) || null };
  }

  cwdString() { return 'C:\\' + this.cwd.join('\\'); }

  chdir(path) {
    const { node } = this.resolve(path);
    if (node && node.type === 'dir') { this.cwd = this._split(path); return true; }
    return false;
  }

  list(path = '.') {
    const { node } = this.resolve(path);
    if (!node || node.type !== 'dir') return null;
    return [...node.children.values()];
  }

  exists(path) { return this.resolve(path).node !== null; }
  isDir(path) { const n = this.resolve(path).node; return !!n && n.type === 'dir'; }

  mkdir(path) {
    const { parent, name, node } = this.resolve(path);
    if (node || !parent) return false;
    parent.children.set(name, dirNode(name));
    return true;
  }

  /** Remove an empty directory. Refuses the current directory and any ancestor of it — DOS reports
   *  error 16 for that, and letting it through would leave `cwd` pointing at a detached node. */
  rmdir(path) {
    const { parent, name, node } = this.resolve(path);
    if (!parent || !node || node.type !== 'dir' || node.children.size) return false;
    const parts = this._split(path);                  // cwd is a component list: the target is an
    if (parts.every((seg, i) => this.cwd[i] === seg)) return false;   // ancestor iff it prefixes it
    parent.children.delete(name);
    return true;
  }

  // ---- raw file access (used by host ingestion + shell) -------------------
  readFile(path) { const n = this.resolve(path).node; return n && n.type === 'file' ? n.data : null; }

  writeFile(path, data) {
    const { parent, name, node } = this.resolve(path);
    if (!parent) return false;
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (node && node.type === 'file') node.data = bytes;
    else parent.children.set(name, fileNode(name, bytes));
    return true;
  }

  unlink(path) {
    const { parent, name, node } = this.resolve(path);
    if (!parent || !node || node.type !== 'file') return false;
    parent.children.delete(name);
    return true;
  }

  rename(from, to) {
    const a = this.resolve(from), b = this.resolve(to);
    if (!a.node || !b.parent || b.node) return false;
    a.parent.children.delete(a.name);
    a.node.name = b.name;
    b.parent.children.set(b.name, a.node);
    return true;
  }

  // ---- DOS handle layer ---------------------------------------------------
  /** @param {{create?:boolean, truncate?:boolean}} opts */
  openFile(path, opts = {}) {
    const { parent, name, node } = this.resolve(path);
    let n = node;
    if (!n || n.type !== 'file') {
      if (!opts.create || !parent) return -1;
      n = fileNode(name, new Uint8Array(0)); parent.children.set(name, n);
    } else if (opts.truncate) n.data = new Uint8Array(0);
    const fd = this.nextFd++;
    this.handles.set(fd, { node: n, pos: 0, path });
    return fd;
  }
  open(path, write) { return this.openFile(path, { create: !!write, truncate: !!write }); }

  close(fd) { return this.handles.delete(fd); }

  read(fd, n) {
    const h = this.handles.get(fd); if (!h) return null;
    const end = Math.min(h.pos + n, h.node.data.length);
    const out = h.node.data.subarray(h.pos, end);
    h.pos = end; return out;
  }

  writeBytes(fd, bytes) {
    const h = this.handles.get(fd); if (!h) return 0;
    const need = h.pos + bytes.length;
    if (need > h.node.data.length) {
      const grown = new Uint8Array(need); grown.set(h.node.data); h.node.data = grown;
    }
    h.node.data.set(bytes, h.pos); h.pos += bytes.length; return bytes.length;
  }

  seek(fd, pos, whence) {
    const h = this.handles.get(fd); if (!h) return -1;
    const len = h.node.data.length;
    h.pos = whence === 1 ? h.pos + pos : whence === 2 ? len + pos : pos;
    if (h.pos < 0) h.pos = 0;
    return h.pos;
  }

  // ---- host ingestion -----------------------------------------------------
  /** Add a file at an absolute-ish DOS path (creating parent dirs). */
  addFile(path, bytes) {
    const parts = this._split(path);
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.children.get(parts[i]);
      if (!next) { next = dirNode(parts[i]); cur.children.set(parts[i], next); }
      cur = next;
    }
    cur.children.set(parts[parts.length - 1], fileNode(parts[parts.length - 1], bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)));
  }

  /** Normalise a host filename to a DOS 8.3 uppercase name. */
  static dosName(name) {
    name = name.toUpperCase().replace(/[^A-Z0-9._~!@#$%^&(){}'`-]/g, '_');
    const dot = name.lastIndexOf('.');
    let base = dot >= 0 ? name.slice(0, dot) : name;
    let ext = dot >= 0 ? name.slice(dot + 1) : '';
    base = base.replace(/\./g, '').slice(0, 8) || 'FILE';
    ext = ext.slice(0, 3);
    return ext ? base + '.' + ext : base;
  }
}

export { ATTR_RO, ATTR_HIDDEN, ATTR_SYS, ATTR_VOL, ATTR_DIR, ATTR_ARCHIVE };
