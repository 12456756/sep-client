module.exports = async context => (await import('./speech-packaging.mjs')).afterPack(context)
