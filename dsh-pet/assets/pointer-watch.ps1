# 使用 UTF-8 BOM 兼容 Windows PowerShell 5.1；不设置或绕过执行策略。
# 标准输入：enable 序号、disable 序号、exit；关闭输入也会卸钩退出。
# 标准输出：按下事件，或 {"ready":true,"enabled":布尔值,"id":序号}。
# 初始确认序号为零且未启用；诊断仅写标准错误。不读取键盘或窗口标题。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshPointerWatch
{
    private const int WH_MOUSE_LL = 14;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_CONTROL = 0x8001;
    private const int MaxQueued = 1024;
    private static readonly ConcurrentQueue<Output> Queue = new ConcurrentQueue<Output>();
    private static readonly AutoResetEvent OutputReady = new AutoResetEvent(false);
    private static readonly HookProc Callback = OnMouse;
    private static IntPtr hook = IntPtr.Zero;
    private static uint mainThread;
    private static int queued;
    private static volatile bool stopping;
    private static string failure;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseData
    {
        public Point pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
        public uint lPrivate;
    }

    private struct Output
    {
        public bool ready;
        public bool enabled;
        public int id;
        public int x;
        public int y;
        public long time;
        public string button;
        public uint pid;
    }

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    private static void Fail(string message)
    {
        Interlocked.CompareExchange(ref failure, message, null);
        PostThreadMessage(mainThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }

    private static void Enqueue(Output value)
    {
        if (stopping || failure != null) return;
        if (Interlocked.Increment(ref queued) > MaxQueued)
        {
            Interlocked.Decrement(ref queued);
            Fail("鼠标事件输出积压超过限制，已停止监听。");
            return;
        }
        Queue.Enqueue(value);
        OutputReady.Set();
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        // 先放行其他钩子；这里不写管道、不等待输出线程，也不拦截任何输入。
        IntPtr result = CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        if (code < 0 || stopping || hook == IntPtr.Zero) return result;
        try
        {
            string button;
            switch (wParam.ToInt64())
            {
                case 0x0201: button = "left"; break;
                case 0x0204: button = "right"; break;
                case 0x0207: button = "middle"; break;
                default: return result;
            }
            MouseData data = (MouseData)Marshal.PtrToStructure(lParam, typeof(MouseData));
            uint tick = GetTickCount();
            long unixNow = (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
            // 无符号减法处理约 49.7 天的 tick 回绕；必须在回调内校准而非输出时取时间。
            long eventTime = unixNow - unchecked(tick - data.time);
            uint pid;
            GetWindowThreadProcessId(WindowFromPoint(data.pt), out pid);
            Enqueue(new Output { x = data.pt.x, y = data.pt.y, time = eventTime, button = button, pid = pid });
        }
        catch (Exception error)
        {
            Fail("鼠标钩子回调失败：" + error.Message);
        }
        return result;
    }

    private static void WriteOutput()
    {
        try
        {
            while (!stopping)
            {
                Output value;
                if (!Queue.TryDequeue(out value))
                {
                    OutputReady.WaitOne();
                    continue;
                }
                Interlocked.Decrement(ref queued);
                string line = value.ready
                    ? string.Format(CultureInfo.InvariantCulture,
                        "{{\"ready\":true,\"enabled\":{0},\"id\":{1}}}", value.enabled ? "true" : "false", value.id)
                    : string.Format(CultureInfo.InvariantCulture,
                        "{{\"x\":{0},\"y\":{1},\"time\":{2},\"button\":\"{3}\",\"pid\":{4}}}",
                        value.x, value.y, value.time, value.button, value.pid);
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }
        catch (Exception error)
        {
            Fail("鼠标监听输出管道失败：" + error.Message);
        }
    }

    private static void ReadCommands()
    {
        try
        {
            // 限制控制行长度；读取线程只投递消息，钩子的安装和卸载属于消息循环线程。
            StringBuilder line = new StringBuilder();
            while (!stopping)
            {
                int next = Console.In.Read();
                if (next < 0)
                {
                    PostThreadMessage(mainThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                    return;
                }
                if (next == '\r') continue;
                if (next != '\n')
                {
                    if (line.Length >= 64) throw new InvalidOperationException("控制行超过限制。");
                    line.Append((char)next);
                    continue;
                }
                string command = line.ToString();
                line.Length = 0;
                if (command == "exit")
                {
                    PostThreadMessage(mainThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                    return;
                }
                string[] parts = command.Split(' ');
                int id;
                if (parts.Length != 2 || (parts[0] != "enable" && parts[0] != "disable") ||
                    !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out id) || id <= 0)
                    throw new InvalidOperationException("未知鼠标监听控制命令。");
                if (!PostThreadMessage(mainThread, WM_CONTROL,
                    new UIntPtr(parts[0] == "enable" ? 1u : 0u), new IntPtr(id)))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "投递鼠标监听控制消息失败。");
            }
        }
        catch (Exception error)
        {
            Fail("鼠标监听输入管道失败：" + error.Message);
        }
    }

    private static void Enable(bool enabled)
    {
        if (enabled && hook == IntPtr.Zero)
        {
            hook = SetWindowsHookEx(WH_MOUSE_LL, Callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "注册 WH_MOUSE_LL 鼠标钩子失败。");
        }
        else if (!enabled && hook != IntPtr.Zero)
        {
            if (!UnhookWindowsHookEx(hook))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "卸载鼠标钩子失败。");
            hook = IntPtr.Zero;
        }
    }

    public static int Run()
    {
        Thread writer = new Thread(WriteOutput);
        writer.IsBackground = true;
        Thread reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        try
        {
            mainThread = GetCurrentThreadId();
            Message message;
            // 在启动控制线程前创建线程消息队列，避免首次启停消息投递失败。
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            Enqueue(new Output { ready = true, enabled = false, id = 0 });
            writer.Start();
            reader.Start();
            while (true)
            {
                int result = GetMessage(out message, IntPtr.Zero, 0, 0);
                if (result == 0) break;
                if (result == -1) throw new Win32Exception(Marshal.GetLastWin32Error(), "鼠标消息循环失败。");
                if (failure != null) break;
                if (message.message == WM_CONTROL)
                {
                    bool enabled = message.wParam.ToUInt64() != 0;
                    Enable(enabled);
                    // 确认必须与事件共用一个有序输出队列，供 Node 丢弃启停切换前的旧事件。
                    Enqueue(new Output { ready = true, enabled = enabled, id = message.lParam.ToInt32() });
                }
                else
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
        }
        catch (Exception error)
        {
            Interlocked.CompareExchange(ref failure, error.Message, null);
        }
        finally
        {
            stopping = true;
            try { Enable(false); }
            catch (Exception error) { Interlocked.CompareExchange(ref failure, error.Message, null); }
            OutputReady.Set();
            // 输出管道可能被对端阻塞；后台线程不能阻止卸钩和进程退出。
            if (writer.IsAlive) writer.Join(100);
            Output unused;
            while (Queue.TryDequeue(out unused)) { }
        }
        if (failure != null)
        {
            Console.Error.WriteLine(failure);
            return 1;
        }
        return 0;
    }
}
'@
    exit ([DshPointerWatch]::Run())
} catch {
    [Console]::Error.WriteLine(('鼠标监听初始化失败：' + $_.Exception.Message))
    exit 1
}
