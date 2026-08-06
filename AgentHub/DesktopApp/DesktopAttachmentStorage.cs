using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentHubDesktop
{
    internal static class DesktopAttachmentStorage
    {
        public const long MaxBytes = 20L * 1024 * 1024;
        private static readonly Regex SafeExtension = new Regex(
            @"^\.[A-Za-z0-9]{1,16}$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex EncodedId = new Regex(
            @"^[a-z0-9-]{16,100}--(?<name>[A-Za-z0-9_-]{1,180})(?:\.[A-Za-z0-9]{1,16})?$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        public static string Import(string source, string root)
        {
            var info = new FileInfo(source ?? "");
            if (!info.Exists) throw new FileNotFoundException("Файл не найден", source);
            if (info.Length < 1 || info.Length > MaxBytes)
                throw new InvalidDataException("Размер файла должен быть от 1 байта до 20 МБ");

            Directory.CreateDirectory(root);
            var fullSource = info.FullName;
            var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            if (fullSource.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) return fullSource;

            var target = Path.Combine(fullRoot, StorageName(info.Name));
            File.Copy(fullSource, target, false);
            return target;
        }

        public static string StorageName(string originalName, string uniqueId = null)
        {
            var name = Path.GetFileName(originalName ?? "").Trim();
            if (String.IsNullOrWhiteSpace(name)) name = "Вложение";
            var extension = Path.GetExtension(name);
            var safeExtension = SafeExtension.IsMatch(extension ?? "") ? extension.ToLowerInvariant() : "";
            var stem = safeExtension.Length > 0 ? name.Substring(0, name.Length - extension.Length) : name;
            var encoded = Base64Url(stem + safeExtension);
            while (encoded.Length > 180 && stem.Length > 1)
            {
                stem = stem.Substring(0, stem.Length - 1);
                encoded = Base64Url(stem + safeExtension);
            }
            var prefix = String.IsNullOrWhiteSpace(uniqueId) ? Guid.NewGuid().ToString("N") : uniqueId.Trim().ToLowerInvariant();
            if (!Regex.IsMatch(prefix, @"^[a-z0-9-]{16,100}$", RegexOptions.CultureInvariant))
                throw new ArgumentException("Некорректный идентификатор вложения", "uniqueId");
            return prefix + "--" + encoded + safeExtension;
        }

        public static string DisplayName(string path)
        {
            var id = Path.GetFileName(path ?? "");
            var match = EncodedId.Match(id);
            if (!match.Success) return id;
            try
            {
                return Encoding.UTF8.GetString(Base64UrlBytes(match.Groups["name"].Value));
            }
            catch
            {
                return id;
            }
        }

        public static bool IsImage(string path)
        {
            var extension = Path.GetExtension(DisplayName(path)).ToLowerInvariant();
            return extension == ".png" || extension == ".jpg" || extension == ".jpeg"
                || extension == ".webp" || extension == ".gif" || extension == ".bmp";
        }

        private static string Base64Url(string value)
        {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static byte[] Base64UrlBytes(string value)
        {
            var padded = value.Replace('-', '+').Replace('_', '/');
            while (padded.Length % 4 != 0) padded += "=";
            return Convert.FromBase64String(padded);
        }
    }
}
