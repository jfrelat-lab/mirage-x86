// main.js — the node command: its options (-e, -p, -v, --), the main module, then the event loop. A part
// of the HLE node (src/node/kernel.js), the last one run.
export function main(N) {
  const argv = Array.from(N.bridge.argv), proc = N.process;
  const opts = { eval: null, print: false, check: false, interactive: false };
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (!a.startsWith('-') || a === '-') break;
    if (a === '-v' || a === '--version') { N.write(1, proc.version + '\n'); N.exit(0); }
    else if (a === '-h' || a === '--help') { N.write(1, 'Usage: node [options] [ script.js ] [arguments]\n       node -e "script" [arguments]\n\nMIRAGE\'s node: Node\'s API in JavaScript on MIRAGE-LINUX (CommonJS and ES modules).\n'); N.exit(0); }
    else if (a === '-e' || a === '--eval') { opts.eval = argv[++i] ?? ''; }
    else if (a === '-p' || a === '--print') { opts.eval = argv[++i] ?? ''; opts.print = true; }
    else if (a === '-pe' || a === '-ep') { opts.eval = argv[++i] ?? ''; opts.print = true; }
    else if (a.startsWith('--eval=')) opts.eval = a.slice(7);
    else if (a.startsWith('--print=')) { opts.eval = a.slice(8); opts.print = true; }
    else if (a === '-c' || a === '--check') opts.check = true;
    else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-r' || a === '--require') { (opts.preload ||= []).push(argv[++i]); }
    else if (/^--(input-type|max-old-space-size|stack-size|title|unhandled-rejections|conditions|loader|import|env-file|experimental-[\w-]+|no-[\w-]+|trace-[\w-]+|enable-source-maps|preserve-symlinks|throw-deprecation|pending-deprecation|expose-gc|harmony[\w-]*)(=.*)?$/.test(a)) {
      if (a === '--no-deprecation') proc.noDeprecation = true;
      if (a === '--no-warnings') proc.env.NODE_NO_WARNINGS = '1';
      if (/^--(input-type|title|conditions|loader|import|env-file|stack-size|max-old-space-size|unhandled-rejections)$/.test(a)) i++;
      proc.execArgv.push(a);
    } else { N.write(2, `${argv[0]}: bad option: ${a}\n`); N.exit(9); }
  }
  const rest = argv.slice(i);
  proc.argv0 = argv[0];
  const run = () => {
    for (const p of opts.preload || []) N.Module.createRequire(proc.cwd() + '/[preload]')(p);
    if (opts.eval !== null) {
      proc.argv = [proc.execPath, ...rest];
      const v = N.evalScript(opts.eval);
      if (opts.print) N.console.log(v);
    } else if (rest.length && rest[0] !== '-') {
      const file = N.path.resolve(rest[0]);
      proc.argv = [proc.execPath, file, ...rest.slice(1)];
      if (opts.check) { N.bridge.compile(N.fs.readFileSync(file, 'utf8').replace(/^#!/, '//'), file, []); N.exit(0); }
      N.runMain(file);
    } else {
      proc.argv = [proc.execPath, ...rest.slice(1)];
      if (!rest.length && proc.stdin.isTTY) {
        N.write(2, `Welcome to Node.js ${proc.version}, in MIRAGE (HLE).\nThe REPL is not here yet: give node a script, -e or -p.\n`);
        N.exit(1);
      }
      const src = N.fs.readFileSync(0, 'utf8');
      N.evalScript(src, '[stdin]');
    }
  };
  try { run(); } catch (e) { N.uncaught(e); }
  return N.loop();
}
