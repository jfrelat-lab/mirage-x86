// dinput.js — DirectInput (the interfaces of DirectX 3-7) for MIRAGE-WIN32: dinput.dll, its COM objects
// made here as dsound.js makes DirectSound's (a pointer to a vtable of stubs that trap into the functions
// below, `this` first).
//
// A machine with no game controller: the keyboard and the mouse reach a program as window messages
// (user32), and DirectInput, asked for its joysticks (EnumDevices), lists none. Cave Story (2004) makes
// its DirectInput object at start-up and looks for a pad; without the object it does not start.
// Layouts: dinput.h (Wine's include/ as the oracle).

const DI_OK = 0, E_NOINTERFACE = 0x80004002, DIERR_DEVICENOTREG = 0x80040154;

const VTABLES = {
  IDirectInputA: 'QueryInterface:2 AddRef:0 Release:0 CreateDevice:3 EnumDevices:4 GetDeviceStatus:1 RunControlPanel:2 Initialize:2',
};
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));

export function dinputApis() {
  const objs = new Map(), vtables = new Map();
  const make = (x, iface) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('dinput.dll'), ms = METHODS[iface], v = x.win.heapAlloc(ms.length * 4);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(16);
    x.w32(p, vtables.get(iface));
    objs.set(p, { iface, ref: 1 });
    return p;
  };
  const IMPL = {
    IDirectInputA: {
      QueryInterface: (x, self, riid, pp) => { if (pp) x.w32(pp, 0); return E_NOINTERFACE; },
      AddRef: (x, self) => ++objs.get(self >>> 0).ref,
      Release: (x, self) => { const ob = objs.get(self >>> 0); if (!ob) return 0; if (--ob.ref > 0) return ob.ref; objs.delete(self >>> 0); return 0; },
      // No device by any GUID (the system keyboard and mouse included: a program here reads them as messages).
      CreateDevice: (x, self, guid, pp) => { if (pp) x.w32(pp, 0); return DIERR_DEVICENOTREG; },
      EnumDevices: () => DI_OK,                                       // none attached: the callback is never called
      GetDeviceStatus: () => DIERR_DEVICENOTREG,                      // "not attached" for any device
      RunControlPanel: () => DI_OK, Initialize: () => DI_OK,
    },
  };
  const fns = {
    // DirectInputCreateA/W(instance, version, ppDI, outer) and DirectInputCreateEx: the one object.
    DirectInputCreateA: ['pupp', (x, inst, ver, pp) => { x.w32(pp, make(x, 'IDirectInputA')); return DI_OK; }, { ordinal: 1 }],
    DirectInputCreateW: ['pupp', (x, inst, ver, pp) => { x.w32(pp, make(x, 'IDirectInputA')); return DI_OK; }, { ordinal: 3 }],
  };
  let ord = 1000;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, s] of ms) fns[`${iface}::${n}`] = ['p' + 'u'.repeat(+s), IMPL[iface][n], { ordinal: ord++ }];
  return { dll: 'dinput.dll', fns };
}
