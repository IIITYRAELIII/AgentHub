using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class AgentHubIconBuilder
{
    private static readonly int[] IconSizes = { 16, 20, 24, 32, 48, 64, 128, 256 };

    private static void FillCircle(Graphics graphics, Brush brush, PointF center, float radius)
    {
        graphics.FillEllipse(
            brush,
            center.X - radius,
            center.Y - radius,
            radius * 2,
            radius * 2
        );
    }

    private static byte[] RenderCompactPng(int size)
    {
        using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (MemoryStream stream = new MemoryStream())
        using (Brush badge = new SolidBrush(Color.FromArgb(255, 8, 25, 42)))
        using (Pen border = new Pen(Color.FromArgb(255, 83, 222, 242), Math.Max(1.0f, size / 16.0f)))
        using (Pen spoke = new Pen(Color.FromArgb(245, 238, 248, 255), Math.Max(1.2f, size / 11.0f)))
        using (Brush centerBrush = new SolidBrush(Color.White))
        using (Brush violet = new SolidBrush(Color.FromArgb(255, 204, 104, 255)))
        using (Brush cyan = new SolidBrush(Color.FromArgb(255, 30, 224, 235)))
        using (Brush blue = new SolidBrush(Color.FromArgb(255, 54, 123, 255)))
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            border.Alignment = PenAlignment.Inset;
            spoke.StartCap = LineCap.Round;
            spoke.EndCap = LineCap.Round;

            float scale = size / 16.0f;
            float inset = 1.0f * scale;
            graphics.FillEllipse(badge, inset, inset, size - (2 * inset), size - (2 * inset));
            graphics.DrawEllipse(border, inset, inset, size - (2 * inset), size - (2 * inset));

            PointF center = new PointF(8.0f * scale, 8.2f * scale);
            PointF top = new PointF(8.0f * scale, 4.0f * scale);
            PointF left = new PointF(4.4f * scale, 10.5f * scale);
            PointF right = new PointF(11.6f * scale, 10.5f * scale);
            graphics.DrawLine(spoke, center, top);
            graphics.DrawLine(spoke, center, left);
            graphics.DrawLine(spoke, center, right);

            float nodeRadius = 1.35f * scale;
            FillCircle(graphics, violet, top, nodeRadius);
            FillCircle(graphics, cyan, left, nodeRadius);
            FillCircle(graphics, blue, right, nodeRadius);
            FillCircle(graphics, centerBrush, center, 1.45f * scale);

            bitmap.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }

    private static byte[] RenderPng(Image source, int size)
    {
        using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (ImageAttributes attributes = new ImageAttributes())
        using (MemoryStream stream = new MemoryStream())
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.Clear(Color.Transparent);
            attributes.SetWrapMode(WrapMode.TileFlipXY);
            graphics.DrawImage(
                source,
                new Rectangle(0, 0, size, size),
                0,
                0,
                source.Width,
                source.Height,
                GraphicsUnit.Pixel,
                attributes
            );
            bitmap.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }

    private static void WriteIcon(string sourceFile, string outputFile)
    {
        using (Image source = Image.FromFile(sourceFile))
        {
            if (source.Width != 256 || source.Height != 256)
            {
                throw new InvalidDataException(
                    String.Format("Agent Hub RuntimeHost icon must be 256x256, received {0}x{1}", source.Width, source.Height)
                );
            }

            byte[][] layers = new byte[IconSizes.Length][];
            for (int index = 0; index < IconSizes.Length; index++)
            {
                int size = IconSizes[index];
                layers[index] = size <= 32 ? RenderCompactPng(size) : RenderPng(source, size);
            }

            using (FileStream stream = new FileStream(outputFile, FileMode.Create, FileAccess.Write, FileShare.None))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)layers.Length);

                int offset = 6 + (16 * layers.Length);
                for (int index = 0; index < layers.Length; index++)
                {
                    int size = IconSizes[index];
                    writer.Write((byte)(size == 256 ? 0 : size));
                    writer.Write((byte)(size == 256 ? 0 : size));
                    writer.Write((byte)0);
                    writer.Write((byte)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)32);
                    writer.Write((uint)layers[index].Length);
                    writer.Write((uint)offset);
                    offset += layers[index].Length;
                }

                for (int index = 0; index < layers.Length; index++)
                {
                    writer.Write(layers[index]);
                }
            }
        }
    }

    private static int Main(string[] arguments)
    {
        if (arguments.Length != 2)
        {
            Console.Error.WriteLine("Usage: AgentHub.IconBuilder.exe <source.png> <output.ico>");
            return 2;
        }

        try
        {
            WriteIcon(arguments[0], arguments[1]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
    }
}
