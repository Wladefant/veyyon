using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AppContainerLauncher
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const uint INFINITE = 0xFFFFFFFF;

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
        try
        {
            DeleteAppContainerProfile(profileName);
        }
        catch { }
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
        bool hideWindow = true)
    {
        IntPtr lpAttributeList = IntPtr.Zero;
        IntPtr lpEnvironment = IntPtr.Zero;
        PROCESS_INFORMATION procInfo = new PROCESS_INFORMATION();
        try
        {
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

            uint creationFlags = EXTENDED_STARTUPINFO_PRESENT;
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

            WaitForSingleObject(procInfo.hProcess, INFINITE);

            uint exitCode;
            if (!GetExitCodeProcess(procInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            }

            return (int)exitCode;
        }
        finally
        {
            if (procInfo.hProcess != IntPtr.Zero) CloseHandle(procInfo.hProcess);
            if (procInfo.hThread != IntPtr.Zero) CloseHandle(procInfo.hThread);

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
