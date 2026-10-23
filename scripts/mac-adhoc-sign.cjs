// Builder 25 skips certificate-free signing; sign the completed bundle before archiving.
module.exports = async options => {
  const { signAsync } = await import('@electron/osx-sign')
  if (options.platform !== 'darwin') throw new Error('Ad hoc signing requires a non-MAS macOS application')
  await signAsync({
    ...options,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // osx-sign 1.x treats a truthy value as strict option names; undefined enables --strict.
    strictVerify: undefined,
    optionsForFile: file => ({
      ...options.optionsForFile?.(file),
      hardenedRuntime: false,
      timestamp: 'none',
    }),
  })
}
