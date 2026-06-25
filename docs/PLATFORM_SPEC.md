# Data Over Audio Platform Specification

This document defines the project as a portable protocol and implementation
plan. It should be possible to implement the same system in a browser, native
mobile app, desktop app, embedded runtime, or another language by following the
contracts below.

## Product Goal

Transfer arbitrary bytes between nearby devices using only speaker output and
microphone input. The first supported transport is audible 4-FSK audio. The
system prioritizes reliability, explicit readiness checks, and understandable
failure modes over speed.

The core workflow is:

1. Each physical device runs a local speaker-to-microphone self-test.
2. A receiver starts listening.
3. A sender transmits file metadata and data frames.
4. The receiver acknowledges valid frames over a separate acoustic ACK channel.
5. The sender retries missing frames until the file is complete or retry limits
   are reached.

## Non-Goals

- This is not a high-speed file transfer replacement for Wi-Fi, Bluetooth, USB,
  or local network sharing.
- The default protocol must not depend on ultrasonic hardware behavior.
- Calibration must not be modeled as a cross-device link check. Each device must
  prove that its own speaker can be heard by its own microphone before it acts
  as a sender or receiver.
- The UI should not expose mode presets unless measurement data proves that a
  user-selectable mode is necessary.

## Required Invariants

- Binary safe: every byte value from `0x00` to `0xff` must survive transfer.
- Platform neutral: DSP, framing, reliability, and reassembly must be separable
  from browser-specific APIs.
- Versioned: every user-visible build must display a version name, code, and
  protocol number.
- Locally gated: sender and receiver roles must be disabled until the current
  physical device has passed local self-test.
- Measurable: readiness, frame success, retries, and throughput must be derived
  from runtime measurements, not assumptions.
- Recoverable: corrupted frames must be rejected and retransmitted; duplicate
  frames and duplicate ACKs must be safe.

## Layer Model

### 1. Application Layer

Responsibilities:

- Select a file or byte payload.
- Present send, receive, stop, progress, download, and status states.
- Display version identity and protocol identity.
- Gate send and receive on local device readiness.
- Report human-actionable failures, such as "increase speaker volume" or
  "receiver is not listening."

The application layer must not know about Goertzel bins, acoustic symbols, or
frame checksums.

### 2. Session Layer

Responsibilities:

- Create a unique transfer id.
- Manage sender and receiver role state.
- Start and stop microphone/speaker resources.
- Track whether local self-test is valid for this runtime session.
- Own retry policy and timeout policy.

Recommended states:

- `idle`
- `self_testing`
- `ready`
- `sending`
- `receiving`
- `complete`
- `error`
- `stopped`

Readiness should be stored per device runtime, not as a permanent preference.
Passing once should unlock both tone bands on that physical device for the
current page/app session, but a platform may choose to expire readiness after a
time limit, device change, or microphone permission reset.

### 3. Transport Layer

Responsibilities:

- Convert files or byte payloads into application frames.
- Validate frame structure and payload integrity.
- Reassemble received chunks into the original file.
- Provide compact ACK frames for stop-and-wait reliability.
- Remain independent from audio, camera, browser, or native APIs.

Current frame format:

```text
[content_length: uint16 big-endian]
[header_length: uint8]
[header_json: UTF-8 JSON]
[payload: bytes]
```

Current frame types:

- `file-start`: declares transfer id, file name, MIME type, and total frames.
- `file-data`: carries one payload chunk plus frame index and CRC32.
- `ack-start`: acknowledges `file-start`.
- `ack`: acknowledges one `file-data` frame index.
- `probe`: carries a short self-test probe through the normal frame path.

Compact ACK format:

```json
{"t":"s","f":"abcdef"}
{"t":"a","f":"abcdef","i":12}
{"t":"p","f":"abcdef","q":73}
```

Where:

- `t` is compact ACK type: `s` start ACK, `a` data ACK, `p` probe ACK.
- `f` is the first six hex characters of the transfer id with dashes removed.
- `i` is the acknowledged data frame index.
- `q` is an integer quality score from 0 to 100.

Recommended payload size for the current audible modem is 64 bytes. Larger
payloads reduce metadata overhead but increase the probability that one acoustic
error forces retransmission of a long frame.

### 4. Reliability Layer

The baseline reliability model is stop-and-wait ARQ:

1. Sender starts an ACK listener on the ACK channel.
2. Sender sends one frame on the data channel.
3. Receiver validates and processes the frame.
4. Receiver sends a compact ACK on the ACK channel.
5. Sender advances only after the expected ACK arrives.
6. Sender retries after timeout with exponential backoff.

Rules:

- ACK listener must be armed before the sender plays each frame.
- Receiver must mute its data-channel decoder while transmitting ACK audio.
- Receiver must wait through speaker ring-down before unmuting the decoder.
- ACK sending must be queued and deduplicated.
- Duplicate data frames must be re-ACKed safely.
- Missing file metadata must cause data frames to be ignored, not buffered
  indefinitely.

Future extension:

