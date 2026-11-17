// controls: a dialog with Windows' standard controls in known states, then nothing more.
#include <windows.h>

static INT_PTR CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  (void)l;
  if (m == WM_INITDIALOG) {
    CheckDlgButton(h, 101, BST_CHECKED);
    CheckRadioButton(h, 103, 104, 104);
    SetDlgItemTextA(h, 106, "Some text");
    SetDlgItemTextA(h, 107, "Line one\r\nLine two");
    static const char *items[] = { "Apple", "Banana", "Cherry", "Damson", "Elderberry" };
    for (int i = 0; i < 5; i++) {
      SendDlgItemMessageA(h, 108, LB_ADDSTRING, 0, (LPARAM)items[i]);
      SendDlgItemMessageA(h, 109, CB_ADDSTRING, 0, (LPARAM)items[i]);
    }
    SendDlgItemMessageA(h, 108, LB_SETCURSEL, 1, 0);
    SendDlgItemMessageA(h, 109, CB_SETCURSEL, 2, 0);
    return TRUE;                                     // the focus on the first tab stop
  }
  if (m == WM_COMMAND && (LOWORD(w) == IDOK || LOWORD(w) == IDCANCEL)) { EndDialog(h, 0); return TRUE; }
  return FALSE;
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd; (void)show;
  return (int)DialogBoxParamA(inst, MAKEINTRESOURCEA(1), NULL, proc, 0);
}
