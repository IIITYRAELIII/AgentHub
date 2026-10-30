using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class IndependentParentProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
        public short Show,ReservedSize; public IntPtr ReservedPointer,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size,Usage,Pid; public UIntPtr Heap;
        public uint Module,Threads,Parent; public int Priority; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Image;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateProcess(string application, StringBuilder arguments, IntPtr pa,
        IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr sa,string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static void Require(bool ok,string message) { if(!ok) throw new InvalidOperationException(message+":"+Marshal.GetLastWin32Error()); }
    private static string Quote(string value) { return "\""+value.Replace("\"","\\\"")+"\""; }
    private static uint ParentPid()
    {
        IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
        Require(snapshot!=new IntPtr(-1),"snapshot");
        try {
            ProcessEntry entry=new ProcessEntry(); entry.Size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
            if(Process32First(snapshot,ref entry)) do {
                if(entry.Pid==(uint)Process.GetCurrentProcess().Id) return entry.Parent;
            } while(Process32Next(snapshot,ref entry));
            throw new InvalidOperationException("own process not found");
        } finally {CloseHandle(snapshot);}
    }
    public static int Main(string[] args)
    {
        Console.OutputEncoding=new UTF8Encoding(false); Console.Error.Write("");
        try {
            if(args.Length==0) return Child(Environment.GetEnvironmentVariable("HUB376_TEST_ROOT"),Environment.GetEnvironmentVariable("HUB376_TEST_STOP"));
            if(args[0]=="child") return Child(args[1],args[2]);
            if(args[0]=="worker") return Worker(args[1],args[2]);
            return Driver(args[0],args[1]);
        } catch(Exception error) {
            if(args[0]=="worker"||args[0]=="child") File.WriteAllText(Path.Combine(args[1],args[0]+"-error.txt"),error.ToString(),new UTF8Encoding(false));
            Console.Error.WriteLine(error);return 1;
        }
    }
    private static int Child(string root,string stopName)
    {
        bool inJob; Require(IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out inJob),"child membership");
        File.WriteAllText(Path.Combine(root,"child.json"),Json.Serialize(new {
            pid=Process.GetCurrentProcess().Id, startedTicks=Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),
            parentPid=ParentPid(), inJob=inJob }));
        using(EventWaitHandle stop=EventWaitHandle.OpenExisting(stopName)) Require(stop.WaitOne(30000),"child stop signal");
        return 0;
    }
    private static int Worker(string root,string stopName)
    {
        Type host=typeof(AgentHub.RuntimeHost.Program);
        Environment.SetEnvironmentVariable("HUB376_TEST_ROOT",root);
        Environment.SetEnvironmentVariable("HUB376_TEST_STOP",stopName);
        Environment.SetEnvironmentVariable("AGENT_HUB_RESTART_OPERATION_ID",null);
        MethodInfo method=host.GetMethod("StartIndependent",BindingFlags.Static|BindingFlags.NonPublic);
        try {Require((int)method.Invoke(null,new object[] {root})==0,"actual Host cold entry");}
        catch(TargetInvocationException error) {throw error.InnerException;}
        uint shell;Require(GetWindowThreadProcessId(GetShellWindow(),out shell)!=0,"actual desktop shell");
        File.WriteAllText(Path.Combine(root,"worker.json"),Json.Serialize(new {
            pid=Process.GetCurrentProcess().Id, shellPid=shell }));
        Thread.Sleep(30000);return 2;
    }
    private static int Driver(string root,string retirement)
    {
        string stopName="Local\\AgentHub-owned-independent-"+Guid.NewGuid().ToString("N");
        IntPtr outer=CreateJobObject(IntPtr.Zero,null),inner=CreateJobObject(IntPtr.Zero,null);
        Require(outer!=IntPtr.Zero&&inner!=IntPtr.Zero,"owned jobs");
        ProcessInfo worker=new ProcessInfo(); Process child=null;
        using(EventWaitHandle stop=new EventWaitHandle(false,EventResetMode.ManualReset,stopName))
        try {
            StartupInfo si=new StartupInfo();si.Size=(uint)Marshal.SizeOf(typeof(StartupInfo));
            string executable=Assembly.GetExecutingAssembly().Location;
            Require(CreateProcess(executable,new StringBuilder(Quote(executable)+" worker "+Quote(root)+" "+Quote(stopName)),
                IntPtr.Zero,IntPtr.Zero,false,4|0x08000000,IntPtr.Zero,root,ref si,out worker),"owned worker");
            Require(AssignProcessToJobObject(outer,worker.Process)&&AssignProcessToJobObject(inner,worker.Process),"nested owned membership");
            Require(ResumeThread(worker.Thread)==1,"worker resume");
            Stopwatch deadline=Stopwatch.StartNew();
            while(!File.Exists(Path.Combine(root,"worker.json"))||!File.Exists(Path.Combine(root,"child.json"))) {
                Require(WaitForSingleObject(worker.Process,0)==258,"worker exited before proof: "+
                    (File.Exists(Path.Combine(root,"worker-error.txt"))?File.ReadAllText(Path.Combine(root,"worker-error.txt")):"no worker error"));
                Require(deadline.ElapsedMilliseconds<10000,"proof deadline");Thread.Sleep(20);
            }
            Dictionary<string,object> wr=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"worker.json")));
            Dictionary<string,object> cr=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"child.json")));
            uint shell=Convert.ToUInt32(wr["shellPid"]);
            Require(Convert.ToUInt32(cr["parentPid"])==shell&&shell!=worker.Pid,"actual external parent");
            Require(!(bool)cr["inJob"],"actual child entered a job");
            child=Process.GetProcessById(Convert.ToInt32(cr["pid"]));
            Require(child.StartTime.ToUniversalTime().Ticks.ToString()==(string)cr["startedTicks"],"child birth identity");
            IntPtr heldChild=child.Handle;
            if(retirement=="tree") {
                ProcessStartInfo taskkill=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"taskkill.exe"),
                    "/PID "+worker.Pid+" /T /F");
                taskkill.UseShellExecute=false;taskkill.CreateNoWindow=true;
                taskkill.RedirectStandardOutput=true;taskkill.RedirectStandardError=true;
                using(Process kill=Process.Start(taskkill)) {
                    string output=kill.StandardOutput.ReadToEnd(),error=kill.StandardError.ReadToEnd();kill.WaitForExit();
                    Require(kill.ExitCode==0,"ONLYowned surrogate tree retirement: "+error+output);
                }
            } else Require(TerminateJobObject(outer,73),"ONLYowned job retirement");
            Require(WaitForSingleObject(worker.Process,5000)==0,"surrogate exit join");
            Require(WaitForSingleObject(heldChild,500)==258,"external child must survive submitting App closure");
            Console.WriteLine(Json.Serialize(new { retired=retirement,surrogatePid=worker.Pid,actualParentPid=shell,
                childPid=child.Id,childInJob=false,survived=true }));
            stop.Set();Require(child.WaitForExit(5000)&&child.ExitCode==0,"child natural exit join");
            return 0;
        } finally {
            stop.Set();
            if(child!=null) {child.WaitForExit(5000);child.Dispose();}
            if(worker.Process!=IntPtr.Zero&&WaitForSingleObject(worker.Process,0)==258) {
                TerminateJobObject(outer,74);WaitForSingleObject(worker.Process,5000);
            }
            if(worker.Thread!=IntPtr.Zero)CloseHandle(worker.Thread);
            if(worker.Process!=IntPtr.Zero)CloseHandle(worker.Process);
            CloseHandle(inner);CloseHandle(outer);
        }
    }
}
