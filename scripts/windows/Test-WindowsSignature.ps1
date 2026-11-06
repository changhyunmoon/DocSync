param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$ExpectedThumbprint = $env:DOCSYNC_SIGN_CERT_SHA1
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (-not $ExpectedThumbprint -or ($ExpectedThumbprint -replace '\s', '') -notmatch '^[A-Fa-f0-9]{40}$') {
    throw 'A code-signing certificate thumbprint (40 hex characters) is required.'
}
$expected = ($ExpectedThumbprint -replace '\s', '').ToUpperInvariant()
$file = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
if ($file.PSIsContainer -or $file.Extension -ne '.exe') { throw 'An .exe file is required.' }
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
if ($signature.Status -ne 'Valid') {
    throw "Signature verification failed: $($signature.Status). Unsigned or untrusted files cannot be published."
}
if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $expected) {
    throw 'The signer does not match the expected certificate thumbprint.'
}
if (-not $signature.TimeStamperCertificate) { throw 'A trusted timestamp is required.' }
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
if (@($signature.SignerCertificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq $codeSigningOid }).Count -eq 0) {
    throw 'The certificate is not a code-signing certificate.'
}
[pscustomobject]@{
    status = 'Valid'
    thumbprint = $expected
    publisher = $signature.SignerCertificate.Subject
    timestamped = $true
} | ConvertTo-Json -Compress
