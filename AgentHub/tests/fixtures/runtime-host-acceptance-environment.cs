using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;

internal static class AcceptanceEnvironmentProbe
{
    public static int Main(string[] args)
    {
        if (args.Length > 1)
        {
            try
            {
                Type host = typeof(AgentHub.RuntimeHost.Program);
                BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic;
                if (args[1] == "close")
                {
                    host.GetMethod("CloseReleaseAcceptance", flags).Invoke(null, new object[] { args[0] });
                    Console.WriteLine("closed");
                    return 0;
                }
                if (args[1] == "hold-before-instance-lock")
                {
                    object gate = host.GetMethod("EnterAcceptanceGate", flags).Invoke(null, new object[] { args[0] });
                    object name = host.GetMethod("AcceptanceObjectName", flags).Invoke(null, new object[] { args[0] });
                    object job = host.GetMethod("CreateRuntimeJob", flags).Invoke(null, new object[] { name });
                    host.GetMethod("LeaveAcceptanceGate", flags).Invoke(null, new object[] { gate });
                    Console.WriteLine("registered-before-lock");
                    Console.Out.Flush();
                    Thread.Sleep(30000);
                    GC.KeepAlive(job);
                    return 3;
                }
            }
            catch (TargetInvocationException error) { Console.Error.WriteLine(error.InnerException.Message); return 2; }
        }
        ProcessStartInfo start = new ProcessStartInfo();
        start.EnvironmentVariables["TELEGRAM_BOT_TOKEN"] = "synthetic-secret";
        start.EnvironmentVariables["CODEX_EXECUTABLE"] = "unsafe-override";
        start.EnvironmentVariables["SENTRY_DSN"] = "synthetic-dsn";
        start.EnvironmentVariables["NODE_OPTIONS"] = "--require=unsafe.js";
        start.EnvironmentVariables["AGENT_HUB_RECORDING_PROVIDER_ROOT"] = "unsafe-recording-root";
        start.EnvironmentVariables["PATH"] = "unsafe-inherited-tool-directory";
        start.EnvironmentVariables["USERNAME"] = "synthetic-wrong-owner";
        start.EnvironmentVariables["USERDOMAIN"] = "synthetic-wrong-domain";
        MethodInfo method = typeof(AgentHub.RuntimeHost.Program).GetMethod(
            "ApplyReleaseAcceptanceEnvironment", BindingFlags.Static | BindingFlags.NonPublic);
        try { method.Invoke(null, new object[] { args[0], start }); }
        catch (TargetInvocationException error) { Console.Error.WriteLine(error.InnerException.Message); return 2; }
        if (args.Length > 3 && args[1] == "acl-probe")
        {
            start.FileName = args[2];
            start.Arguments = "\"" + args[3] + "\"";
            start.WorkingDirectory = args[0];
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (Process child = Process.Start(start))
            {
                Console.Write(child.StandardOutput.ReadToEnd());
                Console.Error.Write(child.StandardError.ReadToEnd());
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["tokenPresent"] = start.EnvironmentVariables["TELEGRAM_BOT_TOKEN"] != null;
        result["executableOverridePresent"] = start.EnvironmentVariables["CODEX_EXECUTABLE"] != null;
        result["sentryPresent"] = start.EnvironmentVariables["SENTRY_DSN"] != null;
        result["nodeOptionsPresent"] = start.EnvironmentVariables["NODE_OPTIONS"] != null;
        result["home"] = start.EnvironmentVariables["USERPROFILE"];
        result["codexHome"] = start.EnvironmentVariables["CODEX_HOME"];
        result["profile"] = start.EnvironmentVariables["AGENT_HUB_TEST_CONTOUR_PROFILE"];
        result["recordingRoot"] = start.EnvironmentVariables["AGENT_HUB_RECORDING_PROVIDER_ROOT"];
        result["testContour"] = start.EnvironmentVariables["AGENT_HUB_TEST_CONTOUR"];
        result["appData"] = start.EnvironmentVariables["APPDATA"];
        result["localAppData"] = start.EnvironmentVariables["LOCALAPPDATA"];
        result["claudeHome"] = start.EnvironmentVariables["CLAUDE_CONFIG_DIR"];
        result["temp"] = start.EnvironmentVariables["TEMP"];
        result["tmp"] = start.EnvironmentVariables["TMP"];
        result["pathPresent"] = start.EnvironmentVariables["PATH"] != null;
        result["path"] = start.EnvironmentVariables["PATH"];
        result["systemDirectory"] = Environment.GetFolderPath(Environment.SpecialFolder.System);
        result["userName"] = start.EnvironmentVariables["USERNAME"];
        result["userDomain"] = start.EnvironmentVariables["USERDOMAIN"];
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) result["windowsOwner"] = identity.Name;
        Console.WriteLine(new JavaScriptSerializer().Serialize(result));
        return 0;
    }
}
