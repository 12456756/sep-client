module.exports = async context => {
  await (await import('./speech-packaging.mjs')).beforePack(context)
  await (await import('./office-assets.mjs')).beforeOfficePack(context)
  await (await import('./local-media-assets.mjs')).beforeLocalMediaPack(context)
}
