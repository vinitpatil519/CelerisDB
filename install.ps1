# Installs the latest `celeris` release for Windows (x64).
#
#   irm https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.ps1 | iex
#
# Environment:
#   CELERIS_VERSION      a release tag such as v0.1.0 (default: latest)
#   CELERIS_INSTALL_DIR  where to put the binary (default: %LOCALAPPDATA%\Programs\Celeris)
$ErrorActionPreference = 'Stop'

$repo = 'vinitpatil519/CelerisDB'
$version = if ($env:CELERIS_VERSION) { $env:CELERIS_VERSION } else { 'latest' }
$dest = if ($env:CELERIS_INSTALL_DIR) { $env:CELERIS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Celeris' }

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'celeris install: a 64-bit Windows is required'
}

$target = 'x86_64-pc-windows-msvc'
$asset = "celeris-$target.zip"
$base = if ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
} else {
    "https://github.com/$repo/releases/download/$version"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("celeris-" + [Guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
    Write-Host "Downloading $asset ($version)..."
    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest "$base/$asset.sha256" -OutFile (Join-Path $tmp "$asset.sha256") -UseBasicParsing

    $expected = ((Get-Content (Join-Path $tmp "$asset.sha256") -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "celeris install: checksum mismatch for $asset" }

    Expand-Archive (Join-Path $tmp $asset) -DestinationPath $tmp -Force
    New-Item -ItemType Directory $dest -Force | Out-Null
    Copy-Item (Join-Path $tmp "celeris-$target\celeris.exe") (Join-Path $dest 'celeris.exe') -Force
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dest) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
    $env:Path = "$env:Path;$dest"
    Write-Host "Added $dest to your user PATH (open a new terminal to pick it up)."
}

& (Join-Path $dest 'celeris.exe') --version
Write-Host 'Next: celeris init; celeris start'
