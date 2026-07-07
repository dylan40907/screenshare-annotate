# Track a single window's on-screen bounds and stream them as stdout lines.
# Each line: "x y w h" in PHYSICAL pixels. Prints "GONE" and exits if the
# window closes. Long-lived: the parent (Electron main) kills it when done.
param([long]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinTrack {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

[WinTrack]::SetProcessDPIAware() | Out-Null
$h = [IntPtr]$Hwnd
$DWMWA_EXTENDED_FRAME_BOUNDS = 9
$last = ''

while ($true) {
  if (-not [WinTrack]::IsWindow($h)) { Write-Output 'GONE'; [Console]::Out.Flush(); break }
  $r = New-Object WinTrack+RECT
  $hr = [WinTrack]::DwmGetWindowAttribute($h, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, [Runtime.InteropServices.Marshal]::SizeOf($r))
  if ($hr -ne 0) { [WinTrack]::GetWindowRect($h, [ref]$r) | Out-Null }
  $vis = [WinTrack]::IsWindowVisible($h)
  $line = "$($r.Left) $($r.Top) $($r.Right - $r.Left) $($r.Bottom - $r.Top) $([int]$vis)"
  if ($line -ne $last) { Write-Output $line; [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Milliseconds 120
}
