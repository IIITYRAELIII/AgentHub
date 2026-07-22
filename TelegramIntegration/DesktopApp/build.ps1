param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$compiler = Join-Path $framework "csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "System C# compiler not found: $compiler"
}

function Find-GacAssembly([string]$Name) {
    $result = Get-ChildItem -Path (Join-Path $env:WINDIR "Microsoft.NET\assembly") `
        -Filter $Name -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $result) { throw "Framework assembly not found: $Name" }
    return $result.FullName
}

$output = Join-Path $root "dist"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$target = Join-Path $output "TyraelIntegration.exe"

& $compiler /nologo /target:winexe /optimize+ /platform:anycpu `
    "/out:$target" `
    "/reference:$(Find-GacAssembly 'PresentationCore.dll')" `
    "/reference:$(Find-GacAssembly 'PresentationFramework.dll')" `
    "/reference:$(Find-GacAssembly 'WindowsBase.dll')" `
    "/reference:$(Find-GacAssembly 'System.Xaml.dll')" `
    /reference:System.dll `
    /reference:System.Core.dll `
    (Join-Path $root "Program.cs")
if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE" }

Write-Output $target
