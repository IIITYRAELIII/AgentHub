using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace AgentHubDesktop
{
    internal static class Theme
    {
        public static readonly Color Ink = ColorOf("#080C12");
        public static readonly Color Rail = ColorOf("#0A1018");
        public static readonly Color Panel = ColorOf("#0E1621");
        public static readonly Color PanelRaised = ColorOf("#131E2B");
        public static readonly Color PanelHover = ColorOf("#182638");
        public static readonly Color Border = ColorOf("#223246");
        public static readonly Color Text = ColorOf("#EAF2FA");
        public static readonly Color Muted = ColorOf("#8DA2B8");
        public static readonly Color Dim = ColorOf("#5C7188");
        public static readonly Color Codex = ColorOf("#2CCBFF");
        public static readonly Color CodexMint = ColorOf("#39E6C2");
        public static readonly Color Claude = ColorOf("#F5B45B");
        public static readonly Color ClaudeCoral = ColorOf("#F17852");
        public static readonly Color Good = ColorOf("#48DD8B");
        public static readonly Color Danger = ColorOf("#FF6B72");

        public static SolidColorBrush Solid(Color color) { return new SolidColorBrush(color); }
        public static SolidColorBrush Solid(string color) { return Solid(ColorOf(color)); }

        public static Color ColorOf(string color)
        {
            return (Color)ColorConverter.ConvertFromString(color);
        }

        /* Полосы прокрутки WPF по умолчанию рисуются светлой системной темой:
           на тёмном окне они читались как белые полосы по краям. Собственный
           шаблон описан разметкой, потому что Track задаёт кнопки и ползунок
           отдельными свойствами, а не потомками. */
        private const string ScrollBarStyleXaml = @"<ResourceDictionary xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
                    xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml""
                    xmlns:sw=""clr-namespace:System.Windows;assembly=PresentationFramework"">
  <SolidColorBrush x:Key=""{x:Static sw:SystemColors.ControlBrushKey}"" Color=""$rail$"" />
  <Style x:Key=""AgentHubScrollThumb"" TargetType=""{x:Type Thumb}"">
    <Setter Property=""OverridesDefaultStyle"" Value=""True"" />
    <Setter Property=""IsTabStop"" Value=""False"" />
    <Setter Property=""Template"">
      <Setter.Value>
        <ControlTemplate TargetType=""{x:Type Thumb}"">
          <Border x:Name=""body"" Background=""$thumb$"" CornerRadius=""4"" Margin=""2"" />
          <ControlTemplate.Triggers>
            <Trigger Property=""IsMouseOver"" Value=""True"">
              <Setter TargetName=""body"" Property=""Background"" Value=""$thumbHover$"" />
            </Trigger>
            <Trigger Property=""IsDragging"" Value=""True"">
              <Setter TargetName=""body"" Property=""Background"" Value=""$thumbActive$"" />
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key=""AgentHubScrollPage"" TargetType=""{x:Type RepeatButton}"">
    <Setter Property=""OverridesDefaultStyle"" Value=""True"" />
    <Setter Property=""Focusable"" Value=""False"" />
    <Setter Property=""IsTabStop"" Value=""False"" />
    <Setter Property=""Template"">
      <Setter.Value>
        <ControlTemplate TargetType=""{x:Type RepeatButton}"">
          <Border Background=""Transparent"" />
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key=""{x:Type ScrollBar}"" TargetType=""{x:Type ScrollBar}"">
    <Setter Property=""OverridesDefaultStyle"" Value=""True"" />
    <Setter Property=""Background"" Value=""Transparent"" />
    <Setter Property=""Width"" Value=""10"" />
    <Setter Property=""Template"">
      <Setter.Value>
        <ControlTemplate TargetType=""{x:Type ScrollBar}"">
          <Grid Background=""{TemplateBinding Background}"" SnapsToDevicePixels=""True"">
            <Track x:Name=""PART_Track"" Orientation=""{TemplateBinding Orientation}"" IsDirectionReversed=""True"">
              <Track.DecreaseRepeatButton>
                <RepeatButton Style=""{StaticResource AgentHubScrollPage}"" Command=""ScrollBar.PageUpCommand"" />
              </Track.DecreaseRepeatButton>
              <Track.Thumb>
                <Thumb Style=""{StaticResource AgentHubScrollThumb}"" />
              </Track.Thumb>
              <Track.IncreaseRepeatButton>
                <RepeatButton Style=""{StaticResource AgentHubScrollPage}"" Command=""ScrollBar.PageDownCommand"" />
              </Track.IncreaseRepeatButton>
            </Track>
          </Grid>
          <ControlTemplate.Triggers>
            <Trigger Property=""Orientation"" Value=""Horizontal"">
              <Setter TargetName=""PART_Track"" Property=""IsDirectionReversed"" Value=""False"" />
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
    <Style.Triggers>
      <Trigger Property=""Orientation"" Value=""Horizontal"">
        <Setter Property=""Width"" Value=""Auto"" />
        <Setter Property=""Height"" Value=""10"" />
      </Trigger>
    </Style.Triggers>
  </Style>
</ResourceDictionary>";

        public static string Hex(Color color)
        {
            return String.Format("#{0:X2}{1:X2}{2:X2}", color.R, color.G, color.B);
        }

        public static ResourceDictionary ControlStyles()
        {
            var xaml = ScrollBarStyleXaml
                .Replace("$rail$", Hex(Rail))
                .Replace("$thumbHover$", Hex(PanelHover))
                .Replace("$thumbActive$", Hex(Dim))
                .Replace("$thumb$", Hex(Border));
            return (ResourceDictionary)System.Windows.Markup.XamlReader.Parse(xaml);
        }

        public static Brush Provider(string provider)
        {
            return String.Equals(provider, "claude", StringComparison.OrdinalIgnoreCase)
                ? Solid(Claude)
                : Solid(Codex);
        }

        public static Brush ProviderGradient(string provider)
        {
            var claude = String.Equals(provider, "claude", StringComparison.OrdinalIgnoreCase);
            return new LinearGradientBrush(
                claude ? Claude : Codex,
                claude ? ClaudeCoral : CodexMint,
                new Point(0, 0),
                new Point(1, 1));
        }

        public static CornerRadius Radius(double value) { return new CornerRadius(value); }

        public static TextBlock Label(string text, double size, Brush foreground, FontWeight weight)
        {
            return new TextBlock
            {
                Text = text,
                FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI"),
                FontSize = size,
                Foreground = foreground,
                FontWeight = weight,
                TextWrapping = TextWrapping.Wrap
            };
        }

        public static Button Button(string text, string glyph, bool primary)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            if (!String.IsNullOrWhiteSpace(glyph))
            {
                panel.Children.Add(new TextBlock
                {
                    Text = glyph,
                    FontFamily = new FontFamily("Segoe Fluent Icons"),
                    FontSize = 14,
                    Margin = new Thickness(0, 0, 8, 0),
                    VerticalAlignment = VerticalAlignment.Center
                });
            }
            panel.Children.Add(new TextBlock { Text = text, FontWeight = FontWeights.SemiBold });
            var button = new Button
            {
                Content = panel,
                Foreground = primary ? Solid(Ink) : Solid(Text),
                Background = primary ? ProviderGradient("codex") : Solid(PanelRaised),
                BorderBrush = primary ? Brushes.Transparent : Solid(Border),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(14, 9, 14, 9),
                Cursor = System.Windows.Input.Cursors.Hand,
                FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI")
            };
            Polish(button, 9);
            return button;
        }

        public static void Polish(Button button, double radius)
        {
            var border = new FrameworkElementFactory(typeof(System.Windows.Controls.Border));
            border.SetValue(System.Windows.Controls.Border.CornerRadiusProperty, new CornerRadius(radius));
            border.SetValue(System.Windows.Controls.Border.SnapsToDevicePixelsProperty, true);
            border.SetBinding(System.Windows.Controls.Border.BackgroundProperty, new System.Windows.Data.Binding("Background")
            {
                RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent)
            });
            border.SetBinding(System.Windows.Controls.Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush")
            {
                RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent)
            });
            border.SetBinding(System.Windows.Controls.Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness")
            {
                RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent)
            });
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetBinding(ContentPresenter.MarginProperty, new System.Windows.Data.Binding("Padding")
            {
                RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent)
            });
            border.AppendChild(presenter);
            var template = new ControlTemplate(typeof(Button)) { VisualTree = border };
            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(UIElement.OpacityProperty, .88));
            var pressed = new Trigger { Property = System.Windows.Controls.Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(UIElement.OpacityProperty, .72));
            var disabled = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
            disabled.Setters.Add(new Setter(UIElement.OpacityProperty, .38));
            template.Triggers.Add(hover);
            template.Triggers.Add(pressed);
            template.Triggers.Add(disabled);
            button.Template = template;
        }
    }
}
