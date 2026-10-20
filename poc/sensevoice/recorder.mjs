/* global window, document, AudioContext, AudioWorkletNode, navigator */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Mic, Square, X, RotateCcw, Play } from 'lucide-react'
import brand from '../../src/assets/logo.png'
import workletUrl from './capture-worklet.js?url'
import { CaptureBuffer, signalStats } from './audio-processing.mjs'

const byId = id => document.getElementById(id)
byId('brand').src = brand
const icons = { mic: Mic, stop: Square, cancel: X, clear: RotateCcw, play: Play }
for (const element of document.querySelectorAll('[data-icon]')) {
  createRoot(element).render(createElement(icons[element.dataset.icon], { size: 17, 'aria-hidden': true }))
}
const labels = { idle: '\u5c31\u7eea', arming: '\u7b49\u5f85\u9ea6\u514b\u98ce', recording: '\u5f55\u97f3\u4e2d',
  stopping: '\u6b63\u5728\u6536\u9f50\u97f3\u9891', preparing: '\u6b63\u5728\u5904\u7406\u97f3\u9891',
  processing: '\u6b63\u5728\u8bc6\u522b', done: '\u8bc6\u522b\u5b8c\u6210',
  cancelling: '\u6b63\u5728\u53d6\u6d88', cancelled: '\u5df2\u53d6\u6d88', error: '\u5f55\u97f3\u5931\u8d25' }
let phase = 'idle', current, retained, playback
let playbackGeneration = 0

function setPhase(next) {
  phase = next
  document.body.dataset.phase = next
  byId('status').textContent = labels[next]
  const active = ['arming', 'recording', 'stopping', 'preparing', 'processing', 'cancelling'].includes(next)
  byId('start').disabled = active
  byId('stop').disabled = next !== 'recording'
  byId('cancel').disabled = !active || next === 'cancelling'
  byId('clear').disabled = active
  byId('play-source').disabled = active || !retained
  byId('play-processed').disabled = active || !retained
}

function draw(samples) {
  const canvas = byId('waveform'), context = canvas.getContext('2d')
  const width = canvas.width, height = canvas.height
  context.clearRect(0, 0, width, height)
  context.strokeStyle = '#b8c6ce'
  context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke()
  if (!samples?.length) return
  context.strokeStyle = '#287453'; context.lineWidth = 2
  context.beginPath()
  const step = Math.max(1, Math.floor(samples.length / width))
  for (let pixel = 0; pixel < width; pixel++) {
    const value = samples[Math.min(samples.length - 1, pixel * step)]
    const y = height / 2 - value * height * 0.44
    if (pixel === 0) context.moveTo(pixel, y)
    else context.lineTo(pixel, y)
  }
  context.stroke()
}

function updateDuration(seconds) {
  byId('duration').textContent = `00:${seconds.toFixed(1).padStart(4, '0')}`
}

async function release(session) {
  clearTimeout(session.tailTimer)
  if (session.node) { session.node.port.onmessage = null; session.node.port.close(); session.node.disconnect() }
  session.source?.disconnect()
  session.mute?.disconnect()
  for (const track of session.stream?.getTracks() ?? []) { track.onended = null; track.stop() }
  if (session.context && session.context.state !== 'closed') await session.context.close().catch(() => undefined)
}

async function stopPlayback() {
  playbackGeneration++
  const prior = playback
  playback = undefined
  byId('stop-playback').disabled = true
  if (prior) await prior.close().catch(() => undefined)
}

function clearResult() {
  retained = undefined
  byId('transcript').value = ''
  for (const id of ['source-rate', 'output-rate', 'sample-count', 'rms', 'load-time', 'decode-time']) byId(id).textContent = '--'
  byId('error').hidden = true
  byId('quality').hidden = true
  updateDuration(0)
  draw()
}

async function fail(session, error) {
  if (current !== session) return
  current = undefined
  await release(session)
  await window.speechPoc.cancel(session.id).catch(() => undefined)
  const message = error?.message ?? String(error)
  byId('error').textContent = ['MICROPHONE_DENIED', 'NotAllowedError', 'Permission denied'].some(text => message.includes(text))
    ? '\u672a\u83b7\u5f97\u9ea6\u514b\u98ce\u6743\u9650\uff0c\u8bf7\u5141\u8bb8\u540e\u91cd\u8bd5\u3002' : message
  byId('error').hidden = false
  setPhase('error')
}

