[CmdletBinding()]
param(
    [switch]$NativeTestsOnly,
    [switch]$SkipNativeTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$savedEnvironment = @{}
foreach ($key in @('PATH', 'CARGO_HOME', 'RUSTUP_HOME', 'LIB', 'INCLUDE')) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

Push-Location $projectRoot
try {
    # Reuse a project-local Rust install when available. No installer or global
    # environment changes are performed by this script.
    $localCargo = Join-Path $projectRoot '.tools/cargo'
    if (Test-Path -LiteralPath (Join-Path $localCargo 'bin/cargo.exe')) {
        $env:CARGO_HOME = $localCargo
        $env:RUSTUP_HOME = Join-Path $projectRoot '.tools/rustup'
        $env:PATH = (Join-Path $localCargo 'bin') + ';' + $env:PATH
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw 'Rust is required. Install the official minimal x86_64-pc-windows-msvc toolchain before packaging.'
    }

    # Build Tools can be usable even when an old installer registration is
    # incomplete. Check actual compiler, linker, SDK headers and libraries.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vcTools = $null
    if (Test-Path -LiteralPath $vswhere) {
        $installations = @(& $vswhere -all -products '*' -property installationPath)
        foreach ($installation in $installations) {
            $toolsDirectory = Join-Path $installation 'VC/Tools/MSVC'
            if (-not (Test-Path -LiteralPath $toolsDirectory)) { continue }
            $candidates = Get-ChildItem -LiteralPath $toolsDirectory -Directory | Sort-Object Name -Descending
            foreach ($candidate in $candidates) {
                if ((Test-Path -LiteralPath (Join-Path $candidate.FullName 'bin/Hostx64/x64/cl.exe')) -and
                    (Test-Path -LiteralPath (Join-Path $candidate.FullName 'bin/Hostx64/x64/link.exe')) -and
                    (Test-Path -LiteralPath (Join-Path $candidate.FullName 'lib/x64/vcruntime.lib'))) {
                    $vcTools = $candidate.FullName
                    break
                }
            }
            if ($vcTools) { break }
        }
    }
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
    $sdk = $null
    $sdkLib = Join-Path $sdkRoot 'Lib'
    if (Test-Path -LiteralPath $sdkLib) {
        $sdk = Get-ChildItem -LiteralPath $sdkLib -Directory | Sort-Object Name -Descending |
            Where-Object {
                (Test-Path -LiteralPath (Join-Path $_.FullName 'um/x64/kernel32.lib')) -and
                (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt/x64/ucrt.lib')) -and
                (Test-Path -LiteralPath (Join-Path $sdkRoot "bin/$($_.Name)/x64/rc.exe"))
            } | Select-Object -First 1
    }
    if ($vcTools -and $sdk) {
        $sdkVersion = $sdk.Name
        $env:PATH = "$vcTools\bin\Hostx64\x64;$sdkRoot\bin\$sdkVersion\x64;$env:PATH"
        $env:LIB = "$vcTools\lib\x64;$sdkRoot\Lib\$sdkVersion\um\x64;$sdkRoot\Lib\$sdkVersion\ucrt\x64"
        $env:INCLUDE = "$vcTools\include;$sdkRoot\Include\$sdkVersion\ucrt;$sdkRoot\Include\$sdkVersion\um;$sdkRoot\Include\$sdkVersion\shared"
    } elseif (-not ($env:LIB -and (Get-Command cl -ErrorAction SilentlyContinue))) {
        throw 'Visual C++ x64 build tools and Windows SDK are required. Run in a configured developer shell after installing them.'
    }

    if (-not $SkipNativeTests) {
        & cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
        if ($LASTEXITCODE -ne 0) { throw 'Native account-vault tests failed.' }
    }
    if ($NativeTestsOnly) { return }

    $version = (Get-Content -LiteralPath package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $tauriVersion = (Get-Content -LiteralPath src-tauri/tauri.conf.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($version -ne $tauriVersion) { throw 'Frontend and desktop versions differ.' }

    & npm.cmd run build:desktop -- -- --locked
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }

    $bundleDirectory = Join-Path $projectRoot 'src-tauri/target/release/bundle/nsis'
    $packages = @(Get-ChildItem -LiteralPath $bundleDirectory -Filter "*_${version}_x64-setup.exe" -File)
    if ($packages.Count -ne 1) { throw 'Expected exactly one Windows x64 NSIS installer for this version.' }
    $outputDirectory = Join-Path $projectRoot 'install'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $name = "Nekox-OSS-Tool-$version-windows-x64-setup.exe"
    $destination = Join-Path $outputDirectory $name
    Copy-Item -LiteralPath $packages[0].FullName -Destination $destination -Force
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name" | Set-Content -LiteralPath (Join-Path $outputDirectory 'SHA256SUMS.txt') -Encoding ascii
    Write-Output "Installer: $destination"
    Write-Output "SHA256: $hash"
}
finally {
    Pop-Location
    foreach ($key in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
    }
}