- Add optional forward error correction only after the baseline ARQ protocol is
  deterministic and well tested. FEC should be an additive feature, not a
  replacement for CRC validation.

### 5. Physical Layer: Audible 4-FSK Modem

The initial modem is 4-FSK with two bits per symbol.

Canonical parameters:

```text
symbol_duration_ms: 10
symbols_per_second: 100
bits_per_symbol: 2
raw_bit_rate: 200 bps
raw_byte_rate: 25 bytes/s before framing, ACK, guard, and retry overhead
sync_byte: 0xab
data_channel_k_values: [4, 8, 12, 16]
ack_channel_k_values: [22, 26, 30, 34]
data_channel_hz: about [400, 800, 1200, 1600]
ack_channel_hz: about [2200, 2600, 3000, 3400]
data_preamble_symbols: 40
ack_preamble_symbols: 70
guard_symbols: 12
```

The implementation must compute symbol samples from the runtime sample rate:

```text
symbol_samples = round(sample_rate * symbol_duration_ms / 1000)
tone_hz = k_value * sample_rate / symbol_samples
```

Acoustic packet format:

```text
[preamble symbols]
[sync byte as four 2-bit symbols]
[application frame bytes as four 2-bit symbols per byte]
[xor checksum byte as four 2-bit symbols]
[guard silence]
```

Receiver algorithm:

1. Capture mono PCM samples.
2. Slice into overlapping symbol windows.
3. For each window, compute RMS.
4. Reject silence below threshold.
5. Compute Goertzel energy for the four channel tones.
6. Select the strongest tone only if it exceeds the dominance threshold.
7. Use a preamble detector to lock onto packet start.
8. Decode the sync byte with limited Hamming tolerance.
9. Decode bytes, verify acoustic checksum, then hand the frame to transport.
10. Transport verifies content length, JSON header, and CRC32.

Receiver timing should use a small tracking loop or equivalent alignment
strategy so that slight sender/receiver clock differences do not break the
symbol boundary after preamble lock.

### 6. Local Self-Test

The self-test is a required local loopback check on each physical device.

It must test both tone bands:

- Data band: local speaker emits a data-channel probe; local microphone decodes
  it through the normal data-channel receiver path.
- ACK band: local speaker emits an ACK-channel probe; local microphone decodes
  it through the normal ACK-channel receiver path.

Measured inputs:

- Number of valid tone samples.
- Average RMS level.
- Average tone dominance.
- Successful decode of the probe frame.
- Optional noise floor before playback.
- Optional clipping estimate during playback.

Readiness score:

- Produce a 0 to 100 score per channel.
- Require both data and ACK scores to meet the minimum threshold.
- A decoded probe without enough signal quality should not pass.
- Strong signal quality without a decoded probe should not pass.

Human guidance:

- Weak data band: adjust the device that will send file data.
- Weak ACK band: adjust the device that will send ACKs.
- Low RMS: raise volume or move speaker closer to microphone.
- Low dominance with usable RMS: reduce noise, reduce echo, or adjust
  speaker/microphone alignment.
- Clipping: lower volume.

Cross-device link checking may be added later as diagnostics, but it must not
replace local self-test gating.

### 7. Platform Adapter Interface

Every platform should be able to implement the protocol with these adapters:

```ts
interface AudioOutput {
  sampleRate(): number;
  playMonoPcm(samples: Float32Array, gain: number): Promise<void>;
  close(): void;
}

interface AudioInput {
  sampleRate(): number;
  start(onSamples: (samples: Float32Array) => void): Promise<void>;
  stop(): void;
}

interface PlatformFiles {
  readSlice(offset: number, length: number): Promise<ArrayBuffer>;
  createDownload(name: string, type: string, bytes: BlobPart[]): unknown;
}

interface Clock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}
```

Browser implementations map these to Web Audio, `getUserMedia`, `File`,
`Blob`, object URLs, and timers. Native implementations map them to platform
audio APIs, file handles, and native timers. The modem and transport layers
should not import browser globals directly.

### 8. Diagnostics

Minimum diagnostics:

- Visible app version and protocol.
- Device sample rate.
- Local self-test score for data and ACK channels.
- Sender progress: frame index, retry count, ACK wait state.
- Receiver progress: received frame count, duplicate frames, ACK queue state.
- Transfer result: total bytes, elapsed time, average payload throughput.

Diagnostics should be available to developers without making the primary UI
settings-heavy.

### 9. Security

The acoustic channel is public to anyone nearby with a microphone.

Baseline:

- Do not claim confidentiality.
- Preserve exact bytes.
- Keep transfer local and serverless.

Future optional encryption:

- Add AES-GCM or equivalent authenticated encryption above the transport layer.
- Derive keys from a user-entered passphrase or an out-of-band exchange.
- Include encryption metadata in `file-start`.
- Authenticate metadata that affects reconstruction.
- Keep unencrypted mode available for simple local tests.

### 10. Optical Transport Extension

The same transport layer can support a screen/camera transport later.

Requirements:

