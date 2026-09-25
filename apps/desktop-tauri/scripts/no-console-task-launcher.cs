using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Xml;

// Compile as WindowsApplication: neither this launcher nor its console child
// allocates a console. Waiting and forwarding the exit code preserve task state.
public static class NoConsoleTaskLauncher
{
    private static readonly object LogLock = new object();
    private static string logPath;
    private const long MaxLogBytes = 2 * 1024 * 1024;

    private static void Log(string kind, string text)
    {
        if (text == null || String.IsNullOrEmpty(logPath)) return;
        lock (LogLock)
        {
            try
            {
                string folder = Path.GetDirectoryName(logPath);
                if (!String.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
                if (File.Exists(logPath) && new FileInfo(logPath).Length >= MaxLogBytes)
                {
                    if (File.Exists(logPath + ".1")) File.Delete(logPath + ".1");
                    File.Move(logPath, logPath + ".1");
                }
                File.AppendAllText(logPath, DateTimeOffset.Now.ToString("o") + " [" + kind + "] " + text + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { /* Logging failures must not interrupt the supervised task. */ }
        }
    }

    private static string Field(XmlDocument config, string name, bool required)
    {
        XmlNode node = config.SelectSingleNode("/NoConsoleTask/" + name);
        string value = node == null ? "" : node.InnerText;
        if (required && String.IsNullOrWhiteSpace(value))
            throw new InvalidDataException("Missing configuration field: " + name);
        return value;
    }

    [STAThread]
    public static int Main(string[] args)
    {
        logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher-error.log");
        try
        {
            if (args.Length != 1 || !Path.IsPathRooted(args[0]))
                throw new ArgumentException("Expected one absolute XML configuration path.");
            XmlDocument config = new XmlDocument();
            config.XmlResolver = null;
            XmlReaderSettings settings = new XmlReaderSettings();
            settings.DtdProcessing = DtdProcessing.Prohibit;
            settings.XmlResolver = null;
            settings.MaxCharactersInDocument = 262144;
            using (XmlReader reader = XmlReader.Create(args[0], settings)) config.Load(reader);
            string executable = Field(config, "Executable", true);
            string arguments = Field(config, "Arguments", false);
            string directory = Field(config, "WorkingDirectory", false);
            string configuredLog = Field(config, "LogPath", true);
            if (!Path.IsPathRooted(configuredLog)) throw new InvalidDataException("LogPath must be absolute.");
            logPath = configuredLog;
            if (!Path.IsPathRooted(executable) || !File.Exists(executable))
                throw new FileNotFoundException("Configured executable is missing.", executable);
            if (directory.Length > 0 && (!Path.IsPathRooted(directory) || !Directory.Exists(directory)))
                throw new DirectoryNotFoundException("Configured working directory is missing.");
            using (Process process = new Process())
            {
                process.StartInfo.FileName = executable;
                process.StartInfo.Arguments = arguments;
                if (directory.Length > 0) process.StartInfo.WorkingDirectory = directory;
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;
                process.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
                process.StartInfo.RedirectStandardInput = true;
                process.StartInfo.RedirectStandardOutput = true;
                process.StartInfo.RedirectStandardError = true;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log("stdout", e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log("stderr", e.Data); };
                if (!process.Start()) throw new InvalidOperationException("Child process did not start.");
                Log("start", "childPid=" + process.Id + " executable=" + executable);
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                int code = process.ExitCode;
                Log("exit", "childPid=" + process.Id + " exitCode=" + code);
                return code;
            }
        }
        catch (Exception error)
        {
            Log("error", error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
