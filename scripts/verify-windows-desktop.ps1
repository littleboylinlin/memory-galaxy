$ErrorActionPreference = 'Stop'
$version = node -p 'require("./package.json").version'
$installer = Get-Item "release/MemoryGalaxy-Setup-$version-x64.exe"
$destination = Join-Path $env:RUNNER_TEMP 'memory-galaxy-install'
$profile = Join-Path $env:APPDATA 'Memory Galaxy'
$addresses = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
if (Test-Path $profile) { throw 'Windows test requires a clean default profile' }

function Block-Network([string]$Program) {
    New-NetFirewallRule -DisplayName 'Memory Galaxy acceptance offline' -Program $Program -Direction Outbound -Action Block -RemoteAddress $addresses
}
function Install-Desktop([string]$Package) {
    $rule = Block-Network $Package
    try {
        $setup = Start-Process -FilePath $Package -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
        if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)" }
    } finally {
        Remove-NetFirewallRule -Name $rule.Name
    }
}

$previous = Join-Path $env:RUNNER_TEMP 'MemoryGalaxy-Setup-0.6.0-x64.exe'
Invoke-WebRequest -Uri 'https://github.com/littleboylinlin/memory-galaxy/releases/download/v0.6.0/MemoryGalaxy-Setup-0.6.0-x64.exe' -OutFile $previous
if ((Get-FileHash -Algorithm SHA256 $previous).Hash.ToLowerInvariant() -ne 'e4abe6fab9012f9d6ee0111e8f31d118512832e317fe80aa4a49c581ba2db24c') {
    throw '0.6.0 installer checksum mismatch'
}
Install-Desktop $previous

$exe = Join-Path $destination 'MemoryGalaxy.exe'
if (-not (Test-Path $exe -PathType Leaf)) { throw '0.6.0 installation is missing its executable' }
$appRule = Block-Network $exe
try {
    $env:MEMORY_GALAXY_INSTALLED_EXE = $exe
    $env:MEMORY_GALAXY_EXPECTED_ARCH = 'x64'
    $env:MEMORY_GALAXY_PROFILE_DIRECTORY = $profile
    $env:MEMORY_GALAXY_PROFILE_REPORT = Join-Path $env:RUNNER_TEMP 'windows-profile.json'
    $env:MEMORY_GALAXY_PROFILE_MODE = 'seed'
    $env:MEMORY_GALAXY_PROFILE_VERSION = '0.6.0'
    node --test tests/desktop/profile.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Seeding the 0.6.0 profile failed' }

    Install-Desktop $installer.FullName
    $env:MEMORY_GALAXY_PROFILE_MODE = 'check'
    $env:MEMORY_GALAXY_PROFILE_VERSION = $version
    node --test tests/desktop/profile.test.mjs
    if ($LASTEXITCODE -ne 0) { throw '0.6.0 to 0.7.0 upgrade acceptance failed' }
    npm run test:desktop
    if ($LASTEXITCODE -ne 0) { throw 'Windows native acceptance failed' }

    $database = Join-Path $profile 'library/memory-galaxy.sqlite3'
    $digest = (Get-FileHash -Algorithm SHA256 $database).Hash
    $uninstaller = @(Get-ChildItem -LiteralPath $destination -Filter 'Uninstall*.exe')
    if ($uninstaller.Count -ne 1) { throw 'Expected one NSIS uninstaller' }
    $uninstall = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0 -or (Test-Path $exe)) { throw 'NSIS uninstall failed' }
    if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $digest) { throw 'Uninstall changed the profile database' }
    Write-Host 'NSIS uninstall removed the application and preserved the 0.6.0 default-profile database.'
} finally {
    Remove-NetFirewallRule -Name $appRule.Name
}
node scripts/desktop-artifacts.mjs stage windows-x64
if ($LASTEXITCODE -ne 0) { throw 'Staging the tested installer failed' }
