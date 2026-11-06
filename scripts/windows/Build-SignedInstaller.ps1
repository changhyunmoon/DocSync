param([string]$CertificateThumbprint = $env:DOCSYNC_SIGN_CERT_SHA1)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$desktop = Join-Path $project 'desktop'
$thumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[A-F0-9]{40}$') {
    throw 'First obtain a trusted code-signing certificate, then set DOCSYNC_SIGN_CERT_SHA1 to its thumbprint.'
}
$certificate = Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -le (Get-Date) } |
    Select-Object -First 1
if (-not $certificate) {
    throw 'The selected usable code-signing certificate was not found. Connect/unlock your token or cloud signing client first.'
}
$previousThumbprint = $env:DOCSYNC_SIGN_CERT_SHA1
$previousDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY
try {
    $env:DOCSYNC_SIGN_CERT_SHA1 = $thumbprint
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'true'
    Push-Location $desktop
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'App build failed.' }
        & node ./node_modules/electron-builder/out/cli/cli.js --config electron-builder.signed.cjs --win --x64 --publish never
        if ($LASTEXITCODE -ne 0) { throw 'Signed installer build failed.' }
    } finally { Pop-Location }
    $version = (Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json).version
    $installer = Join-Path $desktop "release-signed/DocSync-Setup-$version.exe"
    $null = & (Join-Path $PSScriptRoot 'Test-WindowsSignature.ps1') -InstallerPath (Join-Path $desktop 'release-signed/win-unpacked/DocSync.exe') -ExpectedThumbprint $thumbprint
    $null = & (Join-Path $PSScriptRoot 'Test-WindowsSignature.ps1') -InstallerPath $installer -ExpectedThumbprint $thumbprint
    & node (Join-Path $project 'scripts/prepare-installer.mjs') --installer $installer --expected-thumbprint $thumbprint
    if ($LASTEXITCODE -ne 0) { throw 'Signed installer packaging failed.' }
    Write-Output 'Signed app and installer verified. Review dist/download, commit it, and push main to deploy.'
} finally {
    $env:DOCSYNC_SIGN_CERT_SHA1 = $previousThumbprint
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousDiscovery
}
