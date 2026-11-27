// esm.js — ES modules for the HLE node: import and export, import(), import.meta, top-level await, JSON
// modules, CommonJS and the built-in modules imported, require() of ES modules -- resolved, linked and
// evaluated as Node does. A part of the HLE node (src/node/kernel.js), after modules.js (CommonJS).
//
// The host's own modules are not used: a page's Worker may not import what its CSP has not allowed
// (script-src 'self' 'unsafe-eval': no blob: or data: modules), and vm's modules need a flag. A module is
// instead its source with its import and export declarations taken out (a token-level transform that
// keeps every line where it was), compiled as a generator function:
//
//     with (scope) { return function* (__mX, __mI, __mM) { 'use strict'; <exports>; yield; <body> } }
//
// `scope` holds the module's imports as getters reading the exporting modules' namespaces, so an import
// is a live binding, and an assignment to one throws as in a module; the generator's first step (up to
// the yield) gives the namespace its getters -- closures over the body's own declarations, whose
// functions are hoisted and whose let/const are in their temporal dead zone until the body runs, as a
// module's are once linked; its second step is the evaluation. Every module of a graph takes its first
// step before any takes its second: cycles see each other's functions, and a let not yet run throws
// "Cannot access 'x' before initialization". A module with top-level await is an async generator.
// `import(` becomes __mI( (in CommonJS too), `import.meta` __mM.
//
// Not here: source phase and defer imports, import maps, loaders and hooks (module.register), WebAssembly
// modules, data: URLs; a namespace that is extensible (Object.isExtensible says true).
export function esm(N) {
  const G = N.global, path = N.path, fs = N.fs, C = N.cjs, builtins = N.builtins;

  // ---- tokens -------------------------------------------------------------------------------------
  // Each { t: id | str | num | tpl | re | priv | p (punctuator), v, s, e (source offsets), d (nesting of
  // ( [ { -- an opener and its closer at the same depth), nl (a line break before it) }.
  const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
  const ID_START = /[A-Za-z_$\u0080-\uffff\\]/, ID_PART = /[\w$\u0080-\uffff\\]/, SPACE = /[\s\ufeff]/, BREAK = /[\n\r\u2028\u2029]/;
  const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
  const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  const unquote = (raw) => raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g, (m, e) => (e[0] === 'u' && e.length > 1 ? String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16))
    : e[0] === 'x' && e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : BREAK.test(e[0]) ? '' : ESC[e] ?? e));
  const lex = (src) => {
    const toks = [], n = src.length, braces = [];                       // braces: 'b' a block's or object's, 't' a template's ${
    let i = 0, depth = 0, nl = false;
    const push = (t, v, s, e) => { toks.push({ t, v, s, e, d: depth, nl }); nl = false; };
    const regexOK = () => { const p = toks[toks.length - 1]; if (!p) return true; if (p.t === 'p') return p.v !== ')' && p.v !== ']' && p.v !== '}'; if (p.t === 'id') return BEFORE_EXPR.has(p.v); return false; };
    const template = (s) => {
      for (;;) {
        if (i >= n) { push('tpl', null, s, n); return; }
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { i++; push('tpl', null, s, i); return; }
        if (c === '$' && src[i + 1] === '{') { i += 2; push('tpl', null, s, i); braces.push('t'); depth++; return; }
        i++;
      }
    };
    while (i < n) {
      const c = src[i];
      if (BREAK.test(c)) { nl = true; i++; continue; }
      if (SPACE.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && !BREAK.test(src[i])) i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? n : e + 2; if (BREAK.test(src.slice(i, end))) nl = true; i = end; continue; }
      const s = i;
      if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1; i++; push('str', unquote(src.slice(s + 1, i - 1)), s, i); continue; }
      if (c === '`') { i++; template(s); continue; }
      if (ID_START.test(c) || c === '#') { i++; while (i < n && ID_PART.test(src[i])) i++; push(c === '#' ? 'priv' : 'id', src.slice(s, i), s, i); continue; }
      if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
        const m = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(i, i + 400));
        i += m ? m[0].length : 1; push('num', null, s, i); continue;
      }
      if (c === '/' && regexOK()) {
        i++; let cls = false;
        while (i < n && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue; } if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break; i++; }
        i++; while (i < n && ID_PART.test(src[i])) i++;
        push('re', null, s, i); continue;
      }
      if (c === '{' || c === '(' || c === '[') { push('p', c, s, i + 1); depth++; if (c === '{') braces.push('b'); i++; continue; }
      if (c === '}') { const b = braces.pop(); depth--; i++; if (b === 't') template(s); else push('p', '}', s, i); continue; }
      if (c === ')' || c === ']') { depth--; i++; push('p', c, s, i); continue; }
      let p = PUNCT.find((q) => src.startsWith(q, i));
      if (p === '?.' && /\d/.test(src[i + 2] || '')) p = null;
      p = p || c; i += p.length; push('p', p, s, i);
    }
    return toks;
  };
  /*
   * Does code (not a string, a comment, a template's text or a regex) say `import(` or `import.`? A scan
   * without tokens, for the CommonJS files whose text has "import(" somewhere: TypeScript's 6 MB compiler
   * has it only in its messages, and lexing it whole on every start took a quarter of a second.
   */
  const SCAN = /[ \t\v\f\u00a0\ufeff]+|[\n\r\u2028\u2029]|\/\/.*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n\r]|\\[\s\S])*"?|'(?:[^'\\\n\r]|\\[\s\S])*'?|[A-Za-z_$\u0080-\uffff\\][\w$\u0080-\uffff\\]*|#[\w$\u0080-\uffff\\]+|\.?\d[\w.]*|\?\.|\.\.\.|[^]/gy;
  const codeImports = (src) => {
    const n = src.length, braces = [];
    let i = 0, prev = '', prevKind = '';                                 // prevKind: p (punctuator), id, x (a value)
    const regexOK = () => (prevKind === '' ? true : prevKind === 'p' ? prev !== ')' && prev !== ']' && prev !== '}' : prevKind === 'id' ? BEFORE_EXPR.has(prev) : false);
    const template = () => {                                               // i after ` or after the } of a ${ }
      for (;;) {
        if (i >= n) return;
        const c = src.charCodeAt(i);
        if (c === 92) { i += 2; continue; }
        if (c === 96) { i++; return; }
        if (c === 36 && src.charCodeAt(i + 1) === 123) { i += 2; braces.push(1); prev = '{'; prevKind = 'p'; return; }
        i++;
      }
    };
    while (i < n) {
      SCAN.lastIndex = i;
      const m = SCAN.exec(src); if (!m) break;
      const t = m[0], c = t.charCodeAt(0);
      i += t.length;
      if (c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || (c === 47 && (t[1] === '/' || t[1] === '*'))) continue;
      if (c === 34 || c === 39 || (c >= 48 && c <= 57) || (c === 46 && t.length > 1 && t !== '...')) { prev = ''; prevKind = 'x'; continue; }
      if (t.length > 1 && t !== '?.' && t !== '...' || /^[A-Za-z_$\u0080-\uffff\\]/.test(t)) {
        if (t === 'import' && !(prevKind === 'p' && (prev === '.' || prev === '?.'))) {
          let j = i; while (j < n && /\s/.test(src[j])) j++;
          if (src[j] === '(' || src[j] === '.') return true;
        }
        prev = t; prevKind = t[0] === '#' ? 'x' : 'id'; continue;
      }
      if (c === 96) { template(); prev = ''; prevKind = 'x'; continue; }
      if (c === 47 && regexOK()) {
        let cls = false;
        while (i < n && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue; } if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break; i++; }
        i++; while (i < n && /[\w$]/.test(src[i])) i++;
        prev = ''; prevKind = 'x'; continue;
      }
      if (c === 123) braces.push(0);
      if (c === 125 && braces.pop() === 1) { template(); prev = ''; prevKind = 'x'; continue; }
      prev = t; prevKind = 'p';
    }
    return false;
  };
  const isMember = (toks, k) => { const p = toks[k - 1]; return !!p && p.t === 'p' && (p.v === '.' || p.v === '?.'); };
  // `import(` that is a call, not a method named import (`import() {`, `{ import(x) { ... } }`).
  const isImportCall = (toks, k) => {
    const o = toks[k + 1]; if (!o || o.v !== '(' || o.t !== 'p') return false;
    let j = k + 2; while (j < toks.length && !(toks[j].v === ')' && toks[j].d === o.d)) j++;
    return !(toks[j + 1] && toks[j + 1].v === '{' && toks[j + 1].t === 'p');
  };
  /** Does the source use a module's syntax: import or export declarations, import.meta? */
  const isModuleSyntax = (src) => {
    if (!/\b(import|export)\b/.test(src)) return false;
    let toks; try { toks = lex(src); } catch { return false; }
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]; if (t.t !== 'id' || isMember(toks, k)) continue;
      if (t.v === 'import') { const nx = toks[k + 1]; if (nx && nx.v === '.' && toks[k + 2] && toks[k + 2].v === 'meta') return true; if (t.d === 0 && nx && nx.v !== '(' && nx.v !== '.') return true; }
      const nx = toks[k + 1];
      if (t.v === 'export' && t.d === 0 && nx && (nx.t === 'id' || nx.v === '{' || nx.v === '*')) return true;
    }
    return false;
  };

  // ---- the transform ------------------------------------------------------------------------------
  const STMT = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'return', 'throw', 'try', 'switch']);
  /**
   * A module's source as the body of its generator, and what it declares: requests [{ spec, attrs }] in
   * order, imports [{ local, name ('*' the namespace), req }], exports [[name, local]], reexports
   * [[name, imported ('*'), req]], stars [req]; `cjs`: only import() and import.meta are rewritten.
   */
  const transform = (src, cjs = false) => {
    const toks = lex(src), edits = [], requests = [], imports = [], exports = [], reexports = [], stars = [];
    let declareDefault = false, renameDefault = '';
    const fail = (t, what) => { const e = new SyntaxError(what || `Unexpected token '${t ? src.slice(t.s, t.e) : 'end of input'}'`); throw e; };
    const req = (spec, attrs) => { let i = requests.findIndex((r) => r.spec === spec && r.attrs.type === attrs.type); if (i < 0) { requests.push({ spec, attrs }); i = requests.length - 1; } return i; };
    const cut = (s, e, text = '') => edits.push([s, e, text + src.slice(s, e).replace(/[^\n]/g, '')]);
    const attrsAt = (j) => {
      const a = {}, t = toks[j];
      if (t && t.t === 'id' && (t.v === 'with' || (t.v === 'assert' && !t.nl)) && toks[j + 1] && toks[j + 1].v === '{') {
        j += 2;
        while (toks[j] && toks[j].v !== '}') { const k = toks[j], v = toks[j + 2]; if (!v || v.t !== 'str') fail(v); a[k.v] = v.v; j += 3; if (toks[j] && toks[j].v === ',') j++; }
        j++;
      }
      return [a, j];
    };
    const nameOf = (t) => { if (!t || (t.t !== 'id' && t.t !== 'str')) fail(t); return t.v; };
    const semi = (j) => (toks[j] && toks[j].v === ';' && toks[j].t === 'p' ? j + 1 : j);
    // The names a let, const or var declares (each declarator's binding, patterns included).
    const declNames = (j) => {
      const names = [], d0 = toks[j].d; let q = j + 1;
      const skipTo = (D) => { while (q < toks.length && !(toks[q].d === D && toks[q].v === ',') && !(toks[q].d === D - 1 && (toks[q].v === '}' || toks[q].v === ']'))) q++; };
      const target = () => { const t = toks[q]; if (t && t.t === 'id') { names.push(t.v); q++; } else if (t && (t.v === '{' || t.v === '[')) pattern(); else fail(t); };
      const pattern = () => {
        const o = toks[q], D = o.d + 1, close = o.v === '{' ? '}' : ']'; q++;
        while (q < toks.length && !(toks[q].v === close && toks[q].d === o.d)) {
          if (toks[q].v === ',') { q++; continue; }
          if (toks[q].v === '...') { q++; target(); continue; }
          if (o.v === '{') {
            const key = toks[q];
            if (key.v === '[') { while (!(toks[q].v === ']' && toks[q].d === key.d)) q++; q++; } else q++;
            if (toks[q] && toks[q].v === ':') { q++; target(); } else names.push(key.v);
          } else target();
          if (toks[q] && toks[q].v === '=') { q++; skipTo(D); }
        }
        q++;
      };
      for (;;) {
        target();
        if (toks[q] && toks[q].v === '=') {
          q++;
          while (q < toks.length) { const t = toks[q]; if (t.d === d0 && (t.v === ',' || t.v === ';') && t.t === 'p') break; if (t.d === d0 && t.nl && t.t === 'id' && STMT.has(t.v)) break; if (t.d < d0) break; q++; }
        }
        if (toks[q] && toks[q].v === ',' && toks[q].d === d0) { q++; continue; }
        return names;
      }
    };
    const parseImport = (k) => {
      let j = k + 1, spec; const binds = [];
      if (toks[j] && toks[j].t === 'str') { spec = toks[j].v; j++; }
      else {
        for (;;) {
          const a = toks[j]; if (!a) fail(a);
          if (a.t === 'id' && (a.v !== 'from' || (toks[j + 1] && (toks[j + 1].v === ',' || toks[j + 1].v === 'from')))) { binds.push({ local: a.v, name: 'default' }); j++; }
          else if (a.v === '*') { if (!toks[j + 1] || toks[j + 1].v !== 'as') fail(toks[j + 1]); binds.push({ local: nameOf(toks[j + 2]), name: '*' }); j += 3; }
          else if (a.v === '{') {
            j++;
            while (toks[j] && toks[j].v !== '}') {
              const nm = toks[j]; let local = nm.v; j++;
              if (toks[j] && toks[j].t === 'id' && toks[j].v === 'as') { local = nameOf(toks[j + 1]); j += 2; } else if (nm.t === 'str') fail(toks[j]);
              binds.push({ local, name: nameOf(nm) });
              if (toks[j] && toks[j].v === ',') j++;
            }
            j++;
          } else if (a.v === ',') j++;
          else if (a.t === 'id' && a.v === 'from') { if (!toks[j + 1] || toks[j + 1].t !== 'str') fail(toks[j + 1]); spec = toks[j + 1].v; j += 2; break; }
          else fail(a);
        }
      }
      const [attrs, j2] = attrsAt(j); j = semi(j2);
      const r = req(spec, attrs);
      for (const b of binds) imports.push({ ...b, req: r });
      cut(toks[k].s, toks[j - 1].e);
      return j - 1;
    };
    const parseExport = (k) => {
      let j = k + 1; const a = toks[j]; if (!a) fail(a);
      if (a.v === '*') {
        let as = null; j++;
        if (toks[j] && toks[j].v === 'as') { as = nameOf(toks[j + 1]); j += 2; }
        if (!toks[j] || toks[j].v !== 'from' || !toks[j + 1] || toks[j + 1].t !== 'str') fail(toks[j]);
        const spec = toks[j + 1].v, [attrs, j2] = attrsAt(j + 2); j = semi(j2);
        const r = req(spec, attrs);
        if (as === null) stars.push(r); else reexports.push([as, '*', r]);
        cut(toks[k].s, toks[j - 1].e); return j - 1;
      }
      if (a.v === '{') {
        const list = []; j++;
        while (toks[j] && toks[j].v !== '}') {
          const nm = toks[j]; let as = nm.v; j++;
          if (toks[j] && toks[j].t === 'id' && toks[j].v === 'as') { as = nameOf(toks[j + 1]); j += 2; }
          list.push([nm, as]);
          if (toks[j] && toks[j].v === ',') j++;
        }
        j++;
        if (toks[j] && toks[j].t === 'id' && toks[j].v === 'from' && toks[j + 1] && toks[j + 1].t === 'str') {
          const spec = toks[j + 1].v, [attrs, j2] = attrsAt(j + 2); j = semi(j2);
          const r = req(spec, attrs);
          for (const [nm, as] of list) reexports.push([as, nameOf(nm), r]);
        } else {
          j = semi(j);
          for (const [nm, as] of list) { if (nm.t !== 'id') fail(nm); exports.push([as, nm.v]); }
        }
        cut(toks[k].s, toks[j - 1].e); return j - 1;
      }
      if (a.t === 'id' && a.v === 'default') {
        const b = toks[j + 1];
        const fn = b && b.v === 'function' ? j + 1 : b && b.v === 'async' && toks[j + 2] && toks[j + 2].v === 'function' && !toks[j + 2].nl ? j + 2 : -1;
        if (fn >= 0) {
          let g = fn + 1; if (toks[g] && toks[g].v === '*') g++;
          if (toks[g] && toks[g].t === 'id') { exports.push(['default', toks[g].v]); cut(toks[k].s, a.e); }
          else { exports.push(['default', '__mD']); cut(toks[k].s, a.e); edits.push([toks[g - 1].e, toks[g - 1].e, ' __mD']); renameDefault = 'fn'; }
          return k + 1;
        }
        if (b && b.v === 'class' && toks[j + 2] && toks[j + 2].t === 'id' && toks[j + 2].v !== 'extends') { exports.push(['default', toks[j + 2].v]); cut(toks[k].s, a.e); return k + 1; }
        exports.push(['default', '__mD']); declareDefault = true; renameDefault = renameDefault || 'value';
        cut(toks[k].s, a.e, '__mD ='); return k + 1;
      }
      if (a.t === 'id' && (a.v === 'const' || a.v === 'let' || a.v === 'var')) { for (const nm of declNames(j)) exports.push([nm, nm]); cut(toks[k].s, toks[k].e); return k; }
      if (a.t === 'id' && (a.v === 'function' || a.v === 'class' || a.v === 'async')) {
        let g = j + 1; if (a.v === 'async') g++; if (toks[g] && toks[g].v === '*') g++;
        exports.push([nameOf(toks[g]), toks[g].v]); cut(toks[k].s, toks[k].e); return k;
      }
      return fail(a);
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t !== 'id' || isMember(toks, k)) continue;
      if (t.v === 'import') {
        const nx = toks[k + 1];
        if (nx && nx.v === '(' && nx.t === 'p') { if (isImportCall(toks, k)) edits.push([t.s, t.e, '__mI']); continue; }
        if (nx && nx.v === '.' && toks[k + 2] && toks[k + 2].v === 'meta') { if (!cjs) edits.push([t.s, toks[k + 2].e, '__mM']); k += 2; continue; }
        if (!cjs && t.d === 0) k = parseImport(k);
      } else if (t.v === 'export' && !cjs && t.d === 0) k = parseExport(k);
    }
    let body = '', at = 0;
    for (const [s, e, text] of edits.sort((x, y) => x[0] - y[0])) { body += src.slice(at, s) + text; at = e; }
    body += src.slice(at);
    const awaits = !cjs && toks.some((t) => t.t === 'id' && t.v === 'await');
    return { body, requests, imports, exports, reexports, stars, declareDefault, renameDefault, awaits };
  };

  // ---- errors -------------------------------------------------------------------------------------
  const err = (Ctor, code, msg, extra = {}) => Object.assign(N.nodeError(Ctor, code, msg), extra);
  const toURL = (file) => N.pathToFileURL(file).href;
  const notFound = (what, from, url) => err(Error, 'ERR_MODULE_NOT_FOUND', `Cannot find ${what} imported from ${from}`, url ? { url } : {});

  // ---- resolution, as Node's ESM resolver ------------------------------------------------------
  const CONDS = ['node', 'import', 'module-sync', 'node-addons', 'default'];
  const isBuiltin = (name) => name in builtins && !C.schemeOnly.has(name);
  const fileOfSpec = (spec) => { const q = spec.search(/[?#]/); return decodeURIComponent(q < 0 ? spec : spec.slice(0, q)); };
  const packageResolve = (spec, base, parent) => {
    const parts = spec.split('/'), name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], sub = '.' + spec.slice(name.length);
    if (!name || (spec.startsWith('@') && parts.length < 2) || name.startsWith('.') || /[\\%]/.test(name)) throw err(TypeError, 'ERR_INVALID_MODULE_SPECIFIER', `Invalid module "${spec}" is not a valid package name imported from ${parent}`);
    for (let d = base; ; d = path.dirname(d)) {
      if (path.basename(d) !== 'node_modules') {
        const pdir = (d === '/' ? '' : d) + '/node_modules/' + name;
        if (C.isDir(pdir)) {
          const pkg = C.readPkg(pdir);
          if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
            const r = C.viaExports(pdir, pkg, sub, CONDS);
            if (r === undefined || r === null) throw err(Error, 'ERR_PACKAGE_PATH_NOT_EXPORTED', sub === '.' ? `No "exports" main defined in ${pdir}/package.json imported from ${parent}` : `Package subpath '${sub}' is not defined by "exports" in ${pdir}/package.json imported from ${parent}`);
            return r;
          }
          if (sub !== '.') return pdir + sub.slice(1);
          if (pkg && typeof pkg.main === 'string' && pkg.main) { const m = path.resolve(pdir, pkg.main); for (const f of [m, m + '.js', m + '.json', m + '.node', m + '/index.js', m + '/index.json', m + '/index.node']) if (C.isFile(f)) return f; }
          for (const f of ['/index.js', '/index.json', '/index.node']) if (C.isFile(pdir + f)) return pdir + f;
          throw notFound(`module '${pdir}/index.js'`, parent);
        }
      }
      if (d === '/') break;
    }
    throw notFound(`package '${name}'`, parent);
  };
  const packageImports = (spec, base, parent) => {
    for (let d = base; ; d = path.dirname(d)) {
      const pkg = C.readPkg(d);
      if (pkg) {
        const map = pkg.imports || {};
        let t = map[spec] !== undefined ? C.pickExport(map[spec], CONDS) : undefined;
        if (t === undefined) for (const [k, v] of Object.entries(map)) { const star = k.indexOf('*'); if (star >= 0 && spec.startsWith(k.slice(0, star)) && spec.endsWith(k.slice(star + 1))) { const p = C.pickExport(v, CONDS); if (p) { t = p.replaceAll('*', spec.slice(star, spec.length - (k.length - star - 1))); break; } } }
        if (!t) throw err(TypeError, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined in package ${d}/package.json imported from ${parent}`);
        return t.startsWith('./') ? path.resolve(d, t) : resolve(t, parent).file;
      }
      if (d === '/') break;
    }
    throw err(TypeError, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined imported from ${parent}`);
  };
  /** spec imported from the file `parent` -> { builtin } or { file, format }; `only`: the URL, unchecked. */
  const resolve = (spec, parent, only = false) => {
    spec = String(spec);
    if (spec.startsWith('node:')) { const n = spec.slice(5); if (!(n in builtins)) throw err(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${spec}`); return { builtin: n, url: spec }; }
    if (isBuiltin(spec)) return { builtin: spec, url: 'node:' + spec };
    const base = path.dirname(parent);
    let file;
    if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') file = path.resolve(base, fileOfSpec(spec));
    else if (spec.startsWith('file:')) file = N.fileURLToPath(spec.replace(/[?#].*$/, ''));
    else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(spec)) throw err(Error, 'ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol '${spec.slice(0, spec.indexOf(':') + 1)}'`);
    else if (spec.startsWith('#')) file = packageImports(spec, base, parent);
    else file = packageResolve(spec, base, parent);
    if (only) return { url: toURL(file) + (spec.endsWith('/') && !file.endsWith('/') ? '/' : '') };
    if (C.isDir(file)) throw err(Error, 'ERR_UNSUPPORTED_DIR_IMPORT', `Directory import '${file}' is not supported resolving ES modules imported from ${parent}`, { url: toURL(file) });
    if (!C.isFile(file)) throw notFound(`module '${file}'`, parent, toURL(file));
    file = fs.realpathSync(file);
    return { file, url: toURL(file), format: formatOf(file) };
  };
  /** A file's format: module, commonjs, json, by its extension and its package.json's "type"; a .js
   *  (or extensionless) file of no type, by its syntax, as Node detects it. */
  const formatOf = (file, src) => {
    const ext = path.extname(file);
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    if (ext === '.json') return 'json';
    if (ext === '.js' || ext === '') {
      const type = C.typeOfPackage(file);
      if (type === 'module') return 'module';
      if (type === 'commonjs') return 'commonjs';
      return isModuleSyntax(src ?? fs.readFileSync(file, 'utf8')) ? 'module' : 'commonjs';
    }
    throw err(TypeError, 'ERR_UNKNOWN_FILE_EXTENSION', `Unknown file extension "${ext}" for ${file}`);
  };

  // ---- records: a module as linked and evaluated -------------------------------------------------
  const records = new Map();                                              // file (or node:name) -> record
  const namespaces = new WeakSet();
  const namespace = (rec, extra = null) => {
    const has = (k) => typeof k === 'string' && (rec.exports.has(k) || (extra && k in extra));
    const value = (k) => (extra && k in extra ? extra[k] : rec.exports.get(k)());
    const keys = () => [...new Set([...rec.exports.keys(), ...(extra ? Object.keys(extra) : [])])].sort();
    const ns = new Proxy(Object.create(null), {
      get: (t, k) => (k === Symbol.toStringTag ? 'Module' : has(k) ? value(k) : undefined),
      has: (t, k) => k === Symbol.toStringTag || has(k),
      ownKeys: () => [...keys(), Symbol.toStringTag],
      getOwnPropertyDescriptor: (t, k) => (k === Symbol.toStringTag ? { value: 'Module', writable: false, enumerable: false, configurable: true } : has(k) ? { value: value(k), writable: true, enumerable: true, configurable: true } : undefined),
      set: () => false, defineProperty: () => false, deleteProperty: (t, k) => !has(k), getPrototypeOf: () => null, setPrototypeOf: (t, p) => p === null,
    });
    namespaces.add(ns);
    return ns;
  };
  const newRecord = (key, kind, file, url) => { const rec = { key, kind, file, url, status: 'new', exports: new Map(), requests: [], ns: null }; rec.ns = namespace(rec); records.set(key, rec); return rec; };

  const builtinRecord = (name) => {
    const key = 'node:' + name; if (records.has(key)) return records.get(key);
    const rec = newRecord(key, 'builtin', null, key), mod = builtins[name];
    rec.exports.set('default', () => mod);
    if (mod && (typeof mod === 'object' || typeof mod === 'function')) for (const k of Object.keys(mod)) if (k !== 'default') rec.exports.set(k, () => mod[k]);
    if (name === 'module') for (const k of ['createRequire', 'builtinModules', 'isBuiltin', 'register', 'syncBuiltinESMExports', 'findPackageJSON', 'enableCompileCache', 'Module']) rec.exports.set(k, () => mod[k]);
    rec.status = 'evaluated';
    return rec;
  };
  // What a CommonJS module exports by name, as Node's cjs-module-lexer finds it: exports.x =, module.exports
  // = { ... }, Object.defineProperty(exports, 'x'), and the modules it re-exports (module.exports =
  // require('y'), __exportStar(require('y'))).
  const cjsNames = (file, seen = new Set()) => {
    const names = new Set(); if (seen.has(file)) return names; seen.add(file);
    let toks; try { toks = lex(fs.readFileSync(file, 'utf8')); } catch { return names; }
    const again = [];
    const exportsAt = (k) => (!toks[k] || isMember(toks, k) ? 0 : toks[k].v === 'exports' ? 1 : toks[k].v === 'module' && toks[k + 1] && toks[k + 1].v === '.' && toks[k + 2] && toks[k + 2].v === 'exports' ? 3 : 0);
    const required = (k) => (toks[k] && toks[k].v === 'require' && toks[k + 1] && toks[k + 1].v === '(' && toks[k + 2] && toks[k + 2].t === 'str' && toks[k + 3] && toks[k + 3].v === ')' ? toks[k + 2].v : null);
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]; if (t.t !== 'id') continue;
      const n = exportsAt(k);
      if (n) {
        const q = k + n, a = toks[q], b = toks[q + 1], c = toks[q + 2];
        if (a && a.v === '.' && b && b.t === 'id' && c && c.v === '=') names.add(b.v);
        else if (a && a.v === '[' && b && b.t === 'str' && c && c.v === ']' && toks[q + 3] && toks[q + 3].v === '=') names.add(b.v);
        else if (n === 3 && a && a.v === '=') {
          if (b && b.v === '{') {
            const D = b.d + 1;
            for (let j = q + 2; j < toks.length && !(toks[j].v === '}' && toks[j].d === b.d); j++) {
              const x = toks[j], pv = toks[j - 1];
              if (x.d !== D || !(pv.v === '{' || pv.v === ',')) continue;
              if (x.v === '...') { const r = required(j + 1); if (r) again.push(r); continue; }
              const nx = toks[j + 1];
              if ((x.t === 'id' || x.t === 'str') && nx && (nx.v === ',' || nx.v === '}' || nx.v === ':' || nx.v === '(')) names.add(x.v);
            }
          } else { const r = required(q + 1); if (r) again.push(r); }
        }
      }
      if (t.v === 'Object' && toks[k + 1] && toks[k + 1].v === '.' && toks[k + 2] && toks[k + 2].v === 'defineProperty' && toks[k + 3] && toks[k + 3].v === '(') {
        const m = exportsAt(k + 4); const q = k + 4 + m;
        if (m && toks[q] && toks[q].v === ',' && toks[q + 1] && toks[q + 1].t === 'str') names.add(toks[q + 1].v);
      }
      if ((t.v === '__exportStar' || t.v === '__export') && toks[k + 1] && toks[k + 1].v === '(') { const r = required(k + 2); if (r) again.push(r); }
    }
    for (const r of again) {
      try { const f = C.resolveFilename(r, { filename: file }); if (!f.startsWith('node:') && !(f in builtins) && !f.endsWith('.json')) for (const nm of cjsNames(f, seen)) names.add(nm); } catch { /* not found: none */ }
    }
    names.delete('default');
    return names;
  };
  const cjsRecord = (file) => {
    if (records.has(file)) return records.get(file);
    const rec = newRecord(file, 'cjs', file, toURL(file)), values = Object.create(null);
    let mexp;
    rec.exports.set('default', () => mexp); rec.exports.set('module.exports', () => mexp);
    for (const nm of cjsNames(file)) rec.exports.set(nm, () => values[nm]);
    rec.run = () => {
      mexp = C.load(file, null, false);
      for (const nm of rec.exports.keys()) if (nm !== 'default' && nm !== 'module.exports') values[nm] = mexp == null ? undefined : mexp[nm];
    };
    const cached = C.cache[file];
    if (cached && cached.loaded) { rec.run(); rec.status = 'evaluated'; } else rec.status = 'linked';
    return rec;
  };
  const jsonRecord = (file) => {
    if (records.has(file)) return records.get(file);
    const rec = newRecord(file, 'json', file, toURL(file));
    let v; const src = fs.readFileSync(file, 'utf8');
    try { v = JSON.parse(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src); } catch (e) { e.message = `${file}: ${e.message}`; throw e; }
    rec.exports.set('default', () => v);
    rec.status = 'evaluated';
    return rec;
  };
  const CODE = (body, async) => `with(__mS){return ${async ? 'async ' : ''}function*(__mX,__mI,__mM){'use strict';`;
  const esmRecord = (file, src) => {
    if (records.has(file)) return records.get(file);
    const rec = newRecord(file, 'esm', file, toURL(file));
    src = src ?? fs.readFileSync(file, 'utf8');
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    if (src.startsWith('#!')) src = '//' + src.slice(2);
    rec.src = src;
    try {
      const m = transform(src);
      rec.mod = m;
      let async = false;
      if (m.awaits) { try { N.bridge.compile(`class __mT{static{${m.body}\n}}`, rec.url, []); } catch { async = true; } }
      const pre = (m.declareDefault ? 'let __mD;' : '') + `__mX({${m.exports.map(([e, l]) => `${JSON.stringify(e)}:()=>${l}`).join(',')}});`
        + (m.renameDefault === 'fn' ? "Object.defineProperty(__mD,'name',{value:'default'});" : '') + 'yield;';
      const post = m.renameDefault === 'value' ? "\n;if((typeof __mD==='function')&&(__mD.name==='__mD'))Object.defineProperty(__mD,'name',{value:'default'});" : '';
      rec.async = async;
      rec.fn = N.bridge.compile(CODE(m.body, async) + pre + m.body + post + '\n}}', rec.url, ['__mS']);
    } catch (e) { records.delete(file); throw e; }
    rec.status = 'new';
    return rec;
  };
  /** The record of spec imported from `parent` with import attributes `attrs`, its graph loaded. */
  const recordFor = (spec, parent, attrs = {}) => {
    const r = resolve(spec, parent);
    if (r.builtin !== undefined) return builtinRecord(r.builtin);
    if (attrs.type !== undefined && attrs.type !== 'json') throw err(TypeError, 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${attrs.type}" is not supported`);
    if (r.format === 'json' && attrs.type !== 'json') throw err(TypeError, 'ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${r.url}" needs an import attribute of "type: json"`);
    if (r.format !== 'json' && attrs.type === 'json') throw err(TypeError, 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${r.url}" is not of type "json"`);
    return recordOf(r.file, r.format);
  };
  const recordOf = (file, format, src) => {
    if (records.has(file)) return records.get(file);
    if (format === 'json') return jsonRecord(file);
    if (format === 'commonjs') return cjsRecord(file);
    const rec = esmRecord(file, src);
    rec.requests = rec.mod.requests.map((q) => ({ ...q, rec: null }));
    try { for (const q of rec.requests) q.rec = recordFor(q.spec, file, q.attrs); } catch (e) { records.delete(file); throw e; }
    return rec;
  };

  // ---- linking: every new module's first step, then its stars and its imports checked ----------------
  const graph = (rec, out = new Set()) => { if (out.has(rec)) return out; out.add(rec); for (const q of rec.requests) graph(q.rec, out); return out; };
  const missing = (rec, q, name) => (q.rec.kind === 'cjs'
    ? new SyntaxError(`Named export '${name}' not found. The requested module '${q.spec}' is a CommonJS module, which may not support all module.exports as named exports.\nCommonJS modules can always be imported via the default export, for example using:\n\nimport pkg from '${q.spec}';\nconst { ${name} } = pkg;\n`)
    : new SyntaxError(`The requested module '${q.spec}' does not provide an export named '${name}'`));
  const starNames = (rec, seen = new Set()) => {
    if (seen.has(rec)) return []; seen.add(rec);
    if (rec.kind !== 'esm') return [...rec.exports.keys()];
    const own = new Set([...rec.mod.exports.map((e) => e[0]), ...rec.mod.reexports.map((e) => e[0])]), out = [...own];
    for (const s of rec.mod.stars) for (const nm of starNames(rec.requests[s].rec, seen)) if (nm !== 'default' && !own.has(nm) && !out.includes(nm)) out.push(nm);
    return out;
  };
  const link = (root) => {
    const fresh = [...graph(root)].filter((r) => r.kind === 'esm' && r.status === 'new');
    for (const rec of fresh) {
      const scope = Object.create(null);
      for (const b of rec.mod.imports) {
        const q = rec.requests[b.req];
        Object.defineProperty(scope, b.local, { get: b.name === '*' ? () => q.rec.ns : () => q.rec.ns[b.name], enumerable: true });
      }
      const meta = Object.create(null);
      Object.assign(meta, { dirname: path.dirname(rec.file), filename: rec.file, main: rec === N.esmMain, resolve: (s) => resolve(s, rec.file, true).url, url: rec.url });
      rec.gen = rec.fn(scope)((o) => { for (const k of Object.keys(o)) rec.exports.set(k, o[k]); }, (s, o) => dynamicImport(s, rec.file, o), meta);
      rec.gen.next();
      for (const [name, imported, r] of rec.mod.reexports) { const q = rec.requests[r]; rec.exports.set(name, imported === '*' ? () => q.rec.ns : () => q.rec.ns[imported]); }
      rec.status = 'linking';
    }
    for (const rec of fresh) for (const s of rec.mod.stars) {
      const q = rec.requests[s];
      for (const nm of starNames(q.rec)) if (nm !== 'default' && !rec.exports.has(nm)) rec.exports.set(nm, () => q.rec.ns[nm]);
    }
    for (const rec of fresh) {
      for (const b of rec.mod.imports) { const q = rec.requests[b.req]; if (b.name !== '*' && !q.rec.exports.has(b.name)) throw missing(rec, q, b.name); }
      for (const [, imported, r] of rec.mod.reexports) { const q = rec.requests[r]; if (imported !== '*' && !q.rec.exports.has(imported)) throw missing(rec, q, imported); }
    }
    for (const rec of fresh) rec.status = 'linked';
  };
  // A graph that failed to link is forgotten: its modules are read and linked again when next imported.
  const unlinkFailed = (root) => { for (const r of graph(root)) if (r.kind === 'esm' && (r.status === 'new' || r.status === 'linking')) records.delete(r.key); };

  // ---- evaluation: each module after what it imports; sync unless top-level await --------------------
  const evaluate = (rec) => {
    if (rec.status === 'evaluated') { if (rec.error) throw rec.error; return rec.promise; }
    if (rec.status === 'evaluating') return rec.promise;
    rec.status = 'evaluating';
    const steps = [...rec.requests.map((q) => () => evaluate(q.rec)), () => run(rec)];
    let i = 0;
    const go = () => { while (i < steps.length) { const r = steps[i++](); if (r && typeof r.then === 'function') return r.then(go); } return undefined; };
    let r;
    try { r = go(); } catch (e) { rec.status = 'evaluated'; rec.error = e; throw e; }
    if (!r) { rec.status = 'evaluated'; return undefined; }
    rec.promise = r.then(() => { rec.status = 'evaluated'; rec.promise = undefined; }, (e) => { rec.status = 'evaluated'; rec.error = e; rec.promise = undefined; throw e; });
    return rec.promise;
  };
  const run = (rec) => {
    if (rec.kind === 'cjs') { rec.run(); return undefined; }
    if (rec.kind !== 'esm') return undefined;
    if (rec.async) return rec.gen.next();
    rec.gen.next();
    return undefined;
  };
  const isAsyncGraph = (root) => [...graph(root)].some((r) => r.kind === 'esm' && r.async && r.status !== 'evaluated');
  const ready = (rec) => { try { link(rec); } catch (e) { unlinkFailed(rec); throw e; } return rec; };

  const dynamicImport = (spec, parent, opts) => new Promise((res, rej) => {
    try {
      const attrs = (opts && opts.with) || (opts && opts.assert) || {};
      const rec = ready(recordFor(spec, parent, attrs));
      const p = evaluate(rec);
      if (p) p.then(() => res(rec.ns), rej); else res(rec.ns);
    } catch (e) { rej(e); }
  });

  // ---- what the rest of the node calls -------------------------------------------------------------
  /** require() of an ES module: its graph evaluated now, unless it waits (ERR_REQUIRE_ASYNC_MODULE). */
  const requireESM = (file, parentModule) => {
    const rec = ready(recordOf(file, 'module'));
    if (isAsyncGraph(rec)) {
      const stack = []; for (let m = parentModule; m; m = m.parent) if (m.filename) stack.push(m.filename);
      throw err(Error, 'ERR_REQUIRE_ASYNC_MODULE', `require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\n  Required module: ${file}${stack.length ? `\n  Require stack:\n  - ${stack.join('\n  - ')}` : ''}`.replace(/\n {2}/g, '\n'));
    }
    if (rec.status === 'evaluating') throw err(Error, 'ERR_REQUIRE_CYCLE_MODULE', `Cannot require() ES Module ${file} in a cycle.`);
    evaluate(rec);
    if (rec.exports.has('module.exports')) return rec.exports.get('module.exports')();
    if (rec.exports.has('default')) return rec.facade || (rec.facade = namespace(rec, { __esModule: true }));
    return rec.ns;
  };
  /** The main module, when it is an ES module: run, its failure an uncaught exception. */
  const runMain = (file, src) => {
    let rec;
    try { rec = recordOf(file, 'module', src); N.esmMain = rec; ready(rec); } catch (e) { N.uncaught(e); return; }
    let p;
    try { p = evaluate(rec); } catch (e) { N.uncaught(e); return; }
    if (p) p.catch((e) => N.uncaught(e));
  };
  // A main module whose top-level await never settles: Node's warning, and status 13.
  N.unsettled = () => {
    const rec = N.esmMain; if (!rec || rec.status !== 'evaluating') return null;
    let where = rec.url;
    try {
      const src = rec.src, t = lex(src).find((x) => x.t === 'id' && x.v === 'await' && x.d === 0);
      if (t) { const line = src.slice(0, t.s).split('\n').length; where = `${rec.url}:${line}\n${src.split('\n')[line - 1]}\n${' '.repeat(t.s - src.lastIndexOf('\n', t.s - 1) - 1)}^\n\n\n`; }
    } catch { /* the URL alone */ }
    return `Warning: Detected unsettled top-level await at ${where}\n`;
  };
  /** A CommonJS source with import() and import.meta's uses rewritten, or null when it has none. */
  const cjsDynamic = (src) => { if (!/\bimport\s*\(/.test(src) || !codeImports(src)) return null; try { return transform(src, true).body; } catch { return null; } };
  N.esm = { isModuleSyntax, formatOf, requireESM, runMain, cjsDynamic, dynamicImport, isNamespace: (v) => namespaces.has(v), lex, transform };
  if (N.util && N.util.types) N.util.types.isModuleNamespaceObject = (v) => namespaces.has(v);
}
