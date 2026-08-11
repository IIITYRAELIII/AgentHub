using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentHubDesktop
{
    internal static class DesktopAttachmentPresentation
    {
        private static readonly Regex SafeId = new Regex(
            @"^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        public static List<Dictionary<string, object>> MessageAttachments(
            Dictionary<string, object> exchange,
            string role)
        {
            var result = new List<Dictionary<string, object>>();
            var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var rawMessage in AgentHubClient.Array(exchange, "messages"))
            {
                var message = rawMessage as Dictionary<string, object>;
                if (message == null || AgentHubClient.Text(message, "role") != role) continue;
                foreach (var rawAttachment in AgentHubClient.Array(message, "attachments"))
                {
                    var attachment = rawAttachment as Dictionary<string, object>;
                    if (attachment == null) continue;
                    var id = AgentHubClient.Text(attachment, "id").Trim();
                    if (!SafeId.IsMatch(id) || !known.Add(id)) continue;
                    result.Add(attachment);
                }
            }
            return result;
        }

        public static List<Dictionary<string, object>> AssistantAttachments(Dictionary<string, object> exchange)
        {
            return MessageAttachments(exchange, "agent");
        }

        public static List<Dictionary<string, object>> UserAttachments(Dictionary<string, object> exchange)
        {
            return MessageAttachments(exchange, "user");
        }

        public static string ResolvePath(string root, Dictionary<string, object> attachment)
        {
            if (attachment == null || AgentHubClient.Bool(attachment, "missing")) return null;
            var id = AgentHubClient.Text(attachment, "id").Trim();
            if (!SafeId.IsMatch(id) || id.Contains("..")) return null;
            var resolvedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            var target = Path.GetFullPath(Path.Combine(resolvedRoot, id));
            if (!target.StartsWith(resolvedRoot, StringComparison.OrdinalIgnoreCase)) return null;
            var info = new FileInfo(target);
            return info.Exists && info.Length > 0 && info.Length <= 20L * 1024 * 1024
                ? target
                : null;
        }

        public static string HistorySignature(IEnumerable<Dictionary<string, object>> history)
        {
            var value = new StringBuilder();
            foreach (var exchange in history)
            {
                value.Append(AgentHubClient.Text(exchange, "id")).Append(':')
                    .Append(AgentHubClient.Text(exchange, "answer").GetHashCode()).Append(':');
                foreach (var attachment in UserAttachments(exchange).Concat(AssistantAttachments(exchange)))
                {
                    value.Append(AgentHubClient.Text(attachment, "id")).Append(',')
                        .Append(AgentHubClient.Bool(attachment, "missing") ? '0' : '1').Append(';');
                }
                value.Append('|');
            }
            return value.ToString();
        }
    }
}
