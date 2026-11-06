import assert from 'node:assert/strict';

// Preserve the one already-published unsigned demo while a real certificate is
// being obtained. No other unsigned installer may enter the deployment pipeline.
const LEGACY_SHA256 = '755a8a21f0eb2bb5611c48b85b847e64eb212360b9a231dc25f571b809214011';
export function validateInstallerPolicy(manifest) {
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.size) && manifest.size > 0);
  assert.match(manifest.filename, /^DocSync-Setup-[A-Za-z0-9.+-]+\.exe$/);
  assert.ok(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= 100);
  const names = new Set();
  let size = 0;
  for (const part of manifest.parts) {
    assert.match(part.name, /^docsync-setup\.part[0-9]{2,3}\.bin$/);
    assert.ok(!names.has(part.name), 'Duplicate installer part');
    names.add(part.name);
    assert.ok(Number.isSafeInteger(part.size) && part.size > 0);
    size += part.size;
  }
  assert.equal(size, manifest.size);
  if (!manifest.signature) {
    assert.equal(manifest.sha256, LEGACY_SHA256, 'A new unsigned installer cannot be deployed. Code signing is required.');
    return false;
  }
  assert.equal(manifest.signature.status, 'Valid');
  assert.match(manifest.signature.thumbprint, /^[A-F0-9]{40}$/);
  assert.ok(typeof manifest.signature.publisher === 'string' && manifest.signature.publisher.trim());
  assert.equal(manifest.signature.timestamped, true);
  // These fields are claims until Windows verifies the binary against the
  // independently configured repository variable WINDOWS_SIGNER_THUMBPRINT.
  return true;
}
