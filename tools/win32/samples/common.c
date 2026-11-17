// common: comctl32's tab control, progress bars (blocks and smooth), a trackbar with ticks, an up-down
// control on its edit -- each in a known state.
#include <windows.h>
#include <commctrl.h>

static INT_PTR CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  (void)l;
  if (m == WM_INITDIALOG) {
    HWND tab = GetDlgItem(h, 100);
    static const char *tabs[] = { "General", "Advanced", "About" };
    for (int i = 0; i < 3; i++) { TCITEMA ti = { 0 }; ti.mask = TCIF_TEXT; ti.pszText = (char *)tabs[i]; SendMessageA(tab, TCM_INSERTITEMA, i, (LPARAM)&ti); }
    SetWindowPos(tab, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    SendDlgItemMessageA(h, 102, PBM_SETRANGE, 0, MAKELPARAM(0, 100)); SendDlgItemMessageA(h, 102, PBM_SETPOS, 60, 0);
    SendDlgItemMessageA(h, 104, TBM_SETRANGE, TRUE, MAKELPARAM(0, 10)); SendDlgItemMessageA(h, 104, TBM_SETPOS, TRUE, 3);
    SendDlgItemMessageA(h, 107, UDM_SETRANGE, 0, MAKELPARAM(99, 0)); SendDlgItemMessageA(h, 107, UDM_SETPOS, 0, MAKELPARAM(42, 0));
    SendDlgItemMessageA(h, 108, PBM_SETRANGE, 0, MAKELPARAM(0, 100)); SendDlgItemMessageA(h, 108, PBM_SETPOS, 35, 0);
    return TRUE;
  }
  if (m == WM_COMMAND && (LOWORD(w) == IDOK || LOWORD(w) == IDCANCEL)) { EndDialog(h, 0); return TRUE; }
  return FALSE;
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd; (void)show;
  INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_WIN95_CLASSES }; InitCommonControlsEx(&icc);
  return (int)DialogBoxParamA(inst, MAKEINTRESOURCEA(1), NULL, proc, 0);
}
