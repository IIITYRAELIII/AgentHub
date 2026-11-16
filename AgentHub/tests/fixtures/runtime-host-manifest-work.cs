using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ManifestWorkProbe
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static Exception Unwrap(Exception error) {
        return error is TargetInvocationException ? error.InnerException : error;
    }
    private static void Invoke(MethodInfo method, int count, Action<int> work) {
        try { method.Invoke(null, new object[] { count, work }); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    private static void FailureJoin(MethodInfo method, string root, bool lowerFailsLate)
    {
        string file = Path.Combine(root, lowerFailsLate ? "lower-held.bin" : "later-held.bin");
        File.WriteAllText(file, "owned fixture");
        using (var held = new ManualResetEvent(false))
        using (var firstFailed = new ManualResetEvent(false))
        using (var release = new ManualResetEvent(false))
        {
            Exception low = new InvalidOperationException("first manifest member");
            Exception high = new IOException("second manifest member");
            Exception observed = null;
            int beyond = 0;
            Thread call = new Thread(delegate() {
                try { Invoke(method, 8, delegate(int index) {
                    int late = lowerFailsLate ? 0 : 1;
                    if (index == late) {
                        using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) {
                            Check(stream.ReadByte() >= 0, "actual retained file handle");
                            held.Set();
                            Check(release.WaitOne(10000), "release held validation");
                        }
                        if (lowerFailsLate) throw low;
                        return;
                    }
                    if (index < 2) {
                        Check(held.WaitOne(10000), "second validation entered");
                        firstFailed.Set();
                        throw lowerFailsLate ? high : low;
                    }
                    Interlocked.Increment(ref beyond);
                }); }
                catch (Exception error) { observed = Unwrap(error); }
            });
            call.Start();
            try {
                Check(firstFailed.WaitOne(10000), "early failure reached");
                Check(!call.Join(0), "failure must join the late validation");
                bool stillHeld = false;
                try { using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) {} }
                catch (IOException) { stillHeld = true; }
                Check(stillHeld, "late native validation still owns its handle");
            }
            finally { release.Set(); Check(call.Join(10000), "all native work joined"); }
            Check(Object.ReferenceEquals(observed, low), "original first-in-manifest exception identity");
            Check(beyond == 0, "no admission beyond the known failed prefix");
            using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) {}
        }
    }
    private static int Success(MethodInfo method, string root)
    {
        int[] visits = new int[17]; int active = 0, maximum = 0;
        using (var both = new Barrier(2)) {
            Invoke(method, visits.Length, delegate(int index) {
                string file = Path.Combine(root, "member-" + index + ".bin");
                File.WriteAllText(file, "fixture");
                using (FileStream stream = File.OpenRead(file)) {
                    int current = Interlocked.Increment(ref active);
                    int old;
                    do { old = maximum; if (current <= old) break; }
                    while (Interlocked.CompareExchange(ref maximum, current, old) != old);
                    try {
                        Check(stream.ReadByte() >= 0, "actual member read");
                        if (index < 2) Check(both.SignalAndWait(10000), "both I/O validations overlap");
                        Check(Interlocked.Increment(ref visits[index]) == 1, "member verified exactly once");
                    }
                    finally { Interlocked.Decrement(ref active); }
                }
            });
        }
        foreach (int visited in visits) Check(visited == 1, "complete successful manifest coverage");
        Check(maximum == 2 && active == 0, "bounded actual I/O concurrency and join");
        return maximum;
    }
    public static int Main(string[] args)
    {
        try {
            MethodInfo method = Assembly.LoadFrom(args[0]).GetType("AgentHub.RuntimeHost.Program", true)
                .GetMethod("ValidateManifestMembers", BindingFlags.NonPublic | BindingFlags.Static);
            Check(method != null, "actual Host member coordinator");
            FailureJoin(method, args[1], false);
            FailureJoin(method, args[1], true);
            int maximum = Success(method, args[1]);
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {
                failureJoined = true, lowerFailureWins = true, handlesClosed = true,
                successfulMembers = 17, maxIoConcurrency = maximum, runtime = Environment.Version.ToString()
            }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
