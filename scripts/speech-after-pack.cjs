module.exports = async context => {
  await (await import('./mac-icon.mjs')).afterMacIconPack(context)
  await (await import('./connector-assets.mjs')).afterConnectorPack(context)
  await (await import('./verify-packaged-runtime.mjs')).verifyAfterPack(context)
  await (await import('./speech-packaging.mjs')).afterPack(context)
  await (await import('./office-assets.mjs')).afterOfficePack(context)
  await (await import('./local-media-assets.mjs')).afterLocalMediaPack(context)
  await (await import('./bash-runtime-packaging.mjs')).afterBashRuntimePack(context)
  await (await import('./python-runtime-packaging.mjs')).afterPythonRuntimePack(context)
}
