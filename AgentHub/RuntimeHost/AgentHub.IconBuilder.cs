using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class AgentHubIconBuilder
{
    private static readonly int[] IconSizes = { 16, 20, 24, 32, 48, 64, 128, 256 };

    private static GraphicsPath CreateCompactBlade(float scale)
    {
        GraphicsPath path = new GraphicsPath();
        path.StartFigure();
        path.AddBezier(
            new PointF(7.7f * scale, 8.0f * scale),
            new PointF(6.2f * scale, 6.2f * scale),
            new PointF(6.8f * scale, 3.4f * scale),
            new PointF(10.8f * scale, 1.1f * scale)
        );
        path.AddBezier(
            new PointF(10.8f * scale, 1.1f * scale),
            new PointF(8.4f * scale, 4.8f * scale),
            new PointF(10.0f * scale, 6.4f * scale),
            new PointF(8.6f * scale, 8.2f * scale)
        );
        path.AddBezier(
            new PointF(8.6f * scale, 8.2f * scale),
            new PointF(8.3f * scale, 8.4f * scale),
            new PointF(8.0f * scale, 8.3f * scale),
            new PointF(7.7f * scale, 8.0f * scale)
        );
        path.CloseFigure();
        return path;
    }

    private static void DrawCompactBlade(
        Graphics graphics,
        GraphicsPath template,
        PointF center,
        float angle,
        Brush fill,
        Pen outline
    )
    {
        using (GraphicsPath blade = (GraphicsPath)template.Clone())
        using (Matrix rotation = new Matrix())
        {
            rotation.RotateAt(angle, center);
            blade.Transform(rotation);
            graphics.FillPath(fill, blade);
            graphics.DrawPath(outline, blade);
        }
    }

    private static byte[] RenderCompactPng(int size)
    {
        using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (MemoryStream stream = new MemoryStream())
        using (GraphicsPath blade = CreateCompactBlade(size / 16.0f))
        using (Pen outline = new Pen(Color.FromArgb(210, 225, 247, 255), Math.Max(0.55f, size / 32.0f)))
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
            float scale = size / 16.0f;
            PointF center = new PointF(8.0f * scale, 8.0f * scale);
            DrawCompactBlade(graphics, blade, center, 0.0f, violet, outline);
            DrawCompactBlade(graphics, blade, center, 120.0f, blue, outline);
            DrawCompactBlade(graphics, blade, center, 240.0f, cyan, outline);

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
