module.exports = async context => (await import('./speech-packaging.mjs')).beforePack(context)
