// listview: a list view in report mode -- its header's columns, rows of sub-items, a row selected.
#include <windows.h>
#include <commctrl.h>

static INT_PTR CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  (void)l;
  if (m == WM_INITDIALOG) {
    HWND lv = GetDlgItem(h, 100);
    static const char *cols[] = { "Name", "Size", "Type" }; static const int widths[] = { 150, 70, 110 };
    for (int i = 0; i < 3; i++) { LVCOLUMNA c = { 0 }; c.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_FMT; c.fmt = i == 1 ? LVCFMT_RIGHT : LVCFMT_LEFT; c.cx = widths[i]; c.pszText = (char *)cols[i]; SendMessageA(lv, LVM_INSERTCOLUMNA, i, (LPARAM)&c); }
    static const char *rows[][3] = { { "readme.txt", "2 KB", "Text Document" }, { "setup.exe", "512 KB", "Application" }, { "logo.bmp", "64 KB", "Bitmap Image" }, { "notes.doc", "18 KB", "Document" } };
    for (int r = 0; r < 4; r++) {
      LVITEMA it = { 0 }; it.mask = LVIF_TEXT; it.iItem = r; it.pszText = (char *)rows[r][0]; SendMessageA(lv, LVM_INSERTITEMA, 0, (LPARAM)&it);
      for (int c = 1; c < 3; c++) { it.iSubItem = c; it.pszText = (char *)rows[r][c]; SendMessageA(lv, LVM_SETITEMTEXTA, r, (LPARAM)&it); }
    }
    LVITEMA s = { 0 }; s.stateMask = LVIS_SELECTED | LVIS_FOCUSED; s.state = LVIS_SELECTED | LVIS_FOCUSED; SendMessageA(lv, LVM_SETITEMSTATE, 1, (LPARAM)&s);
    SetFocus(lv);
    return FALSE;
  }
  if (m == WM_COMMAND && (LOWORD(w) == IDOK || LOWORD(w) == IDCANCEL)) { EndDialog(h, 0); return TRUE; }
  return FALSE;
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd; (void)show;
  INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_LISTVIEW_CLASSES }; InitCommonControlsEx(&icc);
  return (int)DialogBoxParamA(inst, MAKEINTRESOURCEA(1), NULL, proc, 0);
}
