# Win32 samples: Windows' look, Windows 2000 against MIRAGE

Small Win32 programs (MinGW-w64, C) that each put one part of Windows' standard look on the screen
and wait ten seconds: dialogs and their controls, a tree view, framed and overlapping windows, a
message box. The oracle is Windows 2000 itself -- v86's image (`boot/v86/windows2k-v2.img`) booted
in QEMU, never written -- and `tools/win32/samples.mjs` puts its screen and MIRAGE-WIN32's side by
side, with what differs in red.

    sh tools/win32/samples/build.sh          # the .exe files and samples.iso (MinGW-w64 in Docker)
    node tools/win32/samples.mjs [name...]   # the pictures, in $OUT (default /tmp/w32-samples)

Windows 2000 draws its classic look with its own fonts (MS Sans Serif, Tahoma); MIRAGE draws XP's
"Windows Classic" with Arimo for Arial, as the page does. Text differs by a pixel or two; what is
compared is the rest -- places, frames, captions, controls' faces, what covers what.

| Sample | What it shows |
|---|---|
| `controls` | a dialog: push buttons (the default one, a disabled one), check boxes, radio buttons, a group box, single- and multi-line edits, a list box, a drop-down list, statics left, centred, right |
| `treeview` | a dialog with a tree view: lines, buttons, lines at the root, an item opened, one selected |
| `windows` | a framed window with a menu, GDI drawing in its client area, and two owned popups over it |
| `msgbox` | MessageBox: an information icon's text and OK / Cancel |
| `common` | comctl32: tabs, progress bars (blocks and smooth), a trackbar with ticks, an up-down on its edit |
| `listview` | a list view in report view: its header, columns left and right, a row selected |
| `toolbar` | a window with a toolbar of the standard small buttons (pressed, disabled, a separator) and a status bar in three parts |
