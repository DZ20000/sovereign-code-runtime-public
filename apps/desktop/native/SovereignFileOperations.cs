using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static partial class SovereignNativeAgent
{
    private const uint FILE_GENERIC_READ = 0x80000000;
    private const uint FILE_GENERIC_WRITE = 0x40000000;
    private const uint FILE_DELETE = 0x00010000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint CREATE_NEW = 1;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const int FileRenameInfo = 3;
    private const int FileDispositionInfo = 4;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        IntPtr file,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        IntPtr file,
        StringBuilder path,
        uint pathCharacters,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        IntPtr file,
        int informationClass,
        IntPtr information,
        uint informationSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(IntPtr file);

    private sealed class NativeFileException : Exception
    {
        public readonly string Code;

        public NativeFileException(string code, string message)
            : base(message)
        {
            Code = code;
        }
    }

    private sealed class DirectoryLocks : IDisposable
    {
        public readonly List<IntPtr> Handles = new List<IntPtr>();
        public string RootPath;
        public string ParentPath;

        public IntPtr ParentHandle
        {
            get { return Handles[Handles.Count - 1]; }
        }

        public void Dispose()
        {
            for (int index = Handles.Count - 1; index >= 0; index--)
            {
                CloseHandle(Handles[index]);
            }
            Handles.Clear();
        }
    }

    private static string NormalizeNativePath(string path)
    {
        string normalized = path;
        if (normalized.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
        {
            normalized = "\\\\" + normalized.Substring(8);
        }
        else if (normalized.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized.Substring(4);
        }
        string full = Path.GetFullPath(normalized);
        string pathRoot = Path.GetPathRoot(full);
        return full.Equals(pathRoot, StringComparison.OrdinalIgnoreCase)
            ? full
            : full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void RequireContained(string root, string candidate)
    {
        string prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!candidate.Equals(root, StringComparison.OrdinalIgnoreCase) &&
            !candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeFileException("PATH_ESCAPE", "The native file operation escaped the workspace root.");
        }
    }

    private static string FinalPath(IntPtr handle)
    {
        uint capacity = 512;
        while (capacity <= 32768)
        {
            StringBuilder output = new StringBuilder((int)capacity);
            uint length = GetFinalPathNameByHandleW(handle, output, capacity, 0);
            if (length == 0)
            {
                throw Win32FileError("PATH_CHANGED", "GetFinalPathNameByHandleW failed");
            }
            if (length < capacity)
            {
                return NormalizeNativePath(output.ToString());
            }
            capacity = length + 1;
        }
        throw new NativeFileException("PATH_CHANGED", "The final path exceeds the supported length.");
    }

    private static BY_HANDLE_FILE_INFORMATION HandleInformation(IntPtr handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw Win32FileError("PATH_CHANGED", "GetFileInformationByHandle failed");
        }
        return information;
    }

    private static NativeFileException Win32FileError(string fallbackCode, string operation)
    {
        int error = Marshal.GetLastWin32Error();
        string code = fallbackCode;
        if (error == 2 || error == 3)
        {
            code = "PATH_NOT_FOUND";
        }
        else if (error == 32 || error == 33)
        {
            code = "PATH_CHANGED";
        }
        else if (error == 80 || error == 183)
        {
            code = "FILE_EXISTS";
        }
        else if (error == 5)
        {
            code = "POLICY_DENIED";
        }
        return new NativeFileException(code, operation + " (Win32 error " + error + ").");
    }

    private static IntPtr OpenNative(
        string path,
        uint access,
        uint share,
        uint creation,
        uint flags,
        string missingCode)
    {
        IntPtr handle = CreateFileW(
            path,
            access,
            share,
            IntPtr.Zero,
            creation,
            flags,
            IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE)
        {
            throw Win32FileError(missingCode, "CreateFileW failed");
        }
        return handle;
    }

    private static void VerifyDirectory(IntPtr handle, string root, string expected)
    {
        BY_HANDLE_FILE_INFORMATION information = HandleInformation(handle);
        if ((information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw new NativeFileException("PATH_SYMLINK", "A native directory component is not a regular directory.");
        }
        string actual = FinalPath(handle);
        RequireContained(root, actual);
        if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeFileException("PATH_CHANGED", "A directory path changed before the file operation.");
        }
    }

    private static BY_HANDLE_FILE_INFORMATION VerifyRegularFile(
        IntPtr handle,
        string root,
        string expected)
    {
        BY_HANDLE_FILE_INFORMATION information = HandleInformation(handle);
        if ((information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
            (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw new NativeFileException("FILE_NOT_REGULAR", "Only regular files may be modified.");
        }
        if (information.NumberOfLinks != 1)
        {
            throw new NativeFileException("FILE_LINKED", "Files with multiple hard links are outside the workspace trust boundary.");
        }
        string actual = FinalPath(handle);
        RequireContained(root, actual);
        if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeFileException("PATH_CHANGED", "The file path changed before the operation committed.");
        }
        return information;
    }

    private static DirectoryLocks LockDirectoryChain(string rootInput, string parentInput)
    {
        DirectoryLocks locks = new DirectoryLocks();
        try
        {
            locks.RootPath = NormalizeNativePath(rootInput);
            locks.ParentPath = NormalizeNativePath(parentInput);
            RequireContained(locks.RootPath, locks.ParentPath);

            IntPtr root = OpenNative(
                locks.RootPath,
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                "PATH_NOT_FOUND");
            locks.Handles.Add(root);
            VerifyDirectory(root, locks.RootPath, locks.RootPath);

            if (!locks.ParentPath.Equals(locks.RootPath, StringComparison.OrdinalIgnoreCase))
            {
                string relative = locks.ParentPath.Substring(locks.RootPath.Length)
                    .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string current = locks.RootPath;
                string[] segments = relative.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
                foreach (string segment in segments)
                {
                    current = Path.Combine(current, segment);
                    IntPtr directory = OpenNative(
                        current,
                        FILE_GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        OPEN_EXISTING,
                        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                        "PATH_NOT_FOUND");
                    locks.Handles.Add(directory);
                    VerifyDirectory(directory, locks.RootPath, NormalizeNativePath(current));
                }
            }
            return locks;
        }
        catch
        {
            locks.Dispose();
            throw;
        }
    }

    private static long FileLength(BY_HANDLE_FILE_INFORMATION information)
    {
        return ((long)information.FileSizeHigh << 32) | information.FileSizeLow;
    }

    private static string HashHandle(IntPtr handle)
    {
        using (SafeFileHandle safe = new SafeFileHandle(handle, false))
        using (FileStream stream = new FileStream(safe, FileAccess.Read, 65536, false))
        using (SHA256 algorithm = SHA256.Create())
        {
            stream.Position = 0;
            byte[] digest = algorithm.ComputeHash(stream);
            StringBuilder text = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest)
            {
                text.Append(value.ToString("x2"));
            }
            return text.ToString();
        }
    }

    private static void RequireExpectedHash(string actual, string expected)
    {
        if (expected == null || expected.Length != 64)
        {
            throw new NativeFileException("INVALID_INPUT", "A SHA-256 digest is required.");
        }
        if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new NativeFileException("STALE_HASH", "The file changed after it was read.");
        }
    }

    private static void ValidateLeaf(string leaf)
    {
        if (string.IsNullOrWhiteSpace(leaf) ||
            leaf == "." || leaf == ".." ||
            Path.IsPathRooted(leaf) ||
            leaf.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            leaf.EndsWith(" ", StringComparison.Ordinal) ||
            leaf.EndsWith(".", StringComparison.Ordinal))
        {
            throw new NativeFileException("PATH_REJECTED", "The destination leaf name is invalid.");
        }

        string device = leaf.Split('.')[0].ToUpperInvariant();
        if (device == "CON" || device == "PRN" || device == "AUX" || device == "NUL" ||
            (device.Length == 4 &&
             (device.StartsWith("COM", StringComparison.Ordinal) || device.StartsWith("LPT", StringComparison.Ordinal)) &&
             device[3] >= '1' && device[3] <= '9'))
        {
            throw new NativeFileException("PATH_REJECTED", "Windows device names are not valid file names.");
        }
    }

    private static void RenameHandle(IntPtr file, string destinationDirectoryPath, string leaf)
    {
        ValidateLeaf(leaf);
        string normalized = NormalizeNativePath(Path.Combine(destinationDirectoryPath, leaf));
        RequireContained(destinationDirectoryPath, normalized);
        byte[] name = Encoding.Unicode.GetBytes(normalized);
        int rootOffset = IntPtr.Size;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        IntPtr information = Marshal.AllocHGlobal(nameOffset + name.Length + 2);
        try
        {
            for (int index = 0; index < nameOffset + name.Length + 2; index++)
            {
                Marshal.WriteByte(information, index, 0);
            }
            Marshal.WriteByte(information, 0, 0);
            Marshal.WriteIntPtr(information, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(information, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
            if (!SetFileInformationByHandle(file, FileRenameInfo, information, (uint)(nameOffset + name.Length + 2)))
            {
                throw Win32FileError("PATH_CHANGED", "SetFileInformationByHandle(FileRenameInfo) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(information);
        }
    }

    private static void DeleteHandle(IntPtr file)
    {
        FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO();
        disposition.DeleteFile = true;
        int size = Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO));
        IntPtr information = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(disposition, information, false);
            if (!SetFileInformationByHandle(file, FileDispositionInfo, information, (uint)size))
            {
                throw Win32FileError("PATH_CHANGED", "SetFileInformationByHandle(FileDispositionInfo) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(information);
        }
    }

    private static byte[] ReadStandardInput(int length)
    {
        if (length < 0)
        {
            throw new NativeFileException("FILE_TOO_LARGE", "The file content length is outside the supported range.");
        }
        byte[] data = new byte[length];
        Stream input = Console.OpenStandardInput();
        int offset = 0;
        while (offset < data.Length)
        {
            int read = input.Read(data, offset, data.Length - offset);
            if (read <= 0)
            {
                throw new NativeFileException("INVALID_INPUT", "The native file helper received incomplete content.");
            }
            offset += read;
        }
        if (input.ReadByte() != -1)
        {
            throw new NativeFileException("INVALID_INPUT", "The native file helper received extra content.");
        }
        return data;
    }

    private static void WriteHandle(IntPtr handle, byte[] data)
    {
        using (SafeFileHandle safe = new SafeFileHandle(handle, false))
        using (FileStream stream = new FileStream(safe, FileAccess.Write, 65536, false))
        {
            stream.Write(data, 0, data.Length);
            stream.Flush(true);
        }
        if (!FlushFileBuffers(handle))
        {
            throw Win32FileError("PROCESS_FAILED", "FlushFileBuffers failed");
        }
    }

    private static int FileOperationError(NativeFileException error)
    {
        Emit("FILE_ERROR", Encode(error.Code), Encode(error.Message));
        return 2;
    }

    private static int RunFileCreate(string[] args)
    {
        try
        {
            if (args.Length != 6) throw new NativeFileException("INVALID_INPUT", "file-create requires root, parent, leaf, byte length, and maximum bytes.");
            string rootInput = Decode(args[1]);
            string parentInput = Decode(args[2]);
            string leaf = Decode(args[3]);
            int length = ParseInt(args[4], 0, int.MaxValue, "content length");
            int maximumBytes = ParseInt(args[5], 0, int.MaxValue, "maximum bytes");
            if (length > maximumBytes) throw new NativeFileException("FILE_TOO_LARGE", "The file content exceeds the configured write limit.");
            byte[] data = ReadStandardInput(length);
            using (DirectoryLocks parent = LockDirectoryChain(rootInput, parentInput))
            {
                string temporaryPath = Path.Combine(parent.ParentPath, ".scr-create-" + Guid.NewGuid().ToString("N") + ".tmp");
                IntPtr file = OpenNative(
                    temporaryPath,
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_DELETE,
                    FILE_SHARE_READ,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                    "FILE_EXISTS");
                bool committed = false;
                try
                {
                    VerifyRegularFile(file, parent.RootPath, NormalizeNativePath(temporaryPath));
                    WriteHandle(file, data);
                    VerifyDirectory(parent.ParentHandle, parent.RootPath, parent.ParentPath);
                    RenameHandle(file, parent.ParentPath, leaf);
                    committed = true;
                    Emit("FILE_OK", data.Length.ToString(), HashHandle(file));
                    return 0;
                }
                finally
                {
                    try
                    {
                        if (!committed)
                        {
                            DeleteHandle(file);
                        }
                    }
                    catch (NativeFileException cleanupError)
                    {
                        throw new NativeFileException(
                            "PROCESS_FAILED",
                            "The create operation could not remove its temporary file: " + cleanupError.Message);
                    }
                    finally
                    {
                        CloseHandle(file);
                    }
                }
            }
        }
        catch (NativeFileException error)
        {
            return FileOperationError(error);
        }
    }

    private static int RunFileMove(string[] args)
    {
        try
        {
            if (args.Length != 7) throw new NativeFileException("INVALID_INPUT", "file-move requires root, source, destination parent, leaf, expected hash, and maximum bytes.");
            string rootInput = Decode(args[1]);
            string sourceInput = NormalizeNativePath(Decode(args[2]));
            string parentInput = Decode(args[3]);
            string leaf = Decode(args[4]);
            string expected = args[5];
            int maximumBytes = ParseInt(args[6], 0, int.MaxValue, "maximum bytes");
            using (DirectoryLocks sourceParent = LockDirectoryChain(rootInput, Path.GetDirectoryName(sourceInput)))
            using (DirectoryLocks destinationParent = LockDirectoryChain(rootInput, parentInput))
            {
                IntPtr source = OpenNative(
                    sourceInput,
                    FILE_GENERIC_READ | FILE_DELETE,
                    FILE_SHARE_READ,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                    "PATH_NOT_FOUND");
                try
                {
                    BY_HANDLE_FILE_INFORMATION information = VerifyRegularFile(source, sourceParent.RootPath, sourceInput);
                    long bytes = FileLength(information);
                    if (bytes > maximumBytes) throw new NativeFileException("FILE_TOO_LARGE", "The file exceeds the guarded-read limit.");
                    string digest = HashHandle(source);
                    RequireExpectedHash(digest, expected);
                    VerifyDirectory(sourceParent.ParentHandle, sourceParent.RootPath, sourceParent.ParentPath);
                    VerifyDirectory(destinationParent.ParentHandle, destinationParent.RootPath, destinationParent.ParentPath);
                    RenameHandle(source, destinationParent.ParentPath, leaf);
                    Emit("FILE_OK", bytes.ToString(), digest);
                    return 0;
                }
                finally
                {
                    CloseHandle(source);
                }
            }
        }
        catch (NativeFileException error)
        {
            return FileOperationError(error);
        }
    }

    private static int RunFileDelete(string[] args)
    {
        try
        {
            if (args.Length != 5) throw new NativeFileException("INVALID_INPUT", "file-delete requires root, source, expected hash, and maximum bytes.");
            string rootInput = Decode(args[1]);
            string sourceInput = NormalizeNativePath(Decode(args[2]));
            string expected = args[3];
            int maximumBytes = ParseInt(args[4], 0, int.MaxValue, "maximum bytes");
            using (DirectoryLocks sourceParent = LockDirectoryChain(rootInput, Path.GetDirectoryName(sourceInput)))
            {
                IntPtr source = OpenNative(
                    sourceInput,
                    FILE_GENERIC_READ | FILE_DELETE,
                    FILE_SHARE_READ,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                    "PATH_NOT_FOUND");
                try
                {
                    BY_HANDLE_FILE_INFORMATION information = VerifyRegularFile(source, sourceParent.RootPath, sourceInput);
                    long bytes = FileLength(information);
                    if (bytes > maximumBytes) throw new NativeFileException("FILE_TOO_LARGE", "The file exceeds the guarded-read limit.");
                    string digest = HashHandle(source);
                    RequireExpectedHash(digest, expected);
                    VerifyDirectory(sourceParent.ParentHandle, sourceParent.RootPath, sourceParent.ParentPath);
                    DeleteHandle(source);
                    Emit("FILE_OK", bytes.ToString(), digest);
                    return 0;
                }
                finally
                {
                    CloseHandle(source);
                }
            }
        }
        catch (NativeFileException error)
        {
            return FileOperationError(error);
        }
    }

    private static bool TryRunFileOperation(string[] args, out int result)
    {
        if (args[0] == "file-create")
        {
            result = RunFileCreate(args);
            return true;
        }
        if (args[0] == "file-move")
        {
            result = RunFileMove(args);
            return true;
        }
        if (args[0] == "file-delete")
        {
            result = RunFileDelete(args);
            return true;
        }
        result = 0;
        return false;
    }
}
