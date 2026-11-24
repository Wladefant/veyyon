using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class AppContainerLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string pszAppContainerName,
        string pszDisplayName,
        string pszDescription,
        IntPtr pCapabilities,
        uint dwCapabilityCount,
        out IntPtr ppSidAppContainerSid
    );

    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string pszAppContainerName);

    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string pszAppContainerName,
        out IntPtr ppsidAppContainerSid
    );

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertSidToStringSidW")]
    private static extern bool ConvertSidToStringSid(
        IntPtr pSid,
        out IntPtr ptrStringSid
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        uint dwAttributeCount,
        uint dwFlags,
        ref IntPtr lpSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr attribute,
        ref SECURITY_CAPABILITIES lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr lpAttributeList
    );

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);


    public static string CreateProfile(string profileName, out IntPtr pSid)
    {
        pSid = IntPtr.Zero;
        int hr = CreateAppContainerProfile(
            profileName,
            profileName,
            "Veyyon Test Sandbox AppContainer",
            IntPtr.Zero,
            0,
            out pSid
        );

        const int ERROR_ALREADY_EXISTS = unchecked((int)0x800700B7);
        if (hr == ERROR_ALREADY_EXISTS)
        {
            hr = DeriveAppContainerSidFromAppContainerName(profileName, out pSid);
        }

        if (hr != 0)
        {
            throw new Win32Exception(hr, string.Format("CreateAppContainerProfile failed with HRESULT 0x{0:X8}", hr));
        }

        IntPtr ptrStringSid;
        if (!ConvertSidToStringSid(pSid, out ptrStringSid))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSidToStringSid failed");
        }

        try
        {
            return Marshal.PtrToStringUni(ptrStringSid);
        }
        finally
        {
            LocalFree(ptrStringSid);
        }
    }

    public static void DeleteProfile(string profileName)
    {
        const int ERROR_FILE_NOT_FOUND = unchecked((int)0x80070002);
        const int ERROR_PATH_NOT_FOUND = unchecked((int)0x80070003);
        int hr = DeleteAppContainerProfile(profileName);
        if (hr != 0 && hr != ERROR_FILE_NOT_FOUND && hr != ERROR_PATH_NOT_FOUND)
        {
            throw new Win32Exception(hr, string.Format("DeleteAppContainerProfile failed with HRESULT 0x{0:X8}", hr));
        }
    }


    public static int Launch(
        IntPtr pAppContainerSid,
        string applicationPath,
        string commandLine,
        string workingDirectory,
        bool inheritHandles,
        bool hideWindow)
    {
        return Launch(pAppContainerSid, applicationPath, commandLine, workingDirectory, null, inheritHandles, hideWindow);
    }

    public static int Launch(
        IntPtr pAppContainerSid,
        string applicationPath,
        string commandLine,
        string workingDirectory,
        IDictionary<string, string> environmentVariables = null,
        bool inheritHandles = false,
        bool hideWindow = true,
        int timeoutMs = 600000)
    {
        IntPtr lpAttributeList = IntPtr.Zero;
        IntPtr lpEnvironment = IntPtr.Zero;
        IntPtr hJob = IntPtr.Zero;
        IntPtr lpJobInfo = IntPtr.Zero;
        PROCESS_INFORMATION procInfo = new PROCESS_INFORMATION();
        try
        {
            hJob = CreateJobObjectW(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int jobInfoSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            lpJobInfo = Marshal.AllocHGlobal(jobInfoSize);
            Marshal.StructureToPtr(jobInfo, lpJobInfo, false);
            if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, lpJobInfo, (uint)jobInfoSize))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
            SECURITY_CAPABILITIES secCaps = new SECURITY_CAPABILITIES
            {
                AppContainerSid = pAppContainerSid,
                Capabilities = IntPtr.Zero,
                CapabilityCount = 0,
                Reserved = 0
            };

            IntPtr lpSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);
            if (lpSize == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList (sizing) failed");
            }

            lpAttributeList = Marshal.AllocHGlobal(lpSize);
            if (!InitializeProcThreadAttributeList(lpAttributeList, 1, 0, ref lpSize))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
            }

            IntPtr attributeTag = (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES;
            bool updateSuccess = UpdateProcThreadAttribute(
                lpAttributeList,
                0,
                attributeTag,
                ref secCaps,
                (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)),
                IntPtr.Zero,
                IntPtr.Zero
            );

            if (!updateSuccess)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");
            }

            STARTUPINFOEX startupInfoEx = new STARTUPINFOEX();
            startupInfoEx.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startupInfoEx.lpAttributeList = lpAttributeList;

            uint creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED;
            if (hideWindow)
            {
                creationFlags |= CREATE_NO_WINDOW;
            }
            if (environmentVariables != null && environmentVariables.Count > 0)
            {
                var sortedKeys = new List<string>(environmentVariables.Keys);
                sortedKeys.Sort(StringComparer.OrdinalIgnoreCase);

                var envChars = new List<char>();
                foreach (var key in sortedKeys)
                {
                    if (string.IsNullOrEmpty(key) || key.Contains("="))
                    {
                        continue;
                    }
                    string val = environmentVariables[key] ?? string.Empty;
                    envChars.AddRange(key);
                    envChars.Add('=');
                    envChars.AddRange(val);
                    envChars.Add('\0');
                }
                envChars.Add('\0');

                char[] envArray = envChars.ToArray();
                lpEnvironment = Marshal.AllocHGlobal(envArray.Length * sizeof(char));
                Marshal.Copy(envArray, 0, lpEnvironment, envArray.Length);

                creationFlags |= CREATE_UNICODE_ENVIRONMENT;
            }


            bool created = CreateProcessW(
                applicationPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                inheritHandles,
                creationFlags,
                lpEnvironment,
                workingDirectory,
                ref startupInfoEx,
                out procInfo
            );

            if (!created)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), string.Format("CreateProcessW failed for {0}", applicationPath));
            }

            if (!AssignProcessToJobObject(hJob, procInfo.hProcess))
            {
                int err = Marshal.GetLastWin32Error();
                TerminateProcess(procInfo.hProcess, 1);
                throw new Win32Exception(err, "AssignProcessToJobObject failed");
            }

            if (ResumeThread(procInfo.hThread) == 0xFFFFFFFF)
            {
                int err = Marshal.GetLastWin32Error();
                TerminateJobObject(hJob, 1);
                throw new Win32Exception(err, "ResumeThread failed");
            }

            uint waitMs = timeoutMs > 0 ? (uint)timeoutMs : INFINITE;
            uint waitResult = WaitForSingleObject(procInfo.hProcess, waitMs);
            if (waitResult == WAIT_TIMEOUT)
            {
                TerminateJobObject(hJob, 124);
                return 124;
            }
            if (waitResult == WAIT_FAILED)
            {
                int err = Marshal.GetLastWin32Error();
                TerminateJobObject(hJob, 1);
                throw new Win32Exception(err, "WaitForSingleObject failed");
            }

            uint exitCode;
            if (!GetExitCodeProcess(procInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            }

            TerminateJobObject(hJob, exitCode);
            return (int)exitCode;
        }
        finally
        {
            if (hJob != IntPtr.Zero) CloseHandle(hJob);
            if (procInfo.hProcess != IntPtr.Zero) CloseHandle(procInfo.hProcess);
            if (procInfo.hThread != IntPtr.Zero) CloseHandle(procInfo.hThread);

            if (lpJobInfo != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(lpJobInfo);
            }
            if (lpAttributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(lpAttributeList);
                Marshal.FreeHGlobal(lpAttributeList);
            }
            if (lpEnvironment != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(lpEnvironment);
            }
        }
    }
}

