// msgbox: MessageBox with an information icon, OK and Cancel.
#include <windows.h>

// The sample ends by itself after ten seconds: the oracle (Windows 2000 in QEMU) then runs the next.
static DWORD WINAPI quitLater(LPVOID p) { (void)p; Sleep(10000); ExitProcess(0); return 0; }

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show) {
  CreateThread(NULL, 0, quitLater, NULL, 0, NULL);
  (void)inst; (void)prev; (void)cmd; (void)show;
  return MessageBoxA(NULL, "The quick brown fox jumps over the lazy dog.\nA second line.", "Message box", MB_OKCANCEL | MB_ICONINFORMATION);
}
