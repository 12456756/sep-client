module.exports = async context => {
  await (await import('./verify-packaged-runtime.mjs')).verifyAfterPack(context)
  await (await import('./speech-packaging.mjs')).afterPack(context)
  await (await import('./office-assets.mjs')).afterOfficePack(context)
}
