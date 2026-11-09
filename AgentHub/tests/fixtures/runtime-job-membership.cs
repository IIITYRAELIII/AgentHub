using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class RuntimeJobMembership
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);

    public static int Main(string[] args)
    {
        foreach (string value in args)
        {
            using (Process process = Process.GetProcessById(int.Parse(value)))
            {
                bool member;
                if (!IsProcessInJob(process.Handle, IntPtr.Zero, out member))
                    throw new System.ComponentModel.Win32Exception();
                Console.WriteLine(value + " " + (member ? "in-job" : "outside-job"));
            }
        }
        return 0;
    }
}
