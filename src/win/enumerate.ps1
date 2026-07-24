# Enumerate visible, top-level application windows with their on-screen bounds.
# Emits a JSON array: [{ handle, title, x, y, w, h }] in PHYSICAL pixels.
# Dependency-free (Win32 via Add-Type) so no native node modules are needed.

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

[WinEnum]::SetProcessDPIAware() | Out-Null

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$DWMWA_CLOAKED = 14
$DWMWA_EXTENDED_FRAME_BOUNDS = 9

$results = New-Object System.Collections.ArrayList

$cb = [WinEnum+EnumProc]{
  param($h, $l)
  try {
    if (-not [WinEnum]::IsWindowVisible($h)) { return $true }
    if ([WinEnum]::GetWindow($h, 4) -ne [IntPtr]::Zero) { return $true } # GW_OWNER=4: skip owned/tool dialogs
    $ex = [WinEnum]::GetWindowLong($h, $GWL_EXSTYLE)
    if (($ex -band $WS_EX_TOOLWINDOW) -ne 0) { return $true }

    $len = [WinEnum]::GetWindowTextLength($h)
    if ($len -le 0) { return $true }

    $cloaked = 0
    [WinEnum]::DwmGetWindowAttribute($h, $DWMWA_CLOAKED, [ref]$cloaked, 4) | Out-Null
    if ($cloaked -ne 0) { return $true } # hidden UWP ghost windows

    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [WinEnum]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $title = $sb.ToString()
    if ($title -eq 'Screenshare Annotate') { return $true } # skip only our own control window (overlay is title-less)

    $r = New-Object WinEnum+RECT
    $hr = [WinEnum]::DwmGetWindowAttribute($h, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, [Runtime.InteropServices.Marshal]::SizeOf($r))
    if ($hr -ne 0) { [WinEnum]::GetWindowRect($h, [ref]$r) | Out-Null }

    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -lt 200 -or $ht -lt 150) { return $true } # skip tiny widgets

    [void]$results.Add([pscustomobject]@{
      handle = $h.ToInt64(); title = $title; x = $r.Left; y = $r.Top; w = $w; h = $ht
    })
  } catch {}
  return $true
}

[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
# Force array form even for a single result so the consumer always gets a list.
ConvertTo-Json @($results) -Compress
