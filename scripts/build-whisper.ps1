<#
    Builds the whisper.cpp CLI that Captionist ships.

    MSVC rather than a mingw cross-build: ggml's Windows thread-throttling code
    uses THREAD_POWER_THROTTLING_STATE, which mingw-w64 v11 headers do not
    define, so cross-compiling fails outright. Building on the Windows runner
    sidesteps that entirely.

    CPU only. No CUDA, no Vulkan, no BLAS - those pull in runtimes far larger
    than the whole rest of this extension, and Whisper on CPU is what a
    single-purpose caption tool actually needs.

    Usage: scripts/build-whisper.ps1 -Output bin/whisper-cli.exe
#>
param(
    [string]$Output = "bin/whisper-cli.exe",
    [string]$Tag = "v1.8.2",
    [string]$Work = "$env:TEMP/captionist-whisper"
)

$ErrorActionPreference = "Stop"

# Resolve before anything changes directory.
$outDir = Split-Path -Parent $Output
if (-not $outDir) { $outDir = "." }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFull = Join-Path (Resolve-Path $outDir) (Split-Path -Leaf $Output)

if (-not (Test-Path "$Work/src")) {
    Write-Host "==> cloning whisper.cpp $Tag"
    New-Item -ItemType Directory -Force -Path $Work | Out-Null
    git clone --depth 1 --branch $Tag https://github.com/ggml-org/whisper.cpp.git "$Work/src"
    if ($LASTEXITCODE -ne 0) { throw "clone failed" }
}

Push-Location "$Work/src"
try {
    Write-Host "==> configure"
    cmake -B build -S . `
        -DCMAKE_BUILD_TYPE=Release `
        -DBUILD_SHARED_LIBS=OFF `
        -DGGML_NATIVE=OFF `
        -DGGML_BACKEND_DL=OFF `
        -DWHISPER_BUILD_TESTS=OFF `
        -DWHISPER_BUILD_SERVER=OFF `
        -DWHISPER_BUILD_EXAMPLES=ON `
        -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

    Write-Host "==> build"
    cmake --build build --config Release --target whisper-cli -j
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

    $built = Get-ChildItem -Path build -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
    if (-not $built) { throw "whisper-cli.exe was not produced" }
    Copy-Item $built.FullName $outFull -Force

    # GGML_NATIVE=OFF keeps this runnable on any x86-64 machine, but any
    # backend DLLs that did get built have to travel with the exe.
    Get-ChildItem -Path build -Recurse -Filter "*.dll" | ForEach-Object {
        Copy-Item $_.FullName (Join-Path (Split-Path -Parent $outFull) $_.Name) -Force
        Write-Host "    also copied $($_.Name)"
    }

    # Licence travels with the binary.
    Copy-Item "LICENSE" (Join-Path (Split-Path -Parent $outFull) "whisper.cpp-LICENSE") -Force
    @"
This directory contains whisper.cpp's CLI, used by Captionist to transcribe
audio entirely on this machine.

whisper.cpp version: $Tag
Licence:             MIT (see whisper.cpp-LICENSE)
Upstream source:     https://github.com/ggml-org/whisper.cpp/tree/$Tag

Built CPU-only, static, with GGML_NATIVE=OFF so it runs on any x86-64 CPU.
The exact recipe is scripts/build-whisper.ps1 in the Captionist repository:
https://github.com/NiteRix/Captionist

Models are not bundled. Captionist downloads the one you pick into your user
data folder, and they are MIT licensed by OpenAI.
"@ | Set-Content -Path (Join-Path (Split-Path -Parent $outFull) "whisper.cpp-README.txt") -Encoding utf8

    $mb = [math]::Round((Get-Item $outFull).Length / 1MB, 2)
    Write-Host "==> $outFull  $mb MB"
}
finally {
    Pop-Location
}
