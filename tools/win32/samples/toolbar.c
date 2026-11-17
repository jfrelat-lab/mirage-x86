// toolbar: a framed window with a toolbar of the standard small buttons (one pressed, one disabled, a
// separator) and a status bar in three parts.
#include <windows.h>
#include <commctrl.h>

static HWND tb, sb;
static LRESULT CALLBACK mainProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_SIZE) { SendMessageA(tb, TB_AUTOSIZE, 0, 0); SendMessageA(sb, WM_SIZE, 0, 0); return 0; }
  if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(h, m, w, l);
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd;
  INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_BAR_CLASSES }; InitCommonControlsEx(&icc);
  WNDCLASSA wc = { 0 };
  wc.lpfnWndProc = mainProc; wc.hInstance = inst; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_APPWORKSPACE + 1); wc.lpszClassName = "SampleBars";
  RegisterClassA(&wc);
  HWND main = CreateWindowExA(0, "SampleBars", "Toolbar and status bar", WS_OVERLAPPEDWINDOW, 60, 60, 460, 260, NULL, NULL, inst, NULL);
  tb = CreateWindowExA(0, TOOLBARCLASSNAMEA, NULL, WS_CHILD | WS_VISIBLE | TBSTYLE_TOOLTIPS, 0, 0, 0, 0, main, (HMENU)1, inst, NULL);
  SendMessageA(tb, TB_BUTTONSTRUCTSIZE, sizeof(TBBUTTON), 0);
  TBADDBITMAP ab = { HINST_COMMCTRL, IDB_STD_SMALL_COLOR }; SendMessageA(tb, TB_ADDBITMAP, 0, (LPARAM)&ab);
  TBBUTTON b[] = {
    { STD_FILENEW, 10, TBSTATE_ENABLED, TBSTYLE_BUTTON, {0}, 0, 0 }, { STD_FILEOPEN, 11, TBSTATE_ENABLED, TBSTYLE_BUTTON, {0}, 0, 0 },
    { STD_FILESAVE, 12, TBSTATE_ENABLED | TBSTATE_PRESSED, TBSTYLE_BUTTON, {0}, 0, 0 }, { 0, 0, TBSTATE_ENABLED, TBSTYLE_SEP, {0}, 0, 0 },
    { STD_CUT, 13, TBSTATE_ENABLED, TBSTYLE_BUTTON, {0}, 0, 0 }, { STD_COPY, 14, 0, TBSTYLE_BUTTON, {0}, 0, 0 }, { STD_PASTE, 15, TBSTATE_ENABLED, TBSTYLE_BUTTON, {0}, 0, 0 } };
  SendMessageA(tb, TB_ADDBUTTONS, 7, (LPARAM)b); SendMessageA(tb, TB_AUTOSIZE, 0, 0);
  sb = CreateWindowExA(0, STATUSCLASSNAMEA, "Ready", WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP, 0, 0, 0, 0, main, (HMENU)2, inst, NULL);
  int parts[] = { 200, 320, -1 }; SendMessageA(sb, SB_SETPARTS, 3, (LPARAM)parts);
  SendMessageA(sb, SB_SETTEXTA, 0, (LPARAM)"Ready"); SendMessageA(sb, SB_SETTEXTA, 1, (LPARAM)"Line 1"); SendMessageA(sb, SB_SETTEXTA, 2, (LPARAM)"NUM");
  ShowWindow(main, show); UpdateWindow(main);
  MSG msg;
  while (GetMessageA(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  return 0;
}