- Use on/off or multi-level brightness symbols, not QR-code chunking.
- Include calibration preamble, symbol timing, CRC validation, and redundancy.
- Reuse the same application frame format and reassembly manager.
- Treat camera frame drops as packet loss, not as a fatal stream error.

## Implementation Plan

### Phase 1: Freeze the Portable Contracts

- Publish this spec as the project source of truth.
- Rename remaining "link check" docs and comments to "local self-test" or
  "readiness probe" where behavior is local.
- Add a protocol compatibility section to the README.
- Keep the visible version label and bump the version code for meaningful
  protocol or behavior changes.

Acceptance criteria:

- A new implementer can identify every protocol byte layout and modem parameter
  without reading UI code.
- Project docs do not describe calibration as cross-device link checking.

### Phase 2: Extract a Core Package Boundary

- Move pure protocol code into platform-neutral modules:
  - `core/framing`
  - `core/reassembly`
  - `core/modem`
  - `core/reliability`
  - `core/self-test`
- Keep browser-specific code in adapters:
  - `platform/browser/audio-input`
  - `platform/browser/audio-output`
  - `platform/browser/files`
  - `platform/browser/ui`
- Replace direct browser globals inside core code with adapter interfaces.

Acceptance criteria:

- Core modem loopback, framing, reassembly, and sender reliability tests run in
  Node without DOM or Web Audio.
- Browser code is only one implementation of the platform interfaces.

### Phase 3: Make Deterministic Test Vectors

- Generate golden application frames for:
  - empty file
  - one small text file
  - binary bytes from `0x00` to `0xff`
  - multi-frame payload
  - compact ACK and probe frames
- Generate golden PCM fixtures for data and ACK channels at 44.1 kHz and 48 kHz.
- Add recorded or synthesized noisy fixtures:
  - low volume
  - white noise
  - timing offset
  - leading/trailing silence
  - clipped signal
  - duplicate frames

Acceptance criteria:

- Protocol changes fail tests unless fixtures are intentionally regenerated.
- Decoder behavior is regression tested without real speakers or microphones.

### Phase 4: Harden Local Self-Test

- Require both quality score and successful probe decode.
- Measure pre-playback noise floor.
- Detect clipping.
- Report separate data-band and ACK-band guidance.
- Store readiness with timestamp, sample rate, and audio device identity when
  available.
- Expire readiness after device changes or after a configurable time window.

Acceptance criteria:

- Send and receive controls stay disabled until local self-test passes.
- Self-test failures explain the likely physical adjustment.
- Tests cover pass, weak RMS, weak dominance, no decode, and clipping cases.

### Phase 5: Improve Runtime Reliability

- Expose retry counters and measured throughput in status text or diagnostics.
- Track duplicate frames and duplicate ACKs.
- Re-ACK duplicate valid frames.
- Add sender cancellation.
- Add receiver stop control if missing on a target platform.
- Add bounded handshake retry messaging so "receiver not listening" is clear.

Acceptance criteria:

- A failed transfer tells the user whether the issue is readiness, missing
  receiver, no ACK, repeated corruption, or user cancellation.
- Long-running receive sessions can always be stopped cleanly.

### Phase 6: Prepare Cross-Platform Ports

- Build a command-line loopback harness that reads bytes, emits PCM WAV, decodes
  PCM WAV, and verifies output bytes.
- Build a native/mobile proof-of-concept using the same core modules or a direct
  translation of the core contracts.
- Document platform-specific audio requirements:
  - mono capture
  - disabled echo cancellation/noise suppression/automatic gain where possible
  - known sample rate
  - low-latency callback or buffered PCM access

Acceptance criteria:

- A non-browser implementation can pass the same golden frame and PCM fixtures.
- Browser and non-browser implementations interoperate over recorded PCM.

### Phase 7: Optional Features After Baseline Stability

- Authenticated encryption.
- FEC for one-way or lossy transfers.
- Adaptive thresholds based on measured noise floor.
- Optical screen/camera transport.
- Import/export of diagnostic logs.

These should be added only after the baseline protocol is locked and fixture
coverage is strong.

## Realistic Performance Target

The current audible modem is intentionally slow. With 10 ms symbols and two
bits per symbol, the raw rate is about 25 bytes/s. Application throughput is
lower because every frame includes preamble, sync, headers, checksum, guard
silence, ACK turnaround, and retry overhead.

Useful target:

- Small text or config files: realistic.
- Small images or binary blobs: possible but slow.
- Large media files: not a good default use case.

The project should optimize reliability and correctness first. Higher bitrate
modes should be introduced only as additional measured profiles after the
baseline protocol is demonstrably stable.

## Definition of Solid

This project is solid when:

- The protocol is documented independently from the browser UI.
- The core algorithms run in automated tests without hardware.
- Golden test vectors protect frame layout and modem behavior.
- Each device proves local speaker-to-mic readiness before transfer.
- Runtime diagnostics explain failures in physical terms.
- Browser code is an adapter, not the definition of the protocol.
- A second implementation can be built from this spec and interoperate with the
  first through the same frame and audio contracts.
