// electron-builder v26: select an existing Windows certificate by public thumbprint.
// Hardware tokens / cloud signing clients must expose their key through Windows.
const { build } = require('./package.json');
const thumbprint = (process.env.DOCSYNC_SIGN_CERT_SHA1 || '').replace(/\s/g, '').toUpperCase();
if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
  throw new Error('Set DOCSYNC_SIGN_CERT_SHA1 to your code-signing certificate thumbprint.');
}
module.exports = {
  ...build,
  forceCodeSigning: true,
  artifactName: 'DocSync-Setup-${version}.${ext}',
  directories: { ...build.directories, output: 'release-signed' },
  win: {
    ...build.win,
    signtoolOptions: {
      certificateSha1: thumbprint,
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: 'http://timestamp.digicert.com'
    }
  }
};
