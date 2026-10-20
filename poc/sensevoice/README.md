# SenseVoice CPU Compatibility POC

## Scope

This isolated POC covers local WAV recognition (step 1) and microphone
capture (step 2). Recognition runs in an Electron `utilityProcess`, not in
the production main process or renderer. There is no chat UI integration,
Pi integration, production IPC, or installer change. No Python or GPU is used.

Pinned runtime: `sherpa-onnx-node@1.13.8`, with platform binaries pinned in
`package-lock.json`. Tested host: Electron 33.4.11, Windows x64.

## Developer Setup

```powershell
npm ci
powershell -NoProfile -File poc/sensevoice/prepare.ps1
npm run poc:speech
```

The preparation script downloads the model, vocabulary, and public Chinese
fixture at the exact revision recorded in
`resources/speech/sensevoice-int8/manifest.json`. It checks file sizes, the
upstream model SHA-256, and the upstream Git blob hashes for the other files.
It is a developer/build preparation step, not an end-user download mechanism.
The model is about 228.2 MiB (239,233,841 bytes). Large assets remain local and
are excluded from Git; their manifest and license notices are tracked.

To use a personal recording, provide a mono PCM16 16 kHz WAV of at most 30
seconds. The batch WAV command deliberately does not resample or denoise.

```powershell
npm run poc:speech -- --wav "D:/recordings/example.wav" --runs 3
npm run poc:speech -- --threads 1 --output artifacts/sensevoice/one-thread.json
npm run test:speech
npm run test:speech:electron
```

Recognition does not make network requests or download missing resources.
Missing/corrupt resources cause a failure; there is no cloud fallback.
`--model-dir` overrides the local resource directory. `--timeout-ms` defaults
to 120000. A separate Electron profile avoids touching normal user sessions.

## Microphone Recorder

```powershell
npm run poc:speech:record
```

This builds and opens a standalone Electron window. It does not start recording
automatically. Click the microphone button, accept the native permission
dialog, speak, then stop to recognize. Recording automatically ends at 30
seconds. Cancel stops capture or an in-progress worker request. Closing the
window releases the microphone and recognition worker.

The capture path is:

1. `getUserMedia` obtains the microphone after explicit permission.
2. `AudioWorklet` collects Float32 PCM and mixes channels to mono. The actual
   `AudioContext.sampleRate` is used, not a requested or assumed device rate.
3. Stop flushes the partial final block. Sequence numbers and sample counts
   detect missing or duplicated blocks before inference.
4. A utility process uses sherpa's native band-limited `LinearResampler` to
   produce 16 kHz audio, including its buffered tail. Chromium's default
   `OfflineAudioContext` conversion was rejected by the anti-aliasing test.
5. The INT8 recognizer consumes the normalized Float32 samples. INT8 describes
   the model weights, not an 8-bit recording format.

Resampling never boosts quiet audio. If interpolation overshoots full scale,
the entire processed signal is attenuated by the same factor, avoiding peak
clipping. The POC shows RMS and warns about low volume or clipped input. Exact
or near-zero signals bypass inference and return no transcript; this is not a
general-purpose speech detector. No custom denoiser, VAD, or silence trimming
is introduced. Chromium's default microphone processing remains in effect.

Raw and resampled audio can both be replayed. Audio and transcripts stay in
memory; the interactive recorder does not write them to files or logs and
makes no cloud requests. Clear, cancellation, a new recording, or closing the
window drops the retained buffers. This is lifetime control, not guaranteed
secure memory erasure. The model stays warm between recordings, is killed on
an active-request cancellation/error/timeout, and is released after five idle
minutes. No production task/session is loaded.

The isolated preload exposes only four validated operations: arm, prepare,
recognize, cancel. The main process controls model paths. Renderer payloads
are bounded to mono Float32, 8-96 kHz, and 30 seconds; model input must be
16 kHz. Unknown fields and renderer-provided paths are rejected. Node access,
camera access, external navigation, popups, and network requests are disabled
in this window. Audio permission is limited to its armed top-level frame.

```powershell
npm run test:speech
npm run test:speech:electron
npm run test:speech:record
```

