param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot '../../dist/download/manifest.json'),
    [string]$ExpectedThumbprint = $env:DOCSYNC_SIGN_CERT_SHA1
)
$ErrorActionPreference = 'Stop'
$manifestFile = Get-Item -LiteralPath $ManifestPath
$manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
if (-not $manifest.signature -or $manifest.signature.status -ne 'Valid') { throw 'The manifest does not declare a signed installer.' }
$expected = ($ExpectedThumbprint -replace '\s', '').ToUpperInvariant()
if ($expected -notmatch '^[A-F0-9]{40}$') {
    throw 'Configure the repository variable WINDOWS_SIGNER_THUMBPRINT before publishing signed installers.'
}
if ($manifest.signature.thumbprint -ne $expected) { throw 'Manifest signer is not the approved publisher.' }
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$temporaryFile = Join-Path $temporaryRoot ('docsync-verify-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
    $stream = [System.IO.File]::Create($temporaryFile)
    try {
        foreach ($part in $manifest.parts) {
            if ($part.name -notmatch '^docsync-setup\.part[0-9]{2,3}\.bin$') { throw 'Unsafe installer part path.' }
            $inputFile = Get-Item -LiteralPath (Join-Path $manifestFile.DirectoryName $part.name)
            if ($inputFile.Length -ne $part.size) { throw 'Installer part size mismatch.' }
            $inputStream = [System.IO.File]::OpenRead($inputFile.FullName)
            try { $inputStream.CopyTo($stream) } finally { $inputStream.Dispose() }
        }
    } finally { $stream.Dispose() }
    if ((Get-Item -LiteralPath $temporaryFile).Length -ne $manifest.size) { throw 'Installer total size mismatch.' }
    if ((Get-FileHash -LiteralPath $temporaryFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) {
        throw 'Installer checksum mismatch.'
    }
    $null = & (Join-Path $PSScriptRoot 'Test-WindowsSignature.ps1') -InstallerPath $temporaryFile -ExpectedThumbprint $expected
    Write-Output 'Windows verified the published installer signature, approved publisher, timestamp and SHA-256.'
} finally {
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
}