public static class SecondaryScratch
{
    private const uint Delete = 0x00010000;
    private const uint FileReadAttributes = 0x80;
    private const uint Synchronize = 0x00100000;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint FileOpen = 1;
    private const uint FileCreate = 2;
    private const uint FileDirectoryFile = 1;
    private const uint FileSynchronousIoNonalert = 0x20;
    private const uint ObjCaseInsensitive = 0x40;
    private const uint ObjDontReparse = 0x1000;
    private const int FileDispositionInfo = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
        out IoStatusBlock status, IntPtr allocationSize, uint fileAttributes,
        uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);

    [DllImport("ntdll.dll")]
    private static extern int RtlNtStatusToDosError(int status);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle handle, int infoClass, ref byte deleteFile, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);

    private static SafeFileHandle OpenDirectory(
        string name, IntPtr root, IntPtr security, uint access, uint disposition)
    {
        ushort length = checked((ushort)(name.Length * sizeof(char)));
        IntPtr buffer = Marshal.StringToHGlobalUni(name);
        IntPtr objectName = IntPtr.Zero;
        try
        {
            var unicode = new UnicodeString { Length = length, MaximumLength = length, Buffer = buffer };
            objectName = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicode, objectName, false);
            var attributes = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                ObjectName = objectName,
                RootDirectory = root,
                Attributes = ObjCaseInsensitive | ObjDontReparse,
                SecurityDescriptor = security
            };
            SafeFileHandle handle;
            IoStatusBlock io;
            int result = NtCreateFile(
                out handle, access | Synchronize, ref attributes, out io,
                IntPtr.Zero, 0, FileShareRead | FileShareWrite, disposition,
                FileDirectoryFile | FileSynchronousIoNonalert, IntPtr.Zero, 0);
            if (result < 0)
            {
                if (handle != null) handle.Dispose();
                throw new Win32Exception(RtlNtStatusToDosError(result),
                    "Cannot open secondary scratch directory '" + name + "' (NTSTATUS 0x" +
                    result.ToString("X8") + ").");
            }
            return handle;
        }
        finally
        {
            Marshal.FreeHGlobal(objectName);
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static SafeFileHandle Create(string basePath, Guid id, byte[] securityDescriptor)
    {
        string fullPath = Path.GetFullPath(basePath);
        string volume = Path.GetPathRoot(fullPath);
        if (volume.Length != 3 || volume[1] != ':' || volume[2] != '\\')
            throw new ArgumentException("Secondary scratch must use a local drive path.", "basePath");

        // Reject reparses in the same operation that opens the base. Subsequent
        // operations never resolve the caller-supplied base path again.
        using (SafeFileHandle root = OpenDirectory(
            @"\??\" + fullPath, IntPtr.Zero, IntPtr.Zero, FileReadAttributes, FileOpen))
        {
            // A drive mapping or short name must not hide the actual base from
            // the runner's host-home guard.
            string expected = @"\\?\" + fullPath.TrimEnd('\\');
            var canonical = new StringBuilder(expected.Length + 2);
            uint count = GetFinalPathNameByHandle(root, canonical, (uint)canonical.Capacity, 0);
            if (count == 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (count >= canonical.Capacity ||
                !string.Equals(canonical.ToString().TrimEnd('\\'), expected, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Secondary scratch base must use its canonical drive path: " + fullPath);

            GCHandle security = GCHandle.Alloc(securityDescriptor, GCHandleType.Pinned);
            try
            {
                return OpenDirectory(id.ToString("N"), root.DangerousGetHandle(),
                    security.AddrOfPinnedObject(), Delete, FileCreate);
            }
            finally
            {
                GC.KeepAlive(root);
                security.Free();
            }
        }
    }

    public static void DeleteEmpty(SafeFileHandle directory)
    {
        // The guest removes its own fixtures. Do not enumerate or recurse into
        // guest-controlled entries. A leftover must fail cleanup instead.
        byte deleteFile = 1;
        if (!SetFileInformationByHandle(directory, FileDispositionInfo, ref deleteFile, 1))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
