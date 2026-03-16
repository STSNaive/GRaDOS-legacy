[CmdletBinding()]
param(
    [ValidateSet("auto", "cpu", "cuda")]
    [string]$Torch = "auto",

    [ValidateSet("cu128", "cu126", "cu124", "cu121", "cu118")]
    [string]$CudaBackend = "cu128",

    [switch]$SkipPrewarm,

    [switch]$RecreateVenv
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$MarkerRoot = Join-Path $ProjectRoot "marker-worker"
$CacheRoot = Join-Path $MarkerRoot ".cache"
$UvCacheDir = Join-Path $CacheRoot "uv"
$LocalToolsDir = Join-Path $ProjectRoot ".tools"
$LocalUvDir = Join-Path $LocalToolsDir "uv"
$LocalUvExe = Join-Path $LocalUvDir "uv.exe"
$VenvPython = Join-Path $MarkerRoot ".venv\Scripts\python.exe"
$PrewarmScript = Join-Path $MarkerRoot "prewarm.py"

function Write-Step {
    param([string]$Message)
    Write-Host "[install-marker] $Message" -ForegroundColor Cyan
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Resolve-Uv {
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCommand) {
        return $uvCommand.Source
    }

    if (Test-Path $LocalUvExe) {
        return $LocalUvExe
    }

    Ensure-Directory $LocalUvDir
    Write-Step "uv not found; installing a local copy into $LocalUvDir"

    $env:UV_UNMANAGED_INSTALL = $LocalUvDir
    try {
        Invoke-RestMethod "https://astral.sh/uv/install.ps1" | Invoke-Expression
    }
    finally {
        Remove-Item Env:UV_UNMANAGED_INSTALL -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $LocalUvExe)) {
        throw "uv installation failed. Install uv manually and rerun this script."
    }

    return $LocalUvExe
}

function Resolve-TorchBackend {
    if ($Torch -eq "cpu") {
        return "cpu"
    }

    if ($Torch -eq "cuda") {
        return $CudaBackend
    }

    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $nvidiaSmi) {
        return "cpu"
    }

    try {
        & $nvidiaSmi.Source "--query-gpu=name" "--format=csv,noheader" *> $null
        if ($LASTEXITCODE -eq 0) {
            return $CudaBackend
        }
    }
    catch {
    }

    return "cpu"
}

function Write-TorchEnv {
    param([string]$Backend)

    $torchDevice = if ($Backend -eq "cpu") { "cpu" } else { "cuda" }
    $localEnvPath = Join-Path $MarkerRoot "local.env"
    @(
        "TORCH_DEVICE=$torchDevice"
    ) | Set-Content -Path $localEnvPath -Encoding ASCII
}

Ensure-Directory $CacheRoot
Ensure-Directory $UvCacheDir

$env:UV_CACHE_DIR = $UvCacheDir
$env:UV_LINK_MODE = "copy"

$uvExe = Resolve-Uv
Write-Step "Using uv: $uvExe"

if ($RecreateVenv -and (Test-Path (Join-Path $MarkerRoot ".venv"))) {
    Write-Step "Removing existing marker virtualenv"
    Remove-Item -Recurse -Force (Join-Path $MarkerRoot ".venv")
}

Write-Step "Syncing marker-worker environment"
& $uvExe sync --project $MarkerRoot --link-mode copy
if ($LASTEXITCODE -ne 0) {
    throw "uv sync failed."
}

if (-not (Test-Path $VenvPython)) {
    throw "Marker virtualenv was not created at $VenvPython"
}

$torchBackend = Resolve-TorchBackend
Write-Step "Installing PyTorch backend: $torchBackend"
& $uvExe pip install --python $VenvPython --link-mode copy --reinstall-package torch --torch-backend $torchBackend torch
if ($LASTEXITCODE -ne 0) {
    throw "PyTorch installation failed for backend $torchBackend"
}

Write-TorchEnv -Backend $torchBackend

if (-not $SkipPrewarm) {
    Write-Step "Prewarming Marker models into $CacheRoot"
    & $VenvPython $PrewarmScript
    if ($LASTEXITCODE -ne 0) {
        throw "Marker prewarm failed."
    }
}
else {
    Write-Step "Skipping prewarm. Models will download on first parse."
}

Write-Step "Done. Marker env: $VenvPython"
Write-Step "Model cache: $(Join-Path $CacheRoot 'models')"
