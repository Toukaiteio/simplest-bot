import { spawnSync } from "node:child_process";
import type { BotToolRegistration, ToolExecuteResult } from "../../tooling.js";
import type { BotConfig } from "../../types.js";
import { assertToolAccess } from "../../security/access-control.js";

type DesktopWindow = {
  handle: string;
  processId: number;
  processName: string;
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
};

type CapturePayload = {
  mime_type: "image/png" | "image/jpeg";
  width: number;
  height: number;
  base64: string;
};

/** Desktop inspection is intentionally only part of the real admin flow. */
export function createDesktopToolRegistrations(config: BotConfig): BotToolRegistration[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "desktop_list_windows",
          description: "列出 Windows 当前可见顶层窗口及其进程、标题、句柄和边界。仅管理员真实环境流可用。",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      },
      execute: async (_args, input) => {
        assertToolAccess("desktop_list_windows", input, config);
        const windows = listDesktopWindows();
        return JSON.stringify({ windows, count: windows.length });
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "desktop_screenshot",
          description: "获取 Windows 桌面截图。mode=screen 截取全屏虚拟桌面；mode=window 按 windowId、processId、processName 或 titleContains 截取指定窗口。仅管理员真实环境流可用。",
          parameters: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["screen", "window"], description: "screen=全屏，window=指定窗口" },
              windowId: { type: "string", description: "窗口句柄；先调用 desktop_list_windows 获取" },
              processId: { type: "number", description: "进程 ID；可用于选择该进程的唯一窗口" },
              processName: { type: "string", description: "进程名（不含 .exe），精确匹配" },
              titleContains: { type: "string", description: "窗口标题包含的文本" },
              format: { type: "string", enum: ["jpeg", "png"], description: "图片格式，默认 jpeg" },
              maxBytes: { type: "number", description: "最大图片字节数，默认 8388608" },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
      execute: async (args, input) => {
        assertToolAccess("desktop_screenshot", input, config);
        const mode = args.mode === "window" ? "window" : "screen";
        const format = args.format === "png" ? "png" : "jpeg";
        const maxBytes = Math.min(16 * 1024 * 1024, Math.max(256 * 1024, Number(args.maxBytes) || 8 * 1024 * 1024));

        if (mode === "screen") {
          return makeCaptureResult(captureDesktop("screen", format), "全屏虚拟桌面", maxBytes);
        }

        const windows = listDesktopWindows();
        const selected = selectWindow(windows, args);
        return makeCaptureResult(
          captureDesktop("window", format, selected.handle),
          `窗口 ${selected.processName}：${selected.title || "（无标题）"}`,
          maxBytes,
        );
      },
    },
  ];
}

function listDesktopWindows(): DesktopWindow[] {
  ensureWindows();
  const raw = runPowerShell({ mode: "list" });
  const parsed = parseJson<unknown>(raw);
  if (!parsed) return [];
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
    .map((value) => ({
      handle: String(value.Handle ?? value.handle ?? ""),
      processId: Number(value.ProcessId ?? value.processId ?? 0),
      processName: String(value.ProcessName ?? value.processName ?? ""),
      title: String(value.Title ?? value.title ?? ""),
      left: Number(value.Left ?? value.left ?? 0),
      top: Number(value.Top ?? value.top ?? 0),
      width: Number(value.Width ?? value.width ?? 0),
      height: Number(value.Height ?? value.height ?? 0),
      minimized: Boolean(value.Minimized ?? value.minimized),
    }))
    .filter((window) => window.handle && window.processId > 0 && window.width > 0 && window.height > 0);
}

function selectWindow(windows: DesktopWindow[], args: Record<string, unknown>): DesktopWindow {
  const requestedHandle = typeof args.windowId === "string" || typeof args.windowId === "number"
    ? String(args.windowId).trim()
    : "";
  const processId = Number(args.processId);
  const processName = typeof args.processName === "string" ? args.processName.trim().toLowerCase() : "";
  const titleContains = typeof args.titleContains === "string" ? args.titleContains.trim().toLowerCase() : "";

  if (!requestedHandle && !Number.isInteger(processId) && !processName && !titleContains) {
    throw new Error("mode=window 时至少提供 windowId、processId、processName 或 titleContains。");
  }
  if (requestedHandle && !/^\d+$/.test(requestedHandle)) {
    throw new Error("windowId 必须是 desktop_list_windows 返回的数字句柄。");
  }

  const matches = windows.filter((window) => (
    (!requestedHandle || window.handle === requestedHandle)
    && (!Number.isInteger(processId) || window.processId === processId)
    && (!processName || window.processName.toLowerCase() === processName || `${window.processName}.exe`.toLowerCase() === processName)
    && (!titleContains || window.title.toLowerCase().includes(titleContains))
  ));

  if (matches.length === 0) throw new Error("没有找到匹配的可见窗口，请先调用 desktop_list_windows。");
  if (matches.length > 1) {
    if (requestedHandle || titleContains) {
      throw new Error(`匹配到 ${matches.length} 个窗口，请使用 windowId 精确选择。`);
    }
    // A process selector is allowed to resolve to its largest non-minimized
    // top-level window, which is normally the application's main window.
    matches.sort((left, right) => {
      if (left.minimized !== right.minimized) return left.minimized ? 1 : -1;
      return right.width * right.height - left.width * left.height;
    });
  }
  return matches[0];
}

