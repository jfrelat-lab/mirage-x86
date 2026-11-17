// treeview: a tree view with lines and buttons, one branch opened, an item selected with the focus.
#include <windows.h>
#include <commctrl.h>

static HTREEITEM add(HWND t, HTREEITEM parent, const char *text) {
  TVINSERTSTRUCTA is = { 0 };
  is.hParent = parent; is.hInsertAfter = TVI_LAST;
  is.item.mask = TVIF_TEXT; is.item.pszText = (char *)text;
  return (HTREEITEM)SendMessageA(t, TVM_INSERTITEMA, 0, (LPARAM)&is);
}

static INT_PTR CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  (void)l;
  if (m == WM_INITDIALOG) {
    HWND t = GetDlgItem(h, 100);
    HTREEITEM fruit = add(t, TVI_ROOT, "Fruit"), veg = add(t, TVI_ROOT, "Vegetables");
    add(t, fruit, "Apple"); HTREEITEM pear = add(t, fruit, "Pear"); add(t, fruit, "Plum");
    add(t, veg, "Carrot"); add(t, veg, "Leek");
    HTREEITEM nuts = add(t, TVI_ROOT, "Nuts"); add(t, nuts, "Hazel");
    SendMessageA(t, TVM_EXPAND, TVE_EXPAND, (LPARAM)fruit);
    SendMessageA(t, TVM_SELECTITEM, TVGN_CARET, (LPARAM)pear);
    SetFocus(t);
    return FALSE;                                    // the focus set here
  }
  if (m == WM_COMMAND && (LOWORD(w) == IDOK || LOWORD(w) == IDCANCEL)) { EndDialog(h, 0); return TRUE; }
  return FALSE;
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd; (void)show;
  InitCommonControls();
  return (int)DialogBoxParamA(inst, MAKEINTRESOURCEA(1), NULL, proc, 0);
}
