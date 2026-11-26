// inspect.js — Node's util.inspect and util.format, as lib/internal/util/inspect.js lays values out: the
// same line breaking (compact 3, breakLength 80), array grouping, quoting, circular references. What
// JavaScript alone cannot see is not shown: a promise's state, a proxy's handler. A part of the HLE node
// (src/node/kernel.js).
export function inspect(N) {
  const customInspect = Symbol.for('nodejs.util.inspect.custom');
  const defaults = { showHidden: false, depth: 2, colors: false, customInspect: true, showProxy: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 80, compact: 3, sorted: false, getters: false, numericSeparator: false };
  const kObjectType = 0, kArrayType = 1, kArrayExtrasType = 2;
  const ident = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
  const proto = Object.prototype, hasOwn = (o, k) => proto.hasOwnProperty.call(o, k), toStr = (v) => proto.toString.call(v);
  const meta = ['\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',
    '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F'];
  const strEscape = (s) => {
    let quote = 39;                                                        // '
    if (s.includes("'")) { if (!s.includes('"')) quote = -2; else if (!s.includes('`') && !s.includes('${')) quote = -1; }
    const q = quote === 39 ? "'" : quote === -2 ? '"' : '`';
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === quote || c === 92 || c < 32 || c === 127 || (c >= 0xd800 && c < 0xe000)) {
        if (c === quote) out += '\\' + s[i];
        else if (c === 92) out += '\\\\';
        else if (c < 32) out += meta[c];
        else if (c === 127) out += '\\x7F';
        else {                                                             // a lone surrogate is escaped
          const d = s.charCodeAt(i + 1);
          if (c < 0xdc00 && d >= 0xdc00 && d < 0xe000) { out += s[i] + s[i + 1]; i++; } else out += `\\u${c.toString(16).toUpperCase()}`;
        }
      } else out += s[i];
    }
    return q + out + q;
  };
  const formatNumber = (n) => (Object.is(n, -0) ? '-0' : `${n}`);
  const formatPrimitive = (ctx, v) => {
    if (typeof v === 'string') {
      let trailer = '';
      if (v.length > ctx.maxStringLength) { const r = v.length - ctx.maxStringLength; v = v.slice(0, ctx.maxStringLength); trailer = `... ${r} more character${r > 1 ? 's' : ''}`; }
      if (ctx.compact !== true && v.length > 16 && v.length > ctx.breakLength - ctx.indentationLvl - 4) {
        return v.split(/(?<=\n)/).map((line) => strEscape(line)).join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`) + trailer;
      }
      return strEscape(v) + trailer;
    }
    if (typeof v === 'number') return formatNumber(v);
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'boolean') return `${v}`;
    if (typeof v === 'undefined') return 'undefined';
    return v.toString();                                                   // a symbol
  };
  const isError = (v) => v instanceof Error || toStr(v) === '[object Error]';
  const builtinTag = (v) => toStr(v).slice(8, -1);
  const getConstructorName = (obj) => {
    let o = obj, depth = 0;
    while (o !== null && o !== undefined) {
      const d = Object.getOwnPropertyDescriptor(o, 'constructor');
      if (d !== undefined && typeof d.value === 'function' && d.value.name !== '' && isInstanceof(obj, d.value)) {
        return d.value.name;
      }
      o = Object.getPrototypeOf(o); depth++;
    }
    return null;
  };
  const isInstanceof = (o, C) => { try { return o instanceof C; } catch { return false; } };
  const getPrefix = (constructor, tag, fallback, size = '') => {
    if (constructor === null) { if (tag !== '' && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `; return `[${fallback}${size}: null prototype] `; }
    if (tag !== '' && constructor !== tag) return `${constructor}${size} [${tag}] `;
    return `${constructor}${size} `;
  };
  const getKeys = (v, showHidden) => {
    const symbols = Object.getOwnPropertySymbols(v);
    let keys;
    if (showHidden) { keys = Object.getOwnPropertyNames(v); if (symbols.length) keys.push(...symbols); }
    else { keys = Object.keys(v); if (symbols.length) keys.push(...symbols.filter((s) => proto.propertyIsEnumerable.call(v, s))); }
    return keys;
  };
  const isTypedArray = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (typeof value !== 'object' && typeof value !== 'function') return formatPrimitive(ctx, value);
    if (value === null) return 'null';
    if (ctx.customInspect) {
      const f = value[customInspect];
      if (typeof f === 'function' && f !== N.inspect && !(Object.getOwnPropertyDescriptor(value, 'constructor')?.value?.prototype === value)) {
        const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
        const opts = { ...ctx, depth, stylize: (s) => s };
        delete opts.seen; delete opts.circular; delete opts.indentationLvl; delete opts.currentDepth; delete opts.budget;
        const ret = f.call(value, depth, opts, N.inspect);
        if (ret !== value) { if (typeof ret !== 'string') return formatValue(ctx, ret, recurseTimes); return ret.replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`); }
      }
    }
    if (ctx.seen.includes(value)) {
      let index = 1;
      if (ctx.circular === undefined) { ctx.circular = new Map(); ctx.circular.set(value, index); }
      else { index = ctx.circular.get(value); if (index === undefined) { index = ctx.circular.size + 1; ctx.circular.set(value, index); } }
      return `[Circular *${index}]`;
    }
    return formatRaw(ctx, value, recurseTimes, typedArray);
  }

  function formatRaw(ctx, value, recurseTimes, typedArray) {
    let keys, protoProps;
    const constructor = getConstructorName(value);
    let tag = value[Symbol.toStringTag];
    if (typeof tag !== 'string') tag = '';
    let base = '', formatter = () => [], braces, noIterator = true, i = 0, extrasType = kObjectType;
    const filter = ctx.showHidden;
    if (Symbol.iterator in value || constructor === null) {
      noIterator = false;
      if (Array.isArray(value)) {
        const prefix = (constructor !== 'Array' || tag !== '') ? getPrefix(constructor, tag, 'Array', `(${value.length})`) : '';
        keys = (ctx.showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value)).filter((k) => !/^(0|[1-9][0-9]*)$/.test(k) || +k >= 4294967295);
        const syms = Object.getOwnPropertySymbols(value).filter((s) => filter || proto.propertyIsEnumerable.call(value, s)); keys.push(...syms);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
        extrasType = kArrayExtrasType;
        formatter = formatArray;
      } else if (value instanceof Set || builtinTag(value) === 'Set') {
        const size = value.size;
        const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = formatSet;
        if (size === 0 && keys.length === 0) return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (value instanceof Map || builtinTag(value) === 'Map') {
        const prefix = getPrefix(constructor, tag, 'Map', `(${value.size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = formatMap;
        if (value.size === 0 && keys.length === 0) return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (isTypedArray(value)) {
        keys = Object.getOwnPropertyNames(value).filter((k) => !/^(0|[1-9][0-9]*)$/.test(k));
        let bound = value;
        const fallback = builtinTag(value);
        if (constructor === null) bound = new globalThis[fallback](value);
        const size = value.length;
        const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0 && !ctx.showHidden) return `${braces[0]}]`;
        formatter = (c, v, r) => formatTypedArray(bound, size, c, v, r);
        extrasType = kArrayExtrasType;
      } else if (builtinTag(value) === 'Map Iterator' || builtinTag(value) === 'Set Iterator') {
        keys = getKeys(value, ctx.showHidden);
        braces = [`[${tag}] {`, '}'];
        formatter = (c, v, r) => [...v].map((x) => formatValue(c, x, r));
      } else noIterator = true;
    }
    if (noIterator) {
      keys = getKeys(value, ctx.showHidden);
      braces = ['{', '}'];
      if (constructor === 'Object' || (constructor === null && typeof value !== 'function' && !isError(value))) {
        if (toStr(value) === '[object Arguments]') braces[0] = '[Arguments] [';
        else if (tag !== '' || constructor === null) braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
        if (toStr(value) === '[object Arguments]') { braces[1] = ']'; extrasType = kArrayExtrasType; formatter = formatArray; if (value.length === 0 && keys.length === 0) return '[Arguments] []'; }
        else if (keys.length === 0 && protoProps === undefined) return `${braces[0]}}`;
      } else if (typeof value === 'function') {
        base = getFunctionBase(value, constructor, tag);
        if (keys.length === 0 && protoProps === undefined) return base;
      } else if (value instanceof RegExp || builtinTag(value) === 'RegExp') {
        base = RegExp.prototype.toString.call(constructor !== null ? value : new RegExp(value));
        const prefix = getPrefix(constructor, tag, 'RegExp');
        if (prefix !== 'RegExp ') base = `${prefix}${base}`;
        if ((keys.length === 0 && protoProps === undefined) || (recurseTimes > ctx.depth && ctx.depth !== null)) return base;
      } else if (value instanceof Date || builtinTag(value) === 'Date') {
        const t = Date.prototype.getTime.call(value);
        base = Number.isNaN(t) ? Date.prototype.toString.call(value) : Date.prototype.toISOString.call(value);
        const prefix = getPrefix(constructor, tag, 'Date');
        if (prefix !== 'Date ') base = `${prefix}${base}`;
        if (keys.length === 0 && protoProps === undefined) return base;
      } else if (isError(value)) {
        base = formatError(value, constructor, tag, ctx, keys);
        if (keys.length === 0 && protoProps === undefined) return base;
      } else if (value instanceof ArrayBuffer || builtinTag(value) === 'ArrayBuffer' || builtinTag(value) === 'SharedArrayBuffer') {
        const arrayType = builtinTag(value);
        const prefix = getPrefix(constructor, tag, arrayType);
        if (typedArray === undefined) formatter = formatArrayBuffer;
        else if (keys.length === 0 && protoProps === undefined) return prefix + `{ byteLength: ${formatNumber(value.byteLength)} }`;
        braces[0] = `${prefix}{`;
        keys.unshift('byteLength');
      } else if (value instanceof DataView) {
        braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
        keys.unshift('byteLength', 'byteOffset', 'buffer');
      } else if (value instanceof Promise || builtinTag(value) === 'Promise') {
        braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
        formatter = () => ['<state unknown>'];                             // what JavaScript cannot see
      } else if (value instanceof WeakSet || builtinTag(value) === 'WeakSet') {
        braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
        formatter = () => ['<items unknown>'];
      } else if (value instanceof WeakMap || builtinTag(value) === 'WeakMap') {
        braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
        formatter = () => ['<items unknown>'];
      } else if (value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt || value instanceof Symbol
        || ['Number', 'String', 'Boolean', 'BigInt', 'Symbol'].includes(builtinTag(value))) {
        const [type, prim] = boxed(value);
        let b = `[${type}`;
        if (type !== constructor) b += constructor === null ? ' (null prototype)' : ` (${constructor})`;
        b += `: ${formatPrimitive({ ...ctx, compact: true }, prim)}]`;
        if (tag !== '' && tag !== constructor) b += ` [${tag}]`;
        base = b;
        if (type === 'String') keys = keys.filter((k) => !/^(0|[1-9][0-9]*)$/.test(k) || +k >= prim.length);
        if (keys.length === 0 && protoProps === undefined) return base;
      } else {
        if (keys.length === 0 && protoProps === undefined) return `${getCtxName(constructor, tag, 'Object')}{}`;
        braces[0] = `${getCtxName(constructor, tag, 'Object')}{`;
      }
    }
    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      let name = getCtxName(constructor, tag, 'Object').slice(0, -1);
      if (constructor !== null) name = `[${name}]`;
      return name;
    }
    recurseTimes += 1;
    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    let output;
    try {
      output = formatter(ctx, value, recurseTimes);
      for (i = 0; i < keys.length; i++) output.push(formatProperty(ctx, value, recurseTimes, keys[i], extrasType));
    } finally { ctx.seen.pop(); }
    if (ctx.circular !== undefined) {
      const index = ctx.circular.get(value);
      if (index !== undefined) {
        const reference = `<ref *${index}>`;
        if (ctx.compact !== true) base = base === '' ? reference : `${reference} ${base}`;
        else braces[0] = `${reference} ${braces[0]}`;
      }
    }
    if (ctx.sorted) { const cmp = ctx.sorted === true ? undefined : ctx.sorted; if (extrasType === kObjectType) output.sort(cmp); }
    const res = reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
    return res;
  }
  const boxed = (v) => {
    for (const [T, name] of [[Number, 'Number'], [String, 'String'], [Boolean, 'Boolean'], [BigInt, 'BigInt'], [Symbol, 'Symbol']]) {
      try { return [name, T.prototype.valueOf.call(v)]; } catch { /* not this one */ }
    }
    return ['Object', undefined];
  };
  const getCtxName = (constructor, tag, fallback) => {
    if (constructor === null) { if (tag !== '' && fallback !== tag) return `[${fallback}: null prototype] [${tag}] `; return `[${fallback}: null prototype] `; }
    if (tag !== '' && constructor !== tag) return `${constructor} [${tag}] `;
    return `${constructor} `;
  };
  const getFunctionBase = (value, constructor, tag) => {
    const src = Function.prototype.toString.call(value);
    if (src.startsWith('class') && src.endsWith('}')) {
      const slice = src.slice(5, -1), bracketIndex = slice.indexOf('{');
      if (bracketIndex !== -1 && (!slice.slice(0, bracketIndex).includes('(') || /^\s*(?:extends|\s)/.test(slice))) {
        let b = `[class ${value.name || '(anonymous)'}`;
        if (constructor !== 'Function' && constructor !== null) b += ` [${constructor}]`;
        if (tag !== '' && constructor !== tag) b += ` [${tag}]`;
        if (constructor === null) b += ' extends [null prototype]';
        else { const sup = Object.getPrototypeOf(value); if (sup && sup.name) b += ` extends ${sup.name}`; }
        return b + ']';
      }
    }
    let type = 'Function';
    const t = builtinTag(value);
    if (t === 'GeneratorFunction') type = 'GeneratorFunction';
    else if (t === 'AsyncGeneratorFunction') type = 'AsyncGeneratorFunction';
    else if (t === 'AsyncFunction') type = 'AsyncFunction';
    let b = `[${type}`;
    if (constructor === null) b += ' (null prototype)';
    if (value.name === '') b += ' (anonymous)'; else b += `: ${value.name}`;
    b += ']';
    if (constructor !== type && constructor !== null) b += ` ${constructor}`;
    if (tag !== '' && constructor !== tag) b += ` [${tag}]`;
    return b;
  };
  const formatError = (err, constructor, tag, ctx, keys) => {
    const name = err.name != null ? String(err.name) : 'Error';
    let stack = err.stack ? String(err.stack) : Error.prototype.toString.call(err);
    for (const k of ['name', 'message', 'stack']) { const i = keys.indexOf(k); if (i !== -1 && (k !== 'name' || stack.includes(err.name))) keys.splice(i, 1); }
    if ('cause' in err && !keys.includes('cause')) keys.push('cause');
    if (Array.isArray(err.errors) && !keys.includes('errors')) keys.push('errors');
    // improveStack: the class's name where it is not the error's ("E2 [Error]: q")
    let len = name.length;
    if (constructor === null || (name.endsWith('Error') && stack.startsWith(name) && (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
      let fallback = 'Error';
      if (constructor === null) { const start = /^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n\s+at)/.exec(stack) || /^([a-z_A-Z0-9-]*Error)$/.exec(stack); fallback = (start && start[1]) || ''; len = fallback.length; fallback ||= 'Error'; }
      const prefix = getPrefix(constructor, tag, fallback).slice(0, -1);
      if (name !== prefix) stack = prefix.includes(name) ? (len === 0 ? `${prefix}: ${stack}` : `${prefix}${stack.slice(len)}`) : `${prefix} [${name}]${stack.slice(len)}`;
    }
    let pos = (err.message && stack.indexOf(err.message)) || -1;
    if (pos !== -1) pos += err.message.length;
    const atLine = stack.indexOf('\n    at', pos);
    if (atLine === -1) stack = `[${stack}]`;
    if (ctx.indentationLvl !== 0) stack = stack.split('\n').join(`\n${' '.repeat(ctx.indentationLvl)}`);
    return stack;
  };
  const formatArrayBuffer = (ctx, value) => {
    const u = new Uint8Array(value);
    let str = Array.from(u.subarray(0, Math.min(ctx.maxArrayLength, u.length)), (b) => b.toString(16).padStart(2, '0')).join(' ');
    const remaining = u.length - ctx.maxArrayLength;
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    return [`[Uint8Contents]: <${str}>`];
  };
  const formatArray = (ctx, value, recurseTimes) => {
    const valLen = value.length, len = Math.min(Math.max(0, ctx.maxArrayLength), valLen), remaining = valLen - len, output = [];
    for (let i = 0; i < len; i++) {
      if (!hasOwn(value, i)) return formatArrayHoles(ctx, value, recurseTimes, len, output, i);
      output.push(formatProperty(ctx, value, recurseTimes, i, kArrayType));
    }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    return output;
  };
  const formatArrayHoles = (ctx, value, recurseTimes, outputLength, output, i) => {
    const keys = Object.keys(value);
    let index = i;
    for (; i < keys.length && output.length < outputLength; i++) {
      const key = keys[i], tmp = +key;
      if (tmp > 2 ** 32 - 2) break;
      if (`${index}` !== key) {
        if (!/^(0|[1-9][0-9]*)$/.test(key)) break;
        const emptyItems = tmp - index;
        output.push(`<${emptyItems} empty item${emptyItems > 1 ? 's' : ''}>`);
        index = tmp;
        if (output.length === outputLength) break;
      }
      output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
      index++;
    }
    const remaining = value.length - index;
    if (output.length !== outputLength) {
      if (remaining > 0) output.push(`<${remaining} empty item${remaining > 1 ? 's' : ''}>`);
    } else if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    return output;
  };
  const formatTypedArray = (value, length, ctx, ignored, recurseTimes) => {
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length), remaining = value.length - maxLength;
    const output = new Array(maxLength);
    const fmt = value.length > 0 && typeof value[0] === 'bigint' ? (n) => `${n}n` : formatNumber;
    for (let i = 0; i < maxLength; ++i) output[i] = fmt(value[i]);
    if (remaining > 0) output[maxLength] = `... ${remaining} more item${remaining > 1 ? 's' : ''}`;
    if (ctx.showHidden) {
      ctx.indentationLvl += 2;
      for (const key of ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer']) output.push(`[${key}]: ${formatValue(ctx, value[key], recurseTimes, true)}`);
      ctx.indentationLvl -= 2;
    }
    return output;
  };
  const formatSet = (ctx, value, recurseTimes) => {
    const length = value.size, maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length), remaining = length - maxLength, output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const v of value) { if (i >= maxLength) break; output.push(formatValue(ctx, v, recurseTimes)); i++; }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    ctx.indentationLvl -= 2;
    return output;
  };
  const formatMap = (ctx, value, recurseTimes) => {
    const length = value.size, maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length), remaining = length - maxLength, output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const [k, v] of value) { if (i >= maxLength) break; output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`); i++; }
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
    ctx.indentationLvl -= 2;
    return output;
  };
  function formatProperty(ctx, value, recurseTimes, key, type) {
    let name, str;
    let extra = ' ';
    const desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key], enumerable: false };
    if (desc.value !== undefined) {
      const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
      ctx.indentationLvl += diff;
      str = formatValue(ctx, desc.value, recurseTimes);
      if (diff === 3 && ctx.breakLength < getStringWidth(str)) extra = `\n${' '.repeat(ctx.indentationLvl)}`;
      ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
      const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
      if (ctx.getters && (ctx.getters === true || (ctx.getters === 'get' && desc.set === undefined) || (ctx.getters === 'set' && desc.set !== undefined))) {
        try { const tmp = desc.get.call(value); ctx.indentationLvl += 2; str = tmp === null ? `[${label}: null]` : typeof tmp === 'object' ? `[${label}] ${formatValue(ctx, tmp, recurseTimes)}` : `[${label}: ${formatPrimitive(ctx, tmp)}]`; ctx.indentationLvl -= 2; }
        catch (err) { str = `[${label}: <Inspection threw (${err.message})>]`; }
      } else str = `[${label}]`;
    } else if (desc.set !== undefined) str = '[Setter]';
    else str = 'undefined';
    if (type === kArrayType) return str;
    if (typeof key === 'symbol') name = desc.enumerable === false ? `[${key.toString()}]` : key.toString().replace(/[\x00-\x1f\x27\x5c\x7f-\x9f]/g, (c) => strEscape(c).slice(1, -1));
    else if (key === '__proto__') name = "['__proto__']";
    else if (desc.enumerable === false) name = `[${ident.test(key) ? key : strEscape(key)}]`;
    else if (ident.test(key)) name = key;
    else name = strEscape(key);
    return `${name}:${extra}${str}`;
  }
  const getStringWidth = (s) => s.length;
  const isBelowBreakLength = (ctx, output, start, base) => {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (let i = 0; i < output.length; i++) { totalLength += output[i].length; if (totalLength > ctx.breakLength) return false; }
    return base === '' || !base.includes('\n');
  };
  const groupArrayElements = (ctx, output, value) => {
    let totalLength = 0, maxLength = 0, i = 0, outputLength = output.length;
    if (ctx.maxArrayLength < output.length) outputLength--;
    const separatorSpace = 2, dataLen = new Array(outputLength);
    for (; i < outputLength; i++) { const len = getStringWidth(output[i]); dataLen[i] = len; totalLength += len + separatorSpace; if (maxLength < len) maxLength = len; }
    const actualMax = maxLength + separatorSpace;
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
      const approxCharHeights = 2.5, averageBias = Math.sqrt(actualMax - totalLength / output.length), biasedMax = Math.max(actualMax - 3 - averageBias, 1);
      const columns = Math.min(Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax), Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax), ctx.compact * 4, 15);
      if (columns <= 1) return output;
      const tmp = [], maxLineLength = [];
      for (let c = 0; c < columns; c++) {
        let lineLength = 0;
        for (let j = c; j < output.length; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j];
        maxLineLength.push(lineLength + separatorSpace);
      }
      let order = 'padStart';
      if (value !== undefined) for (let k = 0; k < output.length; k++) if (typeof value[k] !== 'number' && typeof value[k] !== 'bigint') { order = 'padEnd'; break; }
      for (let k = 0; k < outputLength; k += columns) {
        const max = Math.min(k + columns, outputLength);
        let s = '', j = k;
        for (; j < max - 1; j++) { const padding = maxLineLength[j - k] + output[j].length - dataLen[j]; s += `${output[j]}, `[order](padding, ' '); }
        if (order === 'padStart') { const padding = maxLineLength[j - k] + output[j].length - dataLen[j] - separatorSpace; s += output[j].padStart(padding, ' '); }
        else s += output[j];
        tmp.push(s);
      }
      if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
      output = tmp;
    }
    return output;
  };
  const reduceToSingleString = (ctx, output, base, braces, extrasType, recurseTimes, value) => {
    if (ctx.compact !== true) {
      if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
        const entries = output.length;
        if (extrasType === kArrayExtrasType && entries > 6) output = groupArrayElements(ctx, output, value);
        if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
          const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
          if (isBelowBreakLength(ctx, output, start, base)) {
            const joined = output.join(', ');
            if (!joined.includes('\n')) return `${base ? `${base} ` : ''}${braces[0]} ${joined}` + ` ${braces[1]}`;
          }
        }
      }
      const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
      return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) return `${braces[0]}${base ? ` ${base}` : ''} ${output.join(', ')} ` + braces[1];
    const indentation = ' '.repeat(ctx.indentationLvl);
    const ln = base === '' && braces[0].length === 1 ? ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
    return `${braces[0]}${ln}${output.join(`,\n${indentation}  `)} ${braces[1]}`;
  };

  function inspectValue(value, opts) {
    const ctx = { budget: {}, indentationLvl: 0, seen: [], currentDepth: 0, stylize: (s) => s, ...defaults };
    if (arguments.length > 1) {
      if (typeof opts === 'boolean') ctx.showHidden = opts;
      else if (opts) for (const k of Object.keys(opts)) if (hasOwn(defaults, k) || k === 'stylize') ctx[k] = opts[k];
      if (arguments.length > 2 && arguments[2] !== undefined) ctx.depth = arguments[2];
    }
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
  }
  inspectValue.custom = customInspect;
  inspectValue.defaultOptions = defaults;
  inspectValue.colors = Object.assign(Object.create(null), { bold: [1, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], white: [37, 39], grey: [90, 39], black: [30, 39], blue: [34, 39], cyan: [36, 39], green: [32, 39], magenta: [35, 39], red: [31, 39], yellow: [33, 39] });
  inspectValue.styles = Object.assign(Object.create(null), { special: 'cyan', number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'grey', null: 'bold', string: 'green', symbol: 'green', date: 'magenta', regexp: 'red', module: 'underline' });

  const formatWithOptions = (opts, ...args) => {
    const first = args[0];
    let a = 0, str = '', join = '';
    if (typeof first === 'string') {
      if (args.length === 1) return first;
      let tempStr, lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) === 37) {                                  // %
          const next = first.charCodeAt(++i);
          if (a + 1 !== args.length) {
            switch (next) {
              case 115: {                                                  // s
                const arg = args[++a];
                if (typeof arg === 'number') tempStr = formatNumber(arg);
                else if (typeof arg === 'bigint') tempStr = `${arg}n`;
                else if (typeof arg !== 'object' || arg === null || !hasBuiltInToString(arg)) tempStr = String(arg);
                else tempStr = inspectValue(arg, { ...opts, depth: 0, colors: false, compact: 3 });
                break;
              }
              case 106: tempStr = tryStringify(args[++a]); break;           // j
              case 100: {                                                  // d
                const n = args[++a];
                tempStr = typeof n === 'bigint' ? `${n}n` : typeof n === 'symbol' ? 'NaN' : formatNumber(Number(n));
                break;
              }
              case 79: tempStr = inspectValue(args[++a], opts); break;      // O
              case 111: tempStr = inspectValue(args[++a], { ...opts, showHidden: true, showProxy: true, depth: 4 }); break;   // o
              case 105: {                                                  // i
                const n = args[++a];
                tempStr = typeof n === 'bigint' ? `${n}n` : typeof n === 'symbol' ? 'NaN' : formatNumber(Number.parseInt(n));
                break;
              }
              case 102: { const n = args[++a]; tempStr = typeof n === 'symbol' ? 'NaN' : formatNumber(Number.parseFloat(n)); break; }   // f
              case 99: a += 1; tempStr = ''; break;                         // c
              case 37: str += first.slice(lastPos, i); lastPos = i + 1; continue;
              default: continue;
            }
            if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
            str += tempStr; lastPos = i + 1;
          } else if (next === 37) { str += first.slice(lastPos, i); lastPos = i + 1; }
        }
      }
      if (lastPos !== 0) { a++; join = ' '; if (lastPos < first.length) str += first.slice(lastPos); }
    }
    while (a < args.length) {
      const v = args[a];
      str += join;
      str += typeof v !== 'string' ? inspectValue(v, opts) : v;
      join = ' '; a++;
    }
    return str;
  };
  const builtIns = new Set(Object.getOwnPropertyNames(globalThis).filter((k) => /^[A-Z][a-zA-Z0-9]+$/.test(k)));
  const hasBuiltInToString = (v) => {
    if (typeof v.toString !== 'function') return true;
    if (hasOwn(v, 'toString')) return false;
    let p = v;
    do { p = Object.getPrototypeOf(p); } while (!hasOwn(p, 'toString'));
    const d = Object.getOwnPropertyDescriptor(p, 'constructor');
    return d !== undefined && typeof d.value === 'function' && builtIns.has(d.value.name);
  };
  const tryStringify = (v) => { try { return JSON.stringify(v); } catch (e) { if (/circular/i.test(e.message)) return '[Circular]'; throw e; } };
  N.inspect = inspectValue;
  N.format = (...args) => formatWithOptions(undefined, ...args);
  N.formatWithOptions = (opts, ...args) => formatWithOptions(opts, ...args);
  N.strEscape = strEscape;
}
