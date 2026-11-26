// path.js — Node's `path` (POSIX), as lib/path.js computes it. A part of the HLE node (src/node/kernel.js).
export function path(N) {
  const check = (v, name) => N.checkString(v, name);
  const normalizeString = (p, allowAboveRoot) => {
    let res = '', lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
    for (let i = 0; i <= p.length; ++i) {
      if (i < p.length) code = p.charCodeAt(i);
      else if (code === 47) break;
      else code = 47;
      if (code === 47) {
        if (lastSlash === i - 1 || dots === 1) { /* nothing */ } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              const at = res.lastIndexOf('/');
              if (at === -1) { res = ''; lastSegmentLength = 0; } else { res = res.slice(0, at); lastSegmentLength = res.length - 1 - res.lastIndexOf('/'); }
              lastSlash = i; dots = 0; continue;
            } else if (res.length !== 0) { res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue; }
          }
          if (allowAboveRoot) { res += res.length > 0 ? '/..' : '..'; lastSegmentLength = 2; }
        } else {
          if (res.length > 0) res += '/' + p.slice(lastSlash + 1, i); else res = p.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i; dots = 0;
      } else if (code === 46 && dots !== -1) ++dots;
      else dots = -1;
    }
    return res;
  };
  const posix = {
    sep: '/', delimiter: ':',
    resolve(...args) {
      let resolved = '', absolute = false;
      for (let i = args.length - 1; i >= -1 && !absolute; i--) {
        const p = i >= 0 ? args[i] : N.process.cwd();
        check(p, `paths[${i}]`);
        if (p.length === 0) continue;
        resolved = `${p}/${resolved}`; absolute = p.charCodeAt(0) === 47;
      }
      resolved = normalizeString(resolved, !absolute);
      if (absolute) return `/${resolved}`;
      return resolved.length > 0 ? resolved : '.';
    },
    normalize(p) {
      check(p, 'path');
      if (p.length === 0) return '.';
      const abs = p.charCodeAt(0) === 47, trailing = p.charCodeAt(p.length - 1) === 47;
      p = normalizeString(p, !abs);
      if (p.length === 0) { if (abs) return '/'; return trailing ? './' : '.'; }
      if (trailing) p += '/';
      return abs ? `/${p}` : p;
    },
    isAbsolute(p) { check(p, 'path'); return p.length > 0 && p.charCodeAt(0) === 47; },
    join(...args) {
      if (args.length === 0) return '.';
      const parts = [];
      for (const a of args) { check(a, 'path'); if (a.length > 0) parts.push(a); }
      if (parts.length === 0) return '.';
      return posix.normalize(parts.join('/'));
    },
    relative(from, to) {
      check(from, 'from'); check(to, 'to');
      if (from === to) return '';
      from = posix.resolve(from); to = posix.resolve(to);
      if (from === to) return '';
      const fromStart = 1, fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1, toLen = to.length - toStart;
      const length = fromLen < toLen ? fromLen : toLen;
      let lastCommonSep = -1, i = 0;
      for (; i < length; i++) {
        const c = from.charCodeAt(fromStart + i);
        if (c !== to.charCodeAt(toStart + i)) break;
        else if (c === 47) lastCommonSep = i;
      }
      if (i === length) {
        if (toLen > length) {
          if (to.charCodeAt(toStart + i) === 47) return to.slice(toStart + i + 1);
          if (i === 0) return to.slice(toStart + i);
        } else if (fromLen > length) {
          if (from.charCodeAt(fromStart + i) === 47) lastCommonSep = i;
          else if (i === 0) lastCommonSep = 0;
        }
      }
      let out = '';
      for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) if (i === fromEnd || from.charCodeAt(i) === 47) out += out.length === 0 ? '..' : '/..';
      return `${out}${to.slice(toStart + lastCommonSep)}`;
    },
    toNamespacedPath(p) { return p; },
    dirname(p) {
      check(p, 'path');
      if (p.length === 0) return '.';
      const hasRoot = p.charCodeAt(0) === 47;
      let end = -1, matchedSlash = true;
      for (let i = p.length - 1; i >= 1; --i) {
        if (p.charCodeAt(i) === 47) { if (!matchedSlash) { end = i; break; } } else matchedSlash = false;
      }
      if (end === -1) return hasRoot ? '/' : '.';
      if (hasRoot && end === 1) return '//';
      return p.slice(0, end);
    },
    basename(p, suffix) {
      if (suffix !== undefined) check(suffix, 'suffix');
      check(p, 'path');
      let start = 0, end = -1, matchedSlash = true;
      if (suffix !== undefined && suffix.length > 0 && suffix.length <= p.length) {
        if (suffix === p) return '';
        let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
        for (let i = p.length - 1; i >= 0; --i) {
          const c = p.charCodeAt(i);
          if (c === 47) { if (!matchedSlash) { start = i + 1; break; } } else {
            if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
            if (extIdx >= 0) {
              if (c === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; } else { extIdx = -1; end = firstNonSlashEnd; }
            }
          }
        }
        if (start === end) end = firstNonSlashEnd; else if (end === -1) end = p.length;
        return p.slice(start, end);
      }
      for (let i = p.length - 1; i >= 0; --i) {
        if (p.charCodeAt(i) === 47) { if (!matchedSlash) { start = i + 1; break; } } else if (end === -1) { matchedSlash = false; end = i + 1; }
      }
      if (end === -1) return '';
      return p.slice(start, end);
    },
    extname(p) {
      check(p, 'path');
      let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
      for (let i = p.length - 1; i >= 0; --i) {
        const c = p.charCodeAt(i);
        if (c === 47) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
        if (end === -1) { matchedSlash = false; end = i + 1; }
        if (c === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; } else if (startDot !== -1) preDotState = -1;
      }
      if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return '';
      return p.slice(startDot, end);
    },
    format(o) {
      if (o === null || typeof o !== 'object') throw N.invalidArg('pathObject', 'of type object', o);
      const dir = o.dir || o.root, ext = o.ext ? `${o.ext[0] === '.' ? '' : '.'}${o.ext}` : '';
      const base = o.base || `${o.name || ''}${ext}`;
      if (!dir) return base;
      return dir === o.root ? `${dir}${base}` : `${dir}/${base}`;
    },
    parse(p) {
      check(p, 'path');
      const ret = { root: '', dir: '', base: '', ext: '', name: '' };
      if (p.length === 0) return ret;
      const abs = p.charCodeAt(0) === 47;
      let start = 0;
      if (abs) { ret.root = '/'; start = 1; }
      let startDot = -1, startPart = 0, end = -1, matchedSlash = true, i = p.length - 1, preDotState = 0;
      for (; i >= start; --i) {
        const c = p.charCodeAt(i);
        if (c === 47) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
        if (end === -1) { matchedSlash = false; end = i + 1; }
        if (c === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; } else if (startDot !== -1) preDotState = -1;
      }
      if (end !== -1) {
        const s = startPart === 0 && abs ? 1 : startPart;
        if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) ret.base = ret.name = p.slice(s, end);
        else { ret.name = p.slice(s, startDot); ret.base = p.slice(s, end); ret.ext = p.slice(startDot, end); }
      }
      if (startPart > 0) ret.dir = p.slice(0, startPart - 1); else if (abs) ret.dir = '/';
      return ret;
    },
  };
  posix.posix = posix;
  posix.win32 = posix;                                                     // not Windows': a program that asks gets POSIX
  N.path = posix;
}
