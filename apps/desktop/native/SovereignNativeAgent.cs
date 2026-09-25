using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class SovereignNativeAgent
{
    private const int EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;

        public COORD(short x, short y)
        {
            X = x;
            Y = y;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)] // x64 INPUT reserves the full MOUSEINPUT union size.
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr hFile,
        byte[] lpBuffer,
        int nNumberOfBytesToRead,
        out int lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr hFile,
        byte[] lpBuffer,
        int nNumberOfBytesToWrite,
        out int lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        int dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    private sealed class ConPtyState : IDisposable
    {
        public IntPtr PseudoConsole = IntPtr.Zero;
        public IntPtr ProcessHandle = IntPtr.Zero;
        public IntPtr ThreadHandle = IntPtr.Zero;
        public IntPtr InputWriteHandle = IntPtr.Zero;
        public IntPtr OutputReadHandle = IntPtr.Zero;
        public IntPtr AttributeList = IntPtr.Zero;
        public IntPtr AttributeValue = IntPtr.Zero;
        public NamedPipeServerStream CommandPipe;
        public StreamReader CommandReader;
        public StreamWriter CommandWriter;
        public readonly object InputLock = new object();
        public volatile bool Closing;

        public void Dispose()
        {
            Closing = true;
            if (CommandReader != null)
            {
                CommandReader.Dispose();
                CommandReader = null;
            }
            if (CommandWriter != null)
            {
                CommandWriter.Dispose();
                CommandWriter = null;
            }
            if (CommandPipe != null)
            {
                CommandPipe.Dispose();
                CommandPipe = null;
            }
            if (InputWriteHandle != IntPtr.Zero)
            {
                CloseHandle(InputWriteHandle);
                InputWriteHandle = IntPtr.Zero;
            }
            if (OutputReadHandle != IntPtr.Zero)
            {
                CloseHandle(OutputReadHandle);
                OutputReadHandle = IntPtr.Zero;
            }
            if (ThreadHandle != IntPtr.Zero)
            {
                CloseHandle(ThreadHandle);
                ThreadHandle = IntPtr.Zero;
            }
            if (ProcessHandle != IntPtr.Zero)
            {
                CloseHandle(ProcessHandle);
                ProcessHandle = IntPtr.Zero;
            }
            if (AttributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(AttributeList);
                Marshal.FreeHGlobal(AttributeList);
                AttributeList = IntPtr.Zero;
            }
            if (AttributeValue != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(AttributeValue);
                AttributeValue = IntPtr.Zero;
            }
            if (PseudoConsole != IntPtr.Zero)
            {
                ClosePseudoConsole(PseudoConsole);
                PseudoConsole = IntPtr.Zero;
            }
        }
    }

    private static readonly object OutputLock = new object();

    private static void Emit(params string[] fields)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(string.Join("\t", fields));
            Console.Out.Flush();
        }
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
    }

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private const int LEFT_ALT_PRESSED = 0x0002;
    private const int LEFT_CTRL_PRESSED = 0x0008;
    private const int SHIFT_PRESSED = 0x0010;
    private const uint MAPVK_VK_TO_VSC = 0;
    private const int VK_PACKET = 0x00E7;

    private static void AppendWin32KeyRecord(
        StringBuilder output,
        int virtualKey,
        int scanCode,
        int unicodeCharacter,
        bool keyDown,
        int controlKeyState)
    {
        output
            .Append('\x1b')
            .Append('[')
            .Append(virtualKey)
            .Append(';')
            .Append(scanCode)
            .Append(';')
            .Append(unicodeCharacter)
            .Append(';')
            .Append(keyDown ? 1 : 0)
            .Append(';')
            .Append(controlKeyState)
            .Append(";1_");
    }

    private static byte[] EncodeWin32TextInput(string text)
    {
        StringBuilder output = new StringBuilder(Math.Max(64, text.Length * 64));
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (character == '\n' && index > 0 && text[index - 1] == '\r')
            {
                continue;
            }

            int virtualKey;
            int scanCode;
            int unicodeCharacter = character;
            int controlKeyState = 0;
            if (character == '\r' || character == '\n')
            {
                virtualKey = 0x0D;
                scanCode = 0x1C;
                unicodeCharacter = 0x0D;
            }
            else if (character == '\t')
            {
                virtualKey = 0x09;
                scanCode = 0x0F;
                unicodeCharacter = 0x09;
            }
            else if (character == '\b' || character == 0x7F)
            {
                virtualKey = 0x08;
                scanCode = 0x0E;
                unicodeCharacter = 0x08;
            }
            else if (character == 0x1B)
            {
                virtualKey = 0x1B;
                scanCode = 0x01;
            }
            else if (character == ' ')
            {
                virtualKey = 0x20;
                scanCode = 0x39;
            }
            else
            {
                short keyScan = VkKeyScanW(character);
                if (keyScan == -1)
                {
                    virtualKey = VK_PACKET;
                    scanCode = 0;
                }
                else
                {
                    virtualKey = keyScan & 0xFF;
                    int modifierState = (keyScan >> 8) & 0xFF;
                    if ((modifierState & 1) != 0) controlKeyState |= SHIFT_PRESSED;
                    if ((modifierState & 2) != 0) controlKeyState |= LEFT_CTRL_PRESSED;
                    if ((modifierState & 4) != 0) controlKeyState |= LEFT_ALT_PRESSED;
                    scanCode = unchecked((int)MapVirtualKeyW((uint)virtualKey, MAPVK_VK_TO_VSC));
                }
            }

            int activeState = 0;
            if ((controlKeyState & LEFT_CTRL_PRESSED) != 0)
            {
                activeState |= LEFT_CTRL_PRESSED;
                AppendWin32KeyRecord(output, 0x11, 0x1D, 0, true, activeState);
            }
            if ((controlKeyState & LEFT_ALT_PRESSED) != 0)
            {
                activeState |= LEFT_ALT_PRESSED;
                AppendWin32KeyRecord(output, 0x12, 0x38, 0, true, activeState);
            }
            if ((controlKeyState & SHIFT_PRESSED) != 0)
            {
                activeState |= SHIFT_PRESSED;
                AppendWin32KeyRecord(output, 0x10, 0x2A, 0, true, activeState);
            }

            AppendWin32KeyRecord(
                output,
                virtualKey,
                scanCode,
                unicodeCharacter,
                true,
                activeState);
            AppendWin32KeyRecord(
                output,
                virtualKey,
                scanCode,
                unicodeCharacter,
                false,
                activeState);

            if ((controlKeyState & SHIFT_PRESSED) != 0)
            {
                activeState &= ~SHIFT_PRESSED;
                AppendWin32KeyRecord(output, 0x10, 0x2A, 0, false, activeState);
            }
            if ((controlKeyState & LEFT_ALT_PRESSED) != 0)
            {
                activeState &= ~LEFT_ALT_PRESSED;
                AppendWin32KeyRecord(output, 0x12, 0x38, 0, false, activeState);
            }
            if ((controlKeyState & LEFT_CTRL_PRESSED) != 0)
            {
                activeState &= ~LEFT_CTRL_PRESSED;
                AppendWin32KeyRecord(output, 0x11, 0x1D, 0, false, activeState);
            }
        }
        return Encoding.UTF8.GetBytes(output.ToString());
    }

    private static void WriteConPtyInput(ConPtyState state, byte[] data)
    {
        lock (state.InputLock)
        {
            int written;
            if (!WriteFile(
                state.InputWriteHandle,
                data,
                data.Length,
                out written,
                IntPtr.Zero) || written != data.Length)
            {
                throw new InvalidOperationException(
                    "WriteFile(ConPTY input) failed: " + Marshal.GetLastWin32Error());
            }
            Emit("INPUT", written.ToString());
        }
    }

    private static int ParseInt(string value, int minimum, int maximum, string name)
    {
        int parsed;
        if (!int.TryParse(value, out parsed) || parsed < minimum || parsed > maximum)
        {
            throw new ArgumentException(name + " is out of range.");
        }
        return parsed;
    }

    private static string QuoteCommandLineArgument(string value)
    {
        if (value == null)
        {
            return "\"\"";
        }
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private const string CONPTY_DONE_PREFIX = "__SCR_CONPTY_DONE__:";

    private static void WriteConPtyShellOutput(
        StreamWriter outputWriter,
        string value,
        bool newline)
    {
        string payload = newline ? value + "\r\n" : value;
        lock (outputWriter)
        {
            outputWriter.WriteLine("D\t" + Encode(payload));
            outputWriter.Flush();
        }
    }

    private static void QueuePowerShellCommand(Process powerShell, string command)
    {
        if (powerShell.HasExited)
        {
            throw new InvalidOperationException("The PowerShell bridge exited before accepting input.");
        }
        string encodedCommand = Convert.ToBase64String(Encoding.UTF8.GetBytes(command));
        powerShell.StandardInput.WriteLine(encodedCommand);
        powerShell.StandardInput.Flush();
    }

    private static bool DrainConPtyShellInput(
        StringBuilder pending,
        string payload,
        Process powerShell,
        StreamWriter outputWriter)
    {
        pending.Append(payload);
        while (true)
        {
            int terminator = -1;
            for (int index = 0; index < pending.Length; index++)
            {
                char character = pending[index];
                if (character == '\r' || character == '\n')
                {
                    terminator = index;
                    break;
                }
            }
            if (terminator < 0)
            {
                return true;
            }

            int terminatorLength = 1;
            if (
                pending[terminator] == '\r' &&
                terminator + 1 < pending.Length &&
                pending[terminator + 1] == '\n')
            {
                terminatorLength = 2;
            }
            string command = pending.ToString(0, terminator);
            pending.Remove(0, terminator + terminatorLength);
            WriteConPtyShellOutput(outputWriter, command, true);

            string normalized = command.Trim();
            if (normalized.Length == 0)
            {
                WriteConPtyShellOutput(outputWriter, "PS> ", false);
                continue;
            }
            if (string.Equals(normalized, "exit", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            QueuePowerShellCommand(powerShell, command);
        }
    }

    private static int RunConPtyShell(string[] args)
    {
        if (args.Length < 4)
        {
            throw new ArgumentException("conpty-shell requires a pipe, PowerShell path, and cwd.");
        }

        string pipeName = Decode(args[1]);
        string shell = Decode(args[2]);
        string cwd = Decode(args[3]);
        using (NamedPipeClientStream commandPipe = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.None))
        {
            commandPipe.Connect(5000);
            using (StreamReader commandReader = new StreamReader(
                commandPipe,
                new UTF8Encoding(false),
                false,
                4096,
                true))
            using (StreamWriter outputWriter = new StreamWriter(
                commandPipe,
                new UTF8Encoding(false),
                4096,
                true))
            using (ManualResetEvent bootstrapReady = new ManualResetEvent(false))
            using (Process powerShell = new Process())
            {
                outputWriter.AutoFlush = true;
                string bootstrapMarker = "__SCR_CONPTY_BOOTSTRAP__" + Guid.NewGuid().ToString("N");
                string bridgeScript =
                    "$ErrorActionPreference='Continue'; " +
                    "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
                    "[Console]::Out.WriteLine('" + bootstrapMarker + "'); " +
                    "while (($scrLine=[Console]::In.ReadLine()) -ne $null) { " +
                    "if ($scrLine -eq '__SCR_CONPTY_CLOSE__') { break }; " +
                    "try { $scrCommand=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($scrLine)); " +
                    ". ([ScriptBlock]::Create($scrCommand)) } " +
                    "catch { [Console]::Error.WriteLine(($_ | Out-String)) } " +
                    "finally { [Console]::Out.WriteLine('" + CONPTY_DONE_PREFIX +
                    "' + [Guid]::NewGuid().ToString('N')) } }";
                string encodedBridgeScript = Convert.ToBase64String(
                    Encoding.Unicode.GetBytes(bridgeScript));
                powerShell.StartInfo = new ProcessStartInfo
                {
                    FileName = shell,
                    Arguments =
                        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " +
                        encodedBridgeScript,
                    WorkingDirectory = cwd,
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                powerShell.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    string outputLine = eventArgs.Data;
                    if (outputLine == null)
                    {
                        return;
                    }
                    if (string.Equals(outputLine, bootstrapMarker, StringComparison.Ordinal))
                    {
                        bootstrapReady.Set();
                        return;
                    }
                    if (outputLine.StartsWith(CONPTY_DONE_PREFIX, StringComparison.Ordinal))
                    {
                        WriteConPtyShellOutput(outputWriter, "PS> ", false);
                        return;
                    }
                    WriteConPtyShellOutput(outputWriter, outputLine, true);
                };
                powerShell.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data != null)
                    {
                        WriteConPtyShellOutput(outputWriter, "[stderr] " + eventArgs.Data, true);
                    }
                };

                if (!powerShell.Start())
                {
                    throw new InvalidOperationException("PowerShell bridge could not be started.");
                }
                powerShell.BeginOutputReadLine();
                powerShell.BeginErrorReadLine();
                if (!bootstrapReady.WaitOne(5000))
                {
                    throw new InvalidOperationException("PowerShell bridge did not become ready.");
                }

                WriteConPtyShellOutput(outputWriter, "SCR_CONPTY_BOOTSTRAP_READY", true);
                WriteConPtyShellOutput(outputWriter, "PS> ", false);
                StringBuilder pending = new StringBuilder();
                string line;
                bool keepRunning = true;
                while (keepRunning && (line = commandReader.ReadLine()) != null)
                {
                    if (line == "C")
                    {
                        break;
                    }
                    int tab = line.IndexOf('\t');
                    if (tab <= 0 || line.Substring(0, tab) != "K")
                    {
                        continue;
                    }
                    string payload = Decode(line.Substring(tab + 1));
                    keepRunning = DrainConPtyShellInput(
                        pending,
                        payload,
                        powerShell,
                        outputWriter);
                }

                try
                {
                    powerShell.StandardInput.WriteLine("__SCR_CONPTY_CLOSE__");
                    powerShell.StandardInput.Flush();
                    powerShell.StandardInput.Close();
                }
                catch
                {
                    // The PowerShell bridge may already have exited.
                }
                if (!powerShell.WaitForExit(2000))
                {
                    powerShell.Kill();
                    powerShell.WaitForExit(2000);
                }
                return powerShell.HasExited ? powerShell.ExitCode : 0;
            }
        }
    }

    private static int RunConPty(string[] args)
    {
        if (args.Length < 5)
        {
            throw new ArgumentException("conpty requires shell, cwd, columns, and rows.");
        }

        string shell = Decode(args[1]);
        string cwd = Decode(args[2]);
        short columns = checked((short)ParseInt(args[3], 20, 500, "columns"));
        short rows = checked((short)ParseInt(args[4], 5, 200, "rows"));

        IntPtr inputRead;
        IntPtr inputWrite;
        IntPtr outputRead;
        IntPtr outputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0))
        {
            throw new InvalidOperationException("CreatePipe(input) failed: " + Marshal.GetLastWin32Error());
        }
        if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
        {
            CloseHandle(inputRead);
            CloseHandle(inputWrite);
            throw new InvalidOperationException("CreatePipe(output) failed: " + Marshal.GetLastWin32Error());
        }

        string commandPipeName = "scr-conpty-" + Guid.NewGuid().ToString("N");
        ConPtyState state = new ConPtyState();
        state.CommandPipe = new NamedPipeServerStream(
            commandPipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
        try
        {
            int result = CreatePseudoConsole(new COORD(columns, rows), inputRead, outputWrite, 0, out state.PseudoConsole);
            if (result != 0)
            {
                throw new InvalidOperationException("CreatePseudoConsole failed: " + result);
            }

            state.InputWriteHandle = inputWrite;
            state.OutputReadHandle = outputRead;
            inputWrite = IntPtr.Zero;
            outputRead = IntPtr.Zero;

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            state.AttributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(state.AttributeList, 1, 0, ref attributeListSize))
            {
                throw new InvalidOperationException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
            }
            if (!UpdateProcThreadAttribute(
                state.AttributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
                state.PseudoConsole,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new InvalidOperationException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = state.AttributeList;
            PROCESS_INFORMATION processInfo;
            string helperPath = Application.ExecutablePath;
            StringBuilder commandLine = new StringBuilder(
                QuoteCommandLineArgument(helperPath) +
                " conpty-shell " +
                QuoteCommandLineArgument(Encode(commandPipeName)) + " " +
                QuoteCommandLineArgument(Encode(shell)) + " " +
                QuoteCommandLineArgument(Encode(cwd))
            );
            if (!CreateProcessW(
                helperPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero,
                cwd,
                ref startup,
                out processInfo))
            {
                throw new InvalidOperationException("CreateProcessW failed: " + Marshal.GetLastWin32Error());
            }
            CloseHandle(inputRead);
            CloseHandle(outputWrite);
            inputRead = IntPtr.Zero;
            outputWrite = IntPtr.Zero;
            state.ProcessHandle = processInfo.hProcess;
            state.ThreadHandle = processInfo.hThread;

            IAsyncResult connection = state.CommandPipe.BeginWaitForConnection(null, null);
            WaitHandle connectionWait = connection.AsyncWaitHandle;
            bool connected = connectionWait.WaitOne(5000);
            if (!connected)
            {
                connectionWait.Close();
                TerminateProcess(state.ProcessHandle, 132);
                throw new InvalidOperationException("The ConPTY command bridge did not connect.");
            }
            state.CommandPipe.EndWaitForConnection(connection);
            connectionWait.Close();
            state.CommandReader = new StreamReader(
                state.CommandPipe,
                new UTF8Encoding(false),
                false,
                4096,
                true);
            state.CommandWriter = new StreamWriter(
                state.CommandPipe,
                new UTF8Encoding(false),
                4096,
                true);
            state.CommandWriter.AutoFlush = true;

            Emit("READY", processInfo.dwProcessId.ToString());

            Thread bridgeOutputThread = new Thread(delegate()
            {
                try
                {
                    string bridgeLine;
                    while (
                        !state.Closing &&
                        (bridgeLine = state.CommandReader.ReadLine()) != null)
                    {
                        string[] bridgeFields = bridgeLine.Split('\t');
                        if (bridgeFields.Length != 2)
                        {
                            continue;
                        }
                        if (bridgeFields[0] == "D")
                        {
                            Emit("DATA", bridgeFields[1]);
                        }
                        else if (bridgeFields[0] == "E")
                        {
                            Emit("ERROR", bridgeFields[1]);
                        }
                    }
                }
                catch (Exception error)
                {
                    if (!state.Closing)
                    {
                        Emit("ERROR", Encode(error.Message));
                    }
                }
            });
            bridgeOutputThread.IsBackground = true;
            bridgeOutputThread.Start();

            Thread outputThread = new Thread(delegate()
            {
                byte[] buffer = new byte[8192];
                try
                {
                    while (!state.Closing)
                    {
                        int count;
                        if (!ReadFile(state.OutputReadHandle, buffer, buffer.Length, out count, IntPtr.Zero))
                        {
                            int readError = Marshal.GetLastWin32Error();
                            if (state.Closing || readError == 109 || readError == 232)
                            {
                                break;
                            }
                            throw new InvalidOperationException("ReadFile(ConPTY output) failed: " + readError);
                        }
                        if (count <= 0)
                        {
                            break;
                        }
                        byte[] chunk = new byte[count];
                        Buffer.BlockCopy(buffer, 0, chunk, 0, count);
                        Emit("DATA", Convert.ToBase64String(chunk));
                    }
                }
                catch (Exception error)
                {
                    if (!state.Closing)
                    {
                        Emit("ERROR", Encode(error.Message));
                    }
                }
            });
            outputThread.IsBackground = true;
            outputThread.Start();

            Thread commandThread = new Thread(delegate()
            {
                try
                {
                    string line;
                    while (!state.Closing && (line = Console.In.ReadLine()) != null)
                    {
                        string[] fields = line.Split('\t');
                        if (fields.Length == 0)
                        {
                            continue;
                        }
                        if (fields[0] == "I" && fields.Length == 2)
                        {
                            // Terminal query responses are not required by the command bridge.
                            continue;
                        }
                        else if (fields[0] == "K" && fields.Length == 2)
                        {
                            byte[] payload = Convert.FromBase64String(fields[1]);
                            state.CommandWriter.WriteLine("K\t" + fields[1]);
                            state.CommandWriter.Flush();
                            Emit("INPUT", payload.Length.ToString());
                        }
                        else if (fields[0] == "R" && fields.Length == 3)
                        {
                            short nextColumns = checked((short)ParseInt(fields[1], 20, 500, "columns"));
                            short nextRows = checked((short)ParseInt(fields[2], 5, 200, "rows"));
                            int resizeResult = ResizePseudoConsole(state.PseudoConsole, new COORD(nextColumns, nextRows));
                            if (resizeResult != 0)
                            {
                                Emit("ERROR", Encode("ResizePseudoConsole failed: " + resizeResult));
                            }
                        }
                        else if (fields[0] == "C")
                        {
                            state.CommandWriter.WriteLine("C");
                            state.CommandWriter.Flush();
                            if (WaitForSingleObject(state.ProcessHandle, 2000) != WAIT_OBJECT_0)
                            {
                                TerminateProcess(state.ProcessHandle, 130);
                            }
                            state.Closing = true;
                            break;
                        }
                    }
                    if (!state.Closing)
                    {
                        try
                        {
                            state.CommandWriter.WriteLine("C");
                            state.CommandWriter.Flush();
                        }
                        catch
                        {
                            // The command bridge may already be closed.
                        }
                        if (WaitForSingleObject(state.ProcessHandle, 2000) != WAIT_OBJECT_0)
                        {
                            TerminateProcess(state.ProcessHandle, 130);
                        }
                        state.Closing = true;
                    }
                }
                catch (Exception error)
                {
                    if (!state.Closing)
                    {
                        Emit("ERROR", Encode(error.Message));
                        state.Closing = true;
                        TerminateProcess(state.ProcessHandle, 131);
                    }
                }
            });
            commandThread.IsBackground = true;
            commandThread.Start();

            uint waitResult = WaitForSingleObject(state.ProcessHandle, INFINITE);
            uint exitCode = 1;
            if (waitResult == WAIT_OBJECT_0)
            {
                GetExitCodeProcess(state.ProcessHandle, out exitCode);
            }
            state.Closing = true;
            if (state.InputWriteHandle != IntPtr.Zero)
            {
                CloseHandle(state.InputWriteHandle);
                state.InputWriteHandle = IntPtr.Zero;
            }
            if (state.OutputReadHandle != IntPtr.Zero)
            {
                CloseHandle(state.OutputReadHandle);
                state.OutputReadHandle = IntPtr.Zero;
            }
            outputThread.Join(1000);
            bridgeOutputThread.Join(1000);
            Emit("EXIT", exitCode.ToString());
            return unchecked((int)exitCode);
        }
        finally
        {
            if (inputRead != IntPtr.Zero) CloseHandle(inputRead);
            if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
            if (outputRead != IntPtr.Zero) CloseHandle(outputRead);
            if (outputWrite != IntPtr.Zero) CloseHandle(outputWrite);
            state.Dispose();
        }
    }

    private static int RunComputerObserve(string[] args)
    {
        if (args.Length < 2)
        {
            throw new ArgumentException("computer-observe requires an output path.");
        }
        string outputPath = Decode(args[1]);
        string outputDirectory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(outputDirectory))
        {
            Directory.CreateDirectory(outputDirectory);
        }

        Rectangle screen = SystemInformation.VirtualScreen;
        using (Bitmap image = new Bitmap(screen.Width, screen.Height, PixelFormat.Format24bppRgb))
        using (Graphics graphics = Graphics.FromImage(image))
        {
            graphics.CopyFromScreen(screen.Left, screen.Top, 0, 0, screen.Size, CopyPixelOperation.SourceCopy);
            ImageCodecInfo codec = null;
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            for (int index = 0; index < codecs.Length; index++)
            {
                if (codecs[index].FormatID == ImageFormat.Jpeg.Guid)
                {
                    codec = codecs[index];
                    break;
                }
            }
            if (codec == null)
            {
                image.Save(outputPath, ImageFormat.Jpeg);
            }
            else
            {
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 72L);
                    image.Save(outputPath, codec, parameters);
                }
            }
        }

        Emit(
            "SCREEN",
            screen.Left.ToString(),
            screen.Top.ToString(),
            screen.Width.ToString(),
            screen.Height.ToString());

        EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            if (!IsWindowVisible(window))
            {
                return true;
            }
            int titleLength = GetWindowTextLengthW(window);
            if (titleLength <= 0)
            {
                return true;
            }
            StringBuilder title = new StringBuilder(titleLength + 1);
            GetWindowTextW(window, title, title.Capacity);
            RECT rectangle;
            if (!GetWindowRect(window, out rectangle))
            {
                return true;
            }
            int width = rectangle.Right - rectangle.Left;
            int height = rectangle.Bottom - rectangle.Top;
            if (width <= 0 || height <= 0)
            {
                return true;
            }
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            Emit(
                "WINDOW",
                window.ToInt64().ToString("X"),
                processId.ToString(),
                rectangle.Left.ToString(),
                rectangle.Top.ToString(),
                width.ToString(),
                height.ToString(),
                Encode(title.ToString()));
            return true;
        }, IntPtr.Zero);
        Emit("DONE");
        return 0;
    }

    private static IntPtr ParseWindowHandle(string value)
    {
        long parsed;
        if (!long.TryParse(value, System.Globalization.NumberStyles.HexNumber, null, out parsed))
        {
            throw new ArgumentException("Window id is invalid.");
        }
        return new IntPtr(parsed);
    }

    private static void SendUnicodeText(string text)
    {
        List<INPUT> inputs = new List<INPUT>();
        for (int index = 0; index < text.Length; index++)
        {
            ushort character = text[index];
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wScan = character;
            down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT up = down;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            inputs.Add(down);
            inputs.Add(up);
        }
        INPUT[] array = inputs.ToArray();
        if (array.Length > 0 && SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT))) != array.Length)
        {
            throw new InvalidOperationException("SendInput(text) failed: " + Marshal.GetLastWin32Error());
        }
    }

    private static ushort KeyCode(string key)
    {
        string normalized = key.ToUpperInvariant();
        Dictionary<string, ushort> values = new Dictionary<string, ushort>();
        values["ENTER"] = 0x0D;
        values["ESCAPE"] = 0x1B;
        values["ESC"] = 0x1B;
        values["TAB"] = 0x09;
        values["BACKSPACE"] = 0x08;
        values["DELETE"] = 0x2E;
        values["UP"] = 0x26;
        values["DOWN"] = 0x28;
        values["LEFT"] = 0x25;
        values["RIGHT"] = 0x27;
        values["HOME"] = 0x24;
        values["END"] = 0x23;
        values["PAGEUP"] = 0x21;
        values["PAGEDOWN"] = 0x22;
        values["SPACE"] = 0x20;
        ushort value;
        if (values.TryGetValue(normalized, out value))
        {
            return value;
        }
        if (normalized.Length == 1)
        {
            char character = normalized[0];
            if ((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9'))
            {
                return character;
            }
        }
        if (normalized.StartsWith("F"))
        {
            int functionNumber;
            if (int.TryParse(normalized.Substring(1), out functionNumber) && functionNumber >= 1 && functionNumber <= 24)
            {
                return checked((ushort)(0x70 + functionNumber - 1));
            }
        }
        throw new ArgumentException("Unsupported key: " + key);
    }

    private static void SendVirtualKey(ushort key)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.U.ki.wVk = key;
        INPUT up = down;
        up.U.ki.dwFlags = KEYEVENTF_KEYUP;
        INPUT[] inputs = new INPUT[] { down, up };
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2)
        {
            throw new InvalidOperationException("SendInput(key) failed: " + Marshal.GetLastWin32Error());
        }
    }

    private static int RunComputerAction(string[] args)
    {
        if (args.Length < 2)
        {
            throw new ArgumentException("computer-action requires an operation.");
        }
        string operation = args[1];
        if (operation == "focus")
        {
            if (args.Length < 3) throw new ArgumentException("focus requires a window id.");
            IntPtr window = ParseWindowHandle(args[2]);
            ShowWindowAsync(window, 9);
            if (!SetForegroundWindow(window))
            {
                throw new InvalidOperationException("SetForegroundWindow failed.");
            }
        }
        else if (operation == "click")
        {
            if (args.Length < 4) throw new ArgumentException("click requires x and y.");
            int x = ParseInt(args[2], -32768, 32767, "x");
            int y = ParseInt(args[3], -32768, 32767, "y");
            if (!SetCursorPos(x, y))
            {
                throw new InvalidOperationException("SetCursorPos failed.");
            }
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        }
        else if (operation == "type")
        {
            if (args.Length < 3) throw new ArgumentException("type requires text.");
            SendUnicodeText(Decode(args[2]));
        }
        else if (operation == "key")
        {
            if (args.Length < 3) throw new ArgumentException("key requires a key name.");
            SendVirtualKey(KeyCode(args[2]));
        }
        else if (operation == "launch")
        {
            if (args.Length < 3) throw new ArgumentException("launch requires an executable path.");
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = Decode(args[2]);
            startInfo.UseShellExecute = true;
            Process.Start(startInfo);
        }
        else
        {
            throw new ArgumentException("Unsupported computer action: " + operation);
        }
        Emit("OK");
        return 0;
    }

    private static string NormalizeNotificationText(
        string value,
        int maximumCharacters,
        string label)
    {
        if (value == null)
        {
            throw new ArgumentException(label + " is required.");
        }
        StringBuilder normalized = new StringBuilder(Math.Min(value.Length, maximumCharacters));
        bool pendingSpace = false;
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsControl(character) || char.IsWhiteSpace(character))
            {
                pendingSpace = normalized.Length > 0;
                continue;
            }
            if (pendingSpace)
            {
                normalized.Append(' ');
                pendingSpace = false;
            }
            normalized.Append(character);
            if (normalized.Length > maximumCharacters)
            {
                throw new ArgumentException(
                    label + " exceeds " + maximumCharacters + " visible characters.");
            }
        }
        string result = normalized.ToString().Trim();
        if (result.Length == 0)
        {
            throw new ArgumentException(label + " must contain visible text.");
        }
        return result;
    }

    private static int RunNotify(string[] args)
    {
        if (args.Length != 5)
        {
            throw new ArgumentException(
                "notify requires base64 title, base64 message, severity, and duration.");
        }
        string title = NormalizeNotificationText(Decode(args[1]), 64, "Notification title");
        string message = NormalizeNotificationText(Decode(args[2]), 512, "Notification message");
        string severity = args[3].ToLowerInvariant();
        int durationMs = ParseInt(args[4], 3000, 15000, "durationMs");

        ToolTipIcon balloonIcon;
        Icon icon;
        if (severity == "info" || severity == "success")
        {
            balloonIcon = ToolTipIcon.Info;
            icon = SystemIcons.Information;
        }
        else if (severity == "warning")
        {
            balloonIcon = ToolTipIcon.Warning;
            icon = SystemIcons.Warning;
        }
        else if (severity == "error")
        {
            balloonIcon = ToolTipIcon.Error;
            icon = SystemIcons.Error;
        }
        else
        {
            throw new ArgumentException("Unsupported notification severity.");
        }

        using (NotifyIcon notification = new NotifyIcon())
        {
            notification.Icon = icon;
            notification.Text = "Sovereign Code Runtime";
            notification.BalloonTipTitle = title;
            notification.BalloonTipText = message;
            notification.BalloonTipIcon = balloonIcon;
            notification.Visible = true;
            notification.ShowBalloonTip(durationMs);
            Emit("NOTIFIED");

            Stopwatch lifetime = Stopwatch.StartNew();
            while (lifetime.ElapsedMilliseconds < durationMs)
            {
                Application.DoEvents();
                Thread.Sleep(50);
            }
            notification.Visible = false;
        }
        return 0;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false);
            if (args.Length == 0)
            {
                throw new ArgumentException("A native-agent mode is required.");
            }
            if (args[0] == "conpty-shell")
            {
                return RunConPtyShell(args);
            }
            if (args[0] == "conpty")
            {
                return RunConPty(args);
            }
            if (args[0] == "computer-observe")
            {
                return RunComputerObserve(args);
            }
            if (args[0] == "computer-action")
            {
                return RunComputerAction(args);
            }
            if (args[0] == "notify")
            {
                return RunNotify(args);
            }
            throw new ArgumentException("Unknown native-agent mode: " + args[0]);
        }
        catch (Exception error)
        {
            Emit("ERROR", Encode(error.Message));
            return 1;
        }
    }
}