async function finish(session, marker) {
  if (current !== session || session.finishing) return
  session.finishing = true
  setPhase('stopping')
  try {
    const samples = session.buffer.finish(marker)
    await release(session)
    if (current !== session) return
    setPhase('preparing')
    const preparation = await window.speechPoc.prepare({ recordingId: session.id, sampleRate: session.sampleRate, samples })
    if (current !== session) return
    if (!preparation.ok) throw new Error(preparation.error)
    const prepared = preparation.data
    retained = { original: samples, originalRate: session.sampleRate, processed: prepared.samples }
    byId('output-rate').textContent = '16,000 Hz'
    byId('sample-count').textContent = `${prepared.source.sampleCount.toLocaleString()} / ${prepared.processed.sampleCount.toLocaleString()}`
    byId('rms').textContent = prepared.source.rms.toFixed(4)
    updateDuration(prepared.source.durationSeconds)
    draw(samples)
    setPhase('processing')
    const response = await window.speechPoc.recognize({ recordingId: session.id, sampleRate: 16000, samples: prepared.samples })
    if (current !== session) return
    if (!response.ok) throw new Error(response.error)
    const result = response.data
    if (result.recordingId !== session.id) throw new Error('Stale speech recognition response')
    byId('transcript').value = result.text
    byId('load-time').textContent = result.reusedModel ? '\u5df2\u590d\u7528' : `${Math.round(result.modelLoadMs)} ms`
    byId('decode-time').textContent = `${Math.round(result.elapsedMs)} ms`
    if (result.silent || prepared.source.rms < 0.005 || prepared.source.clippedSamples) {
      byId('quality').textContent = result.silent ? '\u672a\u68c0\u6d4b\u5230\u6709\u6548\u58f0\u97f3\u3002'
        : '\u97f3\u91cf\u504f\u4f4e\u6216\u5b58\u5728\u524a\u6ce2\uff0c\u8bf7\u56de\u653e\u68c0\u67e5\u3002'
      byId('quality').hidden = false
    }
    current = undefined
    setPhase('done')
  } catch (error) { await fail(session, error) }
}

async function start() {
  if (current || phase === 'cancelling') return
  const session = { id: crypto.randomUUID(), finishing: false }
  current = session
  clearResult()
  setPhase('arming')
  try {
    await stopPlayback()
    const armed = await window.speechPoc.arm(session.id)
    if (current !== session) return
    if (!armed.ok) throw new Error(armed.error)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 } }, video: false })
    session.stream = stream
    if (current !== session) { await release(session); return }
    session.context = new AudioContext()
    await session.context.resume()
    if (current !== session) { await release(session); return }
    await session.context.audioWorklet.addModule(workletUrl)
    if (current !== session) { await release(session); return }
    session.sampleRate = session.context.sampleRate
    session.buffer = new CaptureBuffer(session.sampleRate)
    session.node = new AudioWorkletNode(session.context, 'sensevoice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    session.node.onprocessorerror = () => void fail(session, new Error('Audio capture processor failed'))
    session.node.port.onmessage = ({ data }) => {
      if (current !== session) return
      if (data.type === 'chunk') {
        try {
          session.buffer.append(data)
          updateDuration(session.buffer.sampleCount / session.sampleRate)
          byId('rms').textContent = signalStats(data.samples, session.sampleRate).rms.toFixed(4)
          draw(data.samples)
        } catch (error) { void fail(session, error) }
      } else if (data.type === 'stopped') void finish(session, data)
    }
    session.source = session.context.createMediaStreamSource(stream)
    session.mute = session.context.createGain()
    session.mute.gain.value = 0
    session.source.connect(session.node)
    session.node.connect(session.mute).connect(session.context.destination)
    byId('source-rate').textContent = `${session.sampleRate.toLocaleString()} Hz`
    stream.getAudioTracks()[0].onended = () => void fail(session, new Error('Microphone disconnected'))
    setPhase('recording')
  } catch (error) { await fail(session, error) }
}

function stop() {
  if (!current || phase !== 'recording') return
  const session = current
  setPhase('stopping')
  session.tailTimer = setTimeout(() => void fail(session, new Error('Timed out collecting the final audio samples')), 2000)
  session.node.port.postMessage({ type: 'stop' })
}

async function cancel() {
  const session = current
  if (!session) return
  current = undefined
  retained = undefined
  setPhase('cancelling')
  await release(session)
  await window.speechPoc.cancel(session.id).catch(() => undefined)
  setPhase('cancelled')
}

async function play(processed) {
  if (!retained || current) return
  const audio = retained
  const stopped = stopPlayback(), generation = playbackGeneration
  await stopped
  if (retained !== audio || current || playbackGeneration !== generation) return
  const context = new AudioContext()
  try {
    playback = context
    await context.resume()
    if (playback !== context || current || retained !== audio) return
    const samples = processed ? audio.processed : audio.original
    const buffer = context.createBuffer(1, samples.length, processed ? 16000 : audio.originalRate)
    buffer.copyToChannel(samples, 0)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    node.onended = () => { if (playback === context) void stopPlayback() }
    byId('stop-playback').disabled = false
    node.start()
  } catch (error) {
    if (playback !== context) return
    await stopPlayback()
    byId('error').textContent = error.message
    byId('error').hidden = false
  }
}

byId('start').addEventListener('click', () => void start())
byId('stop').addEventListener('click', stop)
byId('cancel').addEventListener('click', () => void cancel())
byId('clear').addEventListener('click', () => { void stopPlayback(); clearResult(); setPhase('idle') })
byId('play-source').addEventListener('click', () => void play(false))
byId('play-processed').addEventListener('click', () => void play(true))
byId('stop-playback').addEventListener('click', () => void stopPlayback())
window.addEventListener('beforeunload', () => { void cancel(); void stopPlayback() })
draw()
setPhase('idle')
