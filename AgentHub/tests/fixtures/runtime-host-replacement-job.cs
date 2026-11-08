using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class ReplacementJobProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Startup { public uint Size; public string Reserved,Desktop,Title;
        public uint X,Y,XS,YS,XC,YC,Fill,Flags; public short Show,ReservedSize;
        public IntPtr ReservedPointer,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Created { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting { public long A,B,C,D; public uint Faults,Total,Active,Terminated; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,
        uint flags,IntPtr env,string cwd,ref Startup startup,out Created process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
    [DllImport("kernel32.dll")] private static extern bool QueryInformationJobObject(IntPtr j,int c,out Accounting a,uint n,IntPtr r);
    [DllImport("kernel32.dll")] private static extern bool TerminateJobObject(IntPtr j,uint code);
    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr p,uint ms);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    private static string Quote(string s) { return "\""+s.Replace("\"","\\\"")+"\""; }
    private static void Check(bool v,string m) { if(!v)throw new Exception(m+":"+Marshal.GetLastWin32Error()); }
    public static int Main(string[] args)
    {
        string root=args[0]; IntPtr job=CreateJobObject(IntPtr.Zero,null); Created submit=new Created();
        Process node=null,host=null;
        try
        {
            Startup si=new Startup();si.Size=(uint)Marshal.SizeOf(typeof(Startup));
            Check(CreateProcess(args[1],new StringBuilder(Quote(args[1])+" "+Quote(args[2])+" "+Quote(args[3])),
                IntPtr.Zero,IntPtr.Zero,false,4|0x08000000,IntPtr.Zero,root,ref si,out submit),"create submitter");
            Check(AssignProcessToJobObject(job,submit.Process)&&ResumeThread(submit.Thread)==1,"owned old Job");
            Check(WaitForSingleObject(submit.Process,25000)==0,"submitter terminal");
            // A signalled process handle may precede kernel Job accounting
            // removal. Observe the same retained Job, without excluding a PID.
            Accounting counts; Stopwatch accountingWait=Stopwatch.StartNew();
            uint expected=args[3]=="extra"||args[3]=="foreign-ready" ? 1U : 0U;
            do {
                Check(QueryInformationJobObject(job,1,out counts,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"same retained Job");
                if(counts.Active<=expected||accountingWait.ElapsedMilliseconds>=1500)break;
                System.Threading.Thread.Sleep(20);
            }while(true);
            string identity=Path.Combine(root,"actual-node.json"); bool alive=false;
            if(File.Exists(identity)) {
                var p=new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(identity));
                try {node=Process.GetProcessById(Convert.ToInt32(p["pid"]));host=Process.GetProcessById(Convert.ToInt32(p["hostPid"]));
                    alive=!node.HasExited&&!host.HasExited;} catch(ArgumentException) {}
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {oldActive=counts.Active,newRuntimeAlive=alive}));
            return 0;
        }
        catch(Exception e) {Console.Error.WriteLine(e);return 1;}
        finally
        {
            File.WriteAllText(Path.Combine(root,"app-stop"),"");File.WriteAllText(Path.Combine(root,"old-stop"),"");
            if(node!=null){Check(node.WaitForExit(10000),"owned replacement Node cleanup");node.Dispose();}
            if(host!=null){Check(host.WaitForExit(10000),"owned replacement Host cleanup");host.Dispose();}
            // Only the disposable anonymous fixture Job, never an inherited Job.
            Accounting left;
            if(QueryInformationJobObject(job,1,out left,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)&&left.Active>0) {
                Check(TerminateJobObject(job,79),"owned fixture cleanup");
            }
            if(submit.Process!=IntPtr.Zero) {WaitForSingleObject(submit.Process,5000);CloseHandle(submit.Process);CloseHandle(submit.Thread);}
            CloseHandle(job);
        }
    }
}
