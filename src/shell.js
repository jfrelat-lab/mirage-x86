// shell.js — a COMMAND.COM-style interactive shell, implemented in JavaScript.
// It prints through the BIOS text routines (so it looks identical to guest
// output), edits an input line from the key queue, and launches .COM/.EXE/.BAT
// programs by handing them to the DOS loader. While a program runs, the shell
// is idle and the UI drives the CPU; on termination control returns here.

export class Shell {
  constructor(machine) {
    this.machine = machine;
    this.bios = machine.bios;
    this.dos = machine.dos;
    this.vfs = machine.dos.vfs;
    this.state = 'input';          // 'input' | 'running'
    this.line = '';
    this.history = [];
  }

  print(s) { this.bios.writeString(s); }
  crlf() { this.bios.teletype(0x0d); this.bios.teletype(0x0a); }

  boot() {
    this.bios.clearScreen(0x07);
    this.print('MIRAGE DOS  [Version 5.0]  —  pure-JavaScript x86 machine\r\n');
    this.print('(c) a dynamic x86→JS recompiler.  Type HELP for commands.\r\n\r\n');
    this.prompt();
  }

  prompt() { this.print(this.vfs.cwdString() + '>'); this.state = 'input'; this.line = ''; }

  // ---- line editor (called each frame while idle) ----
  pump() {
    if (this.state !== 'input') return;
    const q = this.machine.keyQueue;
    while (q.length) {
      const k = q.shift();
      const a = k.ascii;
      if (a === 0x0d) { this.crlf(); const l = this.line; this.line = ''; this.submit(l); return; }
      else if (a === 0x08) { if (this.line.length) { this.line = this.line.slice(0, -1); this.bios.teletype(0x08); this.bios.teletype(0x20); this.bios.teletype(0x08); } }
      else if (a >= 0x20 && a < 0x100) { this.line += String.fromCharCode(a); this.bios.teletype(a); }
    }
  }

  submit(line) {
    const trimmed = line.trim();
    if (trimmed) this.history.push(trimmed);
    if (!trimmed) { this.prompt(); return; }
    const sp = trimmed.indexOf(' ');
    const cmd = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim();
    const fn = this.builtins[cmd];
    try {
      if (fn) { fn.call(this, rest, trimmed); }
      else if (!this.launch(cmd, rest)) { this.print('Bad command or file name\r\n'); }
    } catch (e) { this.print('Error: ' + (e.message || e) + '\r\n'); }
    if (this.state === 'input') this.prompt();
  }

  // ---- program launching ----
  launch(name, args) {
    const tryNames = /\.[A-Z]{2,3}$/i.test(name) ? [name] : [name + '.COM', name + '.EXE', name + '.BAT'];
    for (const n of tryNames) {
      const data = this.vfs.readFile(n) || this.vfs.readFile('\\' + n);
      if (!data) continue;
      if (n.toUpperCase().endsWith('.BAT')) { this.runBatch(data); return true; }
      const tail = args ? ' ' + args : '';
      this.dos.load(data, tail, this.vfs.cwdString() + '\\' + n);
      this.state = 'running';
      return true;
    }
    return false;
  }

  runBatch(data) {
    const text = String.fromCharCode(...data).replace(/\r/g, '');
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('@') && l.slice(1).toUpperCase().startsWith('ECHO OFF')) continue;
      if (l.toUpperCase().startsWith('REM')) continue;
      this.submit(l.replace(/^@/, ''));
      if (this.state === 'running') break;   // batch pauses while a program runs
    }
  }

  programReturned() {
    // Restore the DOS-default text attribute (grey on black): a full-screen program (e.g.
    // Apogee's CATALOG paints on a blue background, attr 0x1F) leaves bios.attr set to its own
    // colour, so without this the prompt and everything typed after it would inherit that colour.
    this.bios.attr = 0x07;
    // If the program left a non-text mode (or Ctrl+C interrupted it before it reset), restore text
    // mode 3 via the BIOS (INT 10h AH=00) — this sets bios.mode AND the BDA 0x449 byte AND clears +
    // resets the DAC + mem.planar. Setting only the BDA byte (as before) left bios.mode stale, so
    // teletype kept drawing CGA-graphics-mode glyphs and the shell text came out corrupted after
    // Ctrl+C'ing a graphics program (CGA.COM, Alley Cat).
    if (this.machine.mem.r8(0x449) !== 0x03 || this.bios.mode !== 0x03) {
      this.machine.cpu.ax = 0x0003; this.machine.swInt(0x10);
    } else {
      this.bios.resetPalette(); this.crlf();
    }
    if (this.dos.exitCode) this.print(`[program exited with code ${this.dos.exitCode}]\r\n`);
    this.prompt();
  }

  // ---- helpers ----
  name83(n) {
    const dot = n.lastIndexOf('.');
    const base = (dot >= 0 ? n.slice(0, dot) : n).padEnd(8).slice(0, 8);
    const ext = (dot >= 0 ? n.slice(dot + 1) : '').padEnd(3).slice(0, 3);
    return base + ' ' + ext;
  }
}

