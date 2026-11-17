// windows: a framed window with a menu and GDI drawing, two owned popups over it -- the second over
// the first -- so that what covers what shows.
#include <windows.h>

static LRESULT CALLBACK mainProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps);
    RECT r = { 10, 10, 150, 60 };
    FillRect(dc, &r, (HBRUSH)GetStockObject(GRAY_BRUSH));
    SelectObject(dc, GetStockObject(BLACK_PEN));
    Rectangle(dc, 170, 10, 300, 60);
    Ellipse(dc, 320, 10, 420, 80);
    MoveToEx(dc, 10, 90, NULL); LineTo(dc, 420, 140);
    SetBkMode(dc, TRANSPARENT);
    TextOutA(dc, 10, 150, "GDI in the client area", 22);
    EndPaint(h, &ps);
    return 0;
  }
  if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(h, m, w, l);
}

static LRESULT CALLBACK popProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps); char t[64];
    GetWindowTextA(h, t, sizeof t);
    SetBkMode(dc, TRANSPARENT); TextOutA(dc, 8, 8, t, lstrlenA(t));
    EndPaint(h, &ps);
    return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)prev; (void)cmd;
  WNDCLASSA wc = { 0 };
  wc.lpfnWndProc = mainProc; wc.hInstance = inst; wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1); wc.lpszClassName = "SampleMain";
  RegisterClassA(&wc);
  wc.lpfnWndProc = popProc; wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1); wc.lpszClassName = "SamplePop";
  RegisterClassA(&wc);
  HMENU bar = CreateMenu(), file = CreatePopupMenu();
  AppendMenuA(file, MF_STRING, 1, "&Open"); AppendMenuA(file, MF_STRING, 2, "E&xit");
  AppendMenuA(bar, MF_POPUP, (UINT_PTR)file, "&File"); AppendMenuA(bar, MF_STRING, 3, "&Help");
  HWND main = CreateWindowExA(0, "SampleMain", "Framed window", WS_OVERLAPPEDWINDOW, 40, 40, 480, 300, NULL, bar, inst, NULL);
  ShowWindow(main, show); UpdateWindow(main);
  HWND a = CreateWindowExA(0, "SamplePop", "First popup", WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE, 300, 200, 260, 140, main, NULL, inst, NULL);
  HWND b = CreateWindowExA(0, "SamplePop", "Second popup, on top", WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE, 420, 260, 260, 140, main, NULL, inst, NULL);
  (void)a; (void)b;
  MSG msg;
  while (GetMessageA(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  return 0;
}
