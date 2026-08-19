using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows;

namespace AgentHubDesktop
{
    internal static class DesktopDiagnostics
    {
        private static readonly AgentHubClient Client = new AgentHubClient(null, 250, 750);

        internal static void Install(Application application)
        {
            application.DispatcherUnhandledException += delegate(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs args)
            {
                Report(args.Exception, "desktop-dispatcher", true);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs args)
            {
                Report(args.ExceptionObject as Exception, "desktop-domain", true);
            };
            TaskScheduler.UnobservedTaskException += delegate(object sender, UnobservedTaskExceptionEventArgs args)
            {
                Report(args.Exception, "desktop-task", false);
            };
        }

        internal static Dictionary<string, object> Payload(Exception error, string action)
        {
            return new Dictionary<string, object>
            {
                { "kind", "manual" },
                { "name", error == null ? "Exception" : error.GetType().Name },
                { "message", "Desktop host unhandled exception" },
                { "stack", error == null ? "" : error.StackTrace ?? "" },
                { "action", action ?? "" }
            };
        }

        private static void Report(Exception error, string action, bool waitBriefly)
        {
            var delivery = Task.Run(async delegate
            {
                try
                {
                    await Client.CallAsync("report-diagnostic", Payload(error, action));
                }
                catch
                {
                }
            });
            if (!waitBriefly) return;
            try
            {
                delivery.Wait(800);
            }
            catch
            {
            }
        }
    }
}
