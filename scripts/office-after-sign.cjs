module.exports = async context => {
  await (await import('./office-assets.mjs')).afterOfficeSign(context)
}