function captureDesktop(mode: "screen" | "window", format: "jpeg" | "png", handle?: string): CapturePayload {
  const raw = runPowerShell({
    mode,
    format,
    windowId: handle ?? "",
  });
  const payload = parseJson<Partial<CapturePayload>>(raw);
  if (!payload || (payload.mime_type !== "image/png" && payload.mime_type !== "image/jpeg") || typeof payload.base64 !== "string") {
    throw new Error("Windows 截图返回格式无效。");
  }
  return {
    mime_type: payload.mime_type,
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    base64: payload.base64,
  };
}

function makeCaptureResult(payload: CapturePayload, label: string, maxBytes: number): ToolExecuteResult {
  const byteLength = Math.floor(payload.base64.length * 3 / 4);
  if (byteLength > maxBytes) {
    throw new Error(`截图约 ${byteLength} 字节，超过 maxBytes=${maxBytes}；请改用 jpeg 或提高上限。`);
  }
  return {
    text: `已获取${label}截图：${payload.width}x${payload.height}，${byteLength} 字节。`,
    media: [{ type: "image", mime: payload.mime_type, base64: payload.base64 }],
  };
}

function ensureWindows(): void {
  if (process.platform !== "win32") throw new Error("桌面截图工具仅支持 Windows。");
}

function runPowerShell(values: { mode: "list" | "screen" | "window"; format?: "jpeg" | "png"; windowId?: string }): string {
  const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? "",
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      AGENT_DESKTOP_MODE: values.mode,
      AGENT_DESKTOP_FORMAT: values.format ?? "jpeg",
      AGENT_DESKTOP_WINDOW_ID: values.windowId ?? "",
    },
  });
  if (result.error) throw new Error(`启动 PowerShell 截图 helper 失败：${result.error.message}`);
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(stderr || `PowerShell 截图 helper 退出码 ${result.status ?? -1}`);
  }
  return String(result.stdout ?? "").trim();
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`截图 helper 返回了无效 JSON：${value.slice(0, 300)}`);
  }
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public sealed class AgentDesktopWindow {
    public string Handle { get; set; }
    public int ProcessId { get; set; }
    public string ProcessName { get; set; }
    public string Title { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Minimized { get; set; }
}

public sealed class AgentDesktopCapture {
    public byte[] Bytes { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public static class AgentDesktopNative {
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);

    public static AgentDesktopWindow[] ListWindows() {
        var result = new List<AgentDesktopWindow>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var titleLength = GetWindowTextLength(hWnd);
            if (titleLength <= 0) return true;
            Rect rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            var title = new System.Text.StringBuilder(titleLength + 1);
            GetWindowText(hWnd, title, title.Capacity);
            var processName = "";
            try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }
            result.Add(new AgentDesktopWindow {
                Handle = hWnd.ToInt64().ToString(),
                ProcessId = (int)processId,
                ProcessName = processName,
                Title = title.ToString(),
                Left = rect.Left,
                Top = rect.Top,
                Width = width,
                Height = height,
                Minimized = IsIconic(hWnd),
            });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static AgentDesktopCapture CaptureScreen(bool jpeg) {
        var left = GetSystemMetrics(SmXVirtualScreen);
        var top = GetSystemMetrics(SmYVirtualScreen);
        var width = GetSystemMetrics(SmCxVirtualScreen);
        var height = GetSystemMetrics(SmCyVirtualScreen);
        if (width <= 0 || height <= 0) throw new InvalidOperationException("无法获取虚拟桌面尺寸");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            return new AgentDesktopCapture { Bytes = Encode(bitmap, jpeg), Width = width, Height = height };
        }
    }

    public static AgentDesktopCapture CaptureWindow(long handle, bool jpeg) {
        var hWnd = new IntPtr(handle);
        Rect rect;
        if (!GetWindowRect(hWnd, out rect)) throw new InvalidOperationException("无法获取窗口边界");
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) throw new InvalidOperationException("窗口尺寸无效");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            var printed = false;
            using (var graphics = Graphics.FromImage(bitmap)) {
                var hdc = graphics.GetHdc();
                try { printed = PrintWindow(hWnd, hdc, 2); }
                finally { graphics.ReleaseHdc(hdc); }
            }
            if (!printed) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                }
            }
            return new AgentDesktopCapture { Bytes = Encode(bitmap, jpeg), Width = width, Height = height };
        }
    }

    private static byte[] Encode(Bitmap bitmap, bool jpeg) {
        using (var stream = new MemoryStream()) {
            if (!jpeg) {
                bitmap.Save(stream, ImageFormat.Png);
            } else {
                var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), item => item.MimeType == "image/jpeg");
                using (var parameters = new EncoderParameters(1)) {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                    bitmap.Save(stream, codec, parameters);
                }
            }
            return stream.ToArray();
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Drawing'

$mode = $env:AGENT_DESKTOP_MODE
if ($mode -eq 'list') {
    [AgentDesktopNative]::ListWindows() | ConvertTo-Json -Compress -Depth 4
    exit 0
}

$jpeg = $env:AGENT_DESKTOP_FORMAT -ne 'png'
if ($mode -eq 'screen') {
    $capture = [AgentDesktopNative]::CaptureScreen($jpeg)
} elseif ($mode -eq 'window') {
    if (-not ($env:AGENT_DESKTOP_WINDOW_ID -match '^\d+$')) { throw '窗口句柄无效' }
    $capture = [AgentDesktopNative]::CaptureWindow([Int64]$env:AGENT_DESKTOP_WINDOW_ID, $jpeg)
} else {
    throw '截图模式无效'
}

$mime = if ($jpeg) { 'image/jpeg' } else { 'image/png' }
@{
    mime_type = $mime
    width = $capture.Width
    height = $capture.Height
    base64 = [Convert]::ToBase64String($capture.Bytes)
} | ConvertTo-Json -Compress -Depth 4
`;
