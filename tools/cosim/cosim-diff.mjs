import { readFileSync } from 'fs';
const M = JSON.parse(readFileSync('/tmp/cosim-mirage-trace.json'));
const U = JSON.parse(readFileSync('/tmp/cosim-uc-trace.json'));
const snap = JSON.parse(readFileSync('/tmp/cosim-mirage-snap.json'));
const RAM = readFileSync('/tmp/cosim-snap.bin');
const h=(n,w=4)=>(n>>>0).toString(16).padStart(w,'0');
const FLM = 0x0CD5; // CF PF AF ZF SF DF OF (+TF/IF ignore-ish)
const gp=['ax','cx','dx','bx','sp','bp','si','di','es','ss','ds'];
const n=Math.min(M.length,U.length);
let firstDiv=-1, reason='';
for(let i=0;i<n;i++){
  const m=M[i],u=U[i];
  if(m.FAULT||u.FAULT){ reason='one faulted: M='+(m.FAULT||'')+' U='+(u.FAULT||''); firstDiv=i; break; }
  if(m.cs!==u.cs||m.ip!==u.ip){ reason='CS:IP differ'; firstDiv=i; break; }
  let rd=''; for(const r of gp) if(m[r]!==u[r]) rd+=' '+r+'(M='+h(m[r])+' U='+h(u[r])+')';
  // MUL/IMUL/DIV/IDIV leave SF/ZF/AF/PF architecturally UNDEFINED. MIRAGE matches real 8088 silicon
  // there (conformance is 100% on those vectors); Unicorn models a later CPU and differs. Comparing
  // them would report an artifact as a bug — the same trap as BCD in tools/x86-cases.mjs. Only CF
  // and OF are defined, so only those are compared after one of these.
  const prev = M[i-1];
  let mask = FLM;
  if (prev) {
    const l = ((prev.cs<<4)+prev.ip)&0xfffff;
    let k = 0; while (k < 6 && [0x26,0x2e,0x36,0x3e,0x64,0x65,0x66,0x67,0xf0,0xf2,0xf3].includes(RAM[(l+k)&0xfffff])) k++;
    const op = RAM[(l+k)&0xfffff], modrm = RAM[(l+k+1)&0xfffff];
    if (((op===0xf6||op===0xf7) && ((modrm>>3)&7)>=4) || (op===0x0f && RAM[(l+k+1)&0xfffff]===0xaf)) mask = 0x0801; // CF|OF
  }
  if((m.fl&mask)!==(u.fl&mask)) rd+=' FLAGS(M='+h(m.fl&mask)+' U='+h(u.fl&mask)+')';
  if(rd){ reason='regs differ:'+rd; firstDiv=i; break; }
}
console.log('MIRAGE steps',M.length,' Unicorn steps',U.length,' compared',n);
if(firstDiv<0){ console.log('NO DIVERGENCE in the compared window (bug is earlier — increase SNAPBACK).'); process.exit(0); }
console.log('\n*** FIRST DIVERGENCE at step',firstDiv,':',reason);
// the instruction that CAUSED it is at the PREVIOUS step's CS:IP
const p = M[firstDiv-1] || M[0];
console.log('caused by the instruction at step',firstDiv-1,'=',h(p.cs)+':'+h(p.ip));
const lin=((p.cs<<4)+p.ip)&0xfffff;
let bytes=''; for(let k=0;k<10;k++) bytes+=h(RAM[(lin+k)&0xfffff],2)+' ';
console.log('bytes @'+h(lin,5)+':',bytes);
console.log('state BEFORE (both agree, step',firstDiv-1,'):', JSON.stringify(p));
console.log('AFTER  MIRAGE (step',firstDiv,'):', JSON.stringify(M[firstDiv]));
console.log('AFTER  UNICORN(step',firstDiv,'):', JSON.stringify(U[firstDiv]));
// context: previous few CS:IP
console.log('\nprev 6 M CS:IP:', M.slice(Math.max(0,firstDiv-6),firstDiv+1).map(x=>h(x.cs)+':'+h(x.ip)).join(' '));
console.log('prev 6 U CS:IP:', U.slice(Math.max(0,firstDiv-6),firstDiv+1).map(x=>x.FAULT?'FAULT':h(x.cs)+':'+h(x.ip)).join(' '));