The recorder tests use only Chromium's virtual microphone and the public WAV
fixture, never the physical microphone. They exercise actual Electron sandbox
IPC, worklets, native resampling/recognition, silence, permissions, cancellation,
model reuse, timeouts, and desktop/narrow layouts. Synthetic tones verify
48/44.1 kHz conversion, stop-band attenuation, duration, and tail retention.
Screenshots under `artifacts/sensevoice/recorder-tests` contain only the public
test fixture's text. These tests verify the pipeline, not microphone accuracy.
Real-device speech, noise conditions, accents, and business terms still need
human-transcribed recordings before choosing an accuracy target.

Recorder files are kept under `poc/sensevoice`: `recorder.mjs` is the UI,
`capture-worklet.js` collects PCM, `audio-processing.mjs` validates/prepares
samples, `recorder-controller.mjs` owns isolated IPC, and `recorder-main.mjs`
owns permission and process lifetimes. `worker.mjs` serves both POCs.

## Audio and Process Boundary

The worker validates the WAV container, PCM format, duration and normalized
sample values before inference. `sherpa.readWave(path, false)` is required:
Electron rejects the native library's default external ArrayBuffers. Passing
`false` requests a copied buffer while preserving Float32 samples. The INT8
model does not imply 8-bit input audio.

The recognizer is initialized once, then reused for the requested decodes.
The worker reports model-load time, per-decode time and real-time factor,
audio levels, RSS, and process high-water RSS. The parent samples its own
event loop every 50 ms; this checks responsiveness, not GUI frame rate. The
worker is terminated on completion, error or timeout. No real app is opened.

Evidence is written to `artifacts/sensevoice/result.json` by default. It
contains the transcript, so use only approved recordings and do not publish
personal-recording evidence. It is ignored by Git. A new default run replaces
the previous report; use `--output` to retain multiple reports.

`passed` means inference completed and repeated decodes were consistent. It
is **not** an accuracy claim. `matchesPublishedReference` compares with the
published FP32 example output (not a human-annotated ground truth).
`accuracyReviewRequired` remains true when that output differs. Custom audio
has no automatic transcript comparison.

## Initial Measurement (2026-10-20)

AMD Ryzen 5 4600H, Windows x64, Electron 33.4.11, CPU provider, two threads:

- Input: official 5.592-second Chinese sample, mono PCM16, 16 kHz.
- Model initialization: approximately 1.8-2.1 seconds in measured runs.
- Decode: approximately 0.29-0.32 seconds per run, RTF about 0.05-0.06.
- Worker peak RSS: approximately 371-375 MiB, not total app memory.
- Three decodes produced the same nonempty output; main heartbeat continued.
- INT8 output differs by one Chinese character from the published FP32
  example. The published reference begins with U+5F00 U+653E; the INT8 output
  begins with U+5F00 U+996D. Do not treat this sample as an accuracy pass.

Results are machine-specific and do not establish business-vocabulary
accuracy, long-recording quality, microphone quality, or minimum hardware.

## Licensing and Remaining Work

The runtime uses Apache-2.0 (`RUNTIME_LICENSE`). Model weights have a separate
FunASR Model Open Source License Agreement (`MODEL_LICENSE`), linked by the
upstream model repository. The checked-in notice was retrieved on 2026-10-20;
the upstream model repository points at a mutable license location. Preserve
model/author attribution and obtain distribution approval before a commercial
release. Do not describe the weights as Apache-2.0 merely because the runtime
is Apache-2.0. The bundled WAV is a public compatibility fixture, not a planned
production resource; its redistribution rights also need checking if shipped.

Next steps, outside this POC:

- Compare fixed human-transcribed business recordings before choosing an
  accuracy target or approving INT8 quality.
- Integrate the validated recorder with production IPC and chat text insertion.
- Bundle model/vocabulary/notices as `extraResources`; unpack native binaries
  and libraries as required by the real installer.
- Add build-time checks that reject missing model assets and test an offline
  installer on a clean PC. Current packaging does **not** include this model.
- Validate macOS/Linux and their native libraries separately.
