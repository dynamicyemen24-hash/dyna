Add-Type -AssemblyName System.Drawing

# Reproduces the shipped DyPOS mark — a cyan-to-blue "P" over a deep navy
# rounded square — at every size the platform asks for. The source favicon.ico
# only carried 48x48, so upscaling it would have looked soft on a home screen.
$ErrorActionPreference = 'Stop'
$out = 'D:\SulationDy\dyposcloud\public\icons'

function Draw-DyposIcon([int]$size, [string]$file, [int]$inset, [bool]$transparent) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Transparent padding for maskable: the launcher crops, so the safe zone
    # must be generous or the glyph gets cut.
    if ($transparent) { $g.Clear([System.Drawing.Color]::Transparent) }

    $pad = [double]$inset
    $box = New-Object System.Drawing.RectangleF $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
    $radius = $box.Width * 0.22

    # Rounded navy plate.
    $plate = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $plate.AddArc($box.X, $box.Y, $d, $d, 180, 90)
    $plate.AddArc(($box.X + $box.Width - $d), $box.Y, $d, $d, 270, 90)
    $plate.AddArc(($box.X + $box.Width - $d), ($box.Y + $box.Height - $d), $d, $d, 0, 90)
    $plate.AddArc($box.X, ($box.Y + $box.Height - $d), $d, $d, 90, 90)
    $plate.CloseFigure()

    $navyTop = [System.Drawing.Color]::FromArgb(255, 22, 32, 56)
    $navyBot = [System.Drawing.Color]::FromArgb(255, 7, 12, 24)
    $pTop = [System.Drawing.PointF]::new([single]$box.X, [single]$box.Y)
    $pBot = [System.Drawing.PointF]::new([single]$box.X, [single]($box.Y + $box.Height))
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($pTop, $pBot, $navyTop, $navyBot)
    $g.FillPath($brush, $plate)

    # Cyan -> blue "P" over the navy plate.
    #
    # Two filled shapes, no boolean paths: the stem plus a half-ellipse bowl,
    # then a slightly smaller half-ellipse in the plate colour punches the
    # counter. This keeps the counters perfectly parallel — the earlier
    # single-path version produced a skewed hole at small sizes.
    $x0 = $box.X + $box.Width * 0.285
    $stemW = $box.Width * 0.150
    $x1 = $x0 + $stemW
    $y0 = $box.Y + $box.Height * 0.185
    $stemBottom = $box.Y + $box.Height * 0.585
    $bowlBottom = $y0 + ($stemBottom - $y0) * 0.58
    $bowlH = $bowlBottom - $y0
    $rx = $box.Width * 0.225
    $bar = $stemW * 0.56

    $cyan = [System.Drawing.Color]::FromArgb(255, 56, 189, 248)
    $blue = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    $gTop = [System.Drawing.PointF]::new([single]$x0, [single]$y0)
    $gBot = [System.Drawing.PointF]::new([single]$x0, [single]$stemBottom)
    $pg = [System.Drawing.Drawing2D.LinearGradientBrush]::new($gTop, $gBot, $cyan, $blue)

    # Stem.
    $g.FillRectangle($pg, [single]$x0, [single]$y0, [single]$stemW, [single]($stemBottom - $y0))

    # Bowl — a half ellipse starting at the stem's right edge, so the shoulder
    # above it stays flat and the letter reads as P rather than D.
    $bowl = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $bowl.AddArc([single]($x1 - $rx), [single]$y0, [single]($rx * 2), [single]$bowlH, 270, 180)
    $bowl.CloseFigure()
    $g.FillPath($pg, $bowl)

    # Counter: a full ellipse in the plate gradient, so the letter reads as a clean
    # ring. Only the right half is visible once the stem is filled over it.
    $plateBrushForHole = [System.Drawing.Drawing2D.LinearGradientBrush]::new($pTop, $pBot, $navyTop, $navyBot)
    $holeCx = $x1 - $rx + $bar + ($rx - $bar)   # centre of the inset ellipse
    $hole = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $hole.AddEllipse([single]($x1 - $rx + $bar), [single]($y0 + $bar), [single](($rx - $bar) * 2), [single]($bowlH - ($bar * 2)))
    $hole.CloseFigure()
    $g.FillPath($plateBrushForHole, $hole)
    # Re-lay the stem so only the bowl's half of the counter stays open.
    $g.FillRectangle($pg, [single]$x0, [single]$y0, [single]$stemW, [single]($stemBottom - $y0))

    # "DyPOS" wordmark, clear of the glyph's descender.
    if ($size -ge 128) {
        $fam = [System.Drawing.FontFamily]::new('Segoe UI')
        $font = [System.Drawing.Font]::new($fam, [single]($box.Width * 0.145), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $fmt = [System.Drawing.StringFormat]::new()
        $fmt.Alignment = [System.Drawing.StringAlignment]::Center
        $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = [System.Drawing.RectangleF]::new([single]$box.X, [single]($box.Y + $box.Height * 0.68), [single]$box.Width, [single]($box.Height * 0.19))
        $wb = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 226, 232, 240))
        $g.DrawString('DyPOS', $font, $wb, $rect, $fmt)
        $wb.Dispose(); $fmt.Dispose(); $font.Dispose()
    }

    $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "  wrote $file ($size x $size)"
}

Write-Output 'Generating DyPOS app icons...'
Draw-DyposIcon 192 (Join-Path $out 'icon-192.png') 0 $false
Draw-DyposIcon 512 (Join-Path $out 'icon-512.png') 0 $false
Draw-DyposIcon 180 (Join-Path $out 'apple-touch-icon.png') 0 $false
# Maskable fills the whole canvas with the navy plate but stays transparent
# outside the safe zone, so the launcher can round/crop it freely.
Draw-DyposIcon 512 (Join-Path $out 'maskable-512.png') 42 $true
Write-Output 'done'