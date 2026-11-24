export function localMediaCandidates(duration: number) {
  const limit = 100
  const silence: { start: number; end: number }[] = []
  const scenes: number[] = []
  let silenceStart: number | undefined
  let silenceTruncated = false
  let scenesTruncated = false
  const stamp = (n: number) => Math.round(n * 1000) / 1000
  return {
    read(line: string) {
      if (line.startsWith('[silencedetect@candidate @ ')) {
        const event = /\] silence_(start|end): (-?\d+(?:\.\d+)?)(?=\s|$)/.exec(line)
        if (!event) return
        const time = Math.min(duration, Math.max(0, Number(event[2])))
        if (event[1] === 'start') silenceStart = time
        else if (silenceStart !== undefined) {
          if (stamp(time) > stamp(silenceStart)) {
            if (silence.length < limit) silence.push({ start: stamp(silenceStart), end: stamp(time) })
            else silenceTruncated = true
          }
          silenceStart = undefined
        }
      } else if (line.startsWith('[showinfo@candidate @ ')) {
        const time = Number(/\bpts_time:\s*([\d.eE+-]+)/.exec(line)?.[1])
        if (!(time > 0 && time < duration) || (scenes.length && stamp(time) <= scenes[scenes.length - 1])) return
        if (scenes.length < limit) scenes.push(stamp(time))
        else scenesTruncated = true
      }
    },
    result() { return { silence, scenes, silenceTruncated, scenesTruncated } },
  }
}

export function measuredLoudness(stderr: string): { integratedLufs: number | null; truePeakDbtp: number | null } {
  const match = /\{\s*"input_i"\s*:\s*"([^"]+)"\s*,\s*"input_tp"\s*:\s*"([^"]+)"/.exec(stderr)
  const finite = (value?: string) => Number.isFinite(Number(value)) ? Number(value) : null
  return { integratedLufs: finite(match?.[1]), truePeakDbtp: finite(match?.[2]) }
}