Shell.prototype.builtins = {
  CLS() { this.bios.clearScreen(0x07); },
  ECHO(rest) { this.print((rest || '') + '\r\n'); },
  VER() { this.print('\r\nMIRAGE DOS Version 5.0\r\n'); },
  HELP() {
    this.print('\r\nBuilt-in commands:\r\n');
    this.print('  DIR  CD  CLS  TYPE  COPY  DEL  REN  MD  RD  ECHO  SET\r\n');
    this.print('  PATH  MEM  VER  DATE  TIME  VOL  HELP  EXIT\r\n');
    this.print('Run a program by typing its name (HELLO, BARS, PLASMA, ...).\r\n');
  },
  DIR(rest) {
    rest = (rest || '').trim();
    // Split an optional trailing wildcard (DIR *.EXE, DIR \GAMES\*.DAT) from the directory.
    let dirPath = rest || '.', pattern = null;
    if (/[*?]/.test(rest)) {
      const slash = Math.max(rest.lastIndexOf('\\'), rest.lastIndexOf('/'));
      pattern = rest.slice(slash + 1);
      dirPath = slash >= 0 ? (rest.slice(0, slash) || '\\') : '.';
    }
    const entries = this.vfs.list(dirPath);
    if (!entries) { this.print('File not found\r\n'); return; }
    // DOS glob → RegExp; `*` and `*.*` match everything (incl. no-extension names).
    let re = null;
    if (pattern && pattern !== '*' && pattern !== '*.*') {
      const src = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      re = new RegExp('^' + src + '$', 'i');
    }
    this.print('\r\n Volume in drive C is ' + this.vfs.label + '\r\n');
    this.print(' Directory of ' + this.vfs.cwdString() + '\r\n\r\n');
    let files = 0, bytes = 0, shown = 0;
    for (const e of entries) {
      if (re && !re.test(e.name)) continue;
      shown++;
      if (e.type === 'dir') this.print(this.name83(e.name) + '   <DIR>         06-17-26\r\n');
      else { files++; bytes += e.data.length; this.print(this.name83(e.name) + ' ' + String(e.data.length).padStart(10) + '  06-17-26\r\n'); }
    }
    if (pattern && shown === 0) { this.print('File Not Found\r\n'); return; }
    this.print('      ' + files + ' file(s) ' + String(bytes).padStart(12) + ' bytes\r\n');
    this.print('                 ' + (640 * 1024) + ' bytes free\r\n');
  },
  CD(rest) {
    if (!rest) { this.print(this.vfs.cwdString() + '\r\n'); return; }
    if (!this.vfs.chdir(rest)) this.print('The system cannot find the path specified.\r\n');
  },
  CHDIR(rest) { this.builtins.CD.call(this, rest); },
  TYPE(rest) {
    const data = this.vfs.readFile(rest);
    if (!data) { this.print('File not found\r\n'); return; }
    for (const b of data) this.bios.teletype(b);
    this.crlf();
  },
  COPY(rest) {
    const [a, b] = rest.split(/\s+/);
    const data = this.vfs.readFile(a);
    if (!data) { this.print('File not found\r\n'); return; }
    this.vfs.writeFile(b || a, data); this.print('        1 file(s) copied\r\n');
  },
  DEL(rest) { if (!this.vfs.unlink(rest)) this.print('File not found\r\n'); },
  ERASE(rest) { this.builtins.DEL.call(this, rest); },
  REN(rest) { const [a, b] = rest.split(/\s+/); if (!this.vfs.rename(a, b)) this.print('Cannot rename\r\n'); },
  RENAME(rest) { this.builtins.REN.call(this, rest); },
  MD(rest) { if (!this.vfs.mkdir(rest)) this.print('Cannot create directory\r\n'); },
  MKDIR(rest) { this.builtins.MD.call(this, rest); },
  // RD called unlink(), which refuses anything that isn't a file — so it could never actually remove
  // a directory, only print the failure. There was no rmdir primitive to call until now.
  RD(rest) { if (!this.vfs.rmdir(rest)) this.print('Cannot remove directory\r\n'); },
  RMDIR(rest) { this.builtins.RD.call(this, rest); },
  SET() { this.print('PATH=C:\\\r\nCOMSPEC=C:\\COMMAND.COM\r\nPROMPT=$p$g\r\n'); },
  PATH() { this.print('PATH=C:\\\r\n'); },
  DATE() { this.print('Current date is Wed 06-17-2026\r\n'); },
  TIME() { this.print('Current time is 12:00:00.00\r\n'); },
  VOL() { this.print(' Volume in drive C is ' + this.vfs.label + '\r\n'); },
  MEM() {
    this.print('\r\n  655360 bytes total conventional memory\r\n');
    this.print('  655360 bytes available to MS-DOS\r\n');
    this.print('  ' + (16) + ' MB total machine memory\r\n');
  },
  EXIT() { this.print('Cannot exit the MIRAGE shell.\r\n'); },
};
