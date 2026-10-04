Add-Type -AssemblyName System.Drawing

# Social-share card. Link previews are the first impression of the product when
# someone shares the URL, so it carries the same mark and name as the app icon.
$ErrorActionPreference = 'Stop'
$W = 1200; $H = 630
$out = 'D:\SulationDy\dyposcloud\public\og-image.png'

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Background: deep navy vertical gradient, same plate as the icon.
$gTop = [System.Drawing.PointF]::new(0, 0)
$gBot = [System.Drawing.PointF]::new(0, $H)
$bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $gTop, $gBot,
    [System.Drawing.Color]::FromArgb(255, 20, 30, 52),
    [System.Drawing.Color]::FromArgb(255, 6, 10, 20))
$g.FillRectangle($bg, 0, 0, $W, $H)

# Soft cyan glow behind the mark.
$glow = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(300, 180),
    [System.Drawing.PointF]::new(300, 460),
    [System.Drawing.Color]::FromArgb(70, 56, 189, 248),
    [System.Drawing.Color]::FromArgb(0, 37, 99, 235))
$g.FillEllipse($glow, 120, 150, 360, 360)

# Mark, scaled from the 512 icon.
$icon = [System.Drawing.Bitmap]::new('D:\SulationDy\dyposcloud\public\icons\icon-512.png')
$g.DrawImage($icon, 150, 165, 300, 300)
$icon.Dispose()

# Wordmark + tagline.
$titleFont = [System.Drawing.Font]::new(
    [System.Drawing.FontFamily]::new('Segoe UI'),
    [single]92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 248, 250, 252))
$g.DrawString('DyPOS', $titleFont, $white, 500, 200)

$subFont = [System.Drawing.Font]::new(
    [System.Drawing.FontFamily]::new('Segoe UI'),
    [single]40, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$cyan = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 56, 189, 248))
$g.DrawString('نظام إدارة الأعمال والمبيعات', $subFont, $cyan, 506, 310)

$bodyFont = [System.Drawing.Font]::new(
    [System.Drawing.FontFamily]::new('Segoe UI'),
    [single]30, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 148, 163, 184))
$g.DrawString('نقطة بيع · محاسبة · تخطيط موارد · مؤشرات أداء', $bodyFont, $muted, 506, 380)

$brandFont = [System.Drawing.Font]::new(
    [System.Drawing.FontFamily]::new('Segoe UI'),
    [single]24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('شركة المنافذ الذكية للبرمجيات', $brandFont, $muted, 506, 440)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "wrote $out ($W x $H)"