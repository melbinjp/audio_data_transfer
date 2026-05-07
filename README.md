# Data Over Audio

A browser-based file transfer experiment that sends arbitrary files through audible 4-FSK audio. One browser tab or device plays encoded frames through its speaker, and another listens through its microphone, acknowledges received frames, reassembles the file, and offers it for download.

Current live-identification version: **Mango Modem 1.3.0** (`2026050706`, protocol `3`).

## What Works

- File selection and acoustic transmission from the sender panel.
- Microphone-based receiving with a live frequency display.
- Binary-safe frame format with CRC32 payload validation.
- Stop-and-wait acknowledgements over a separate high-frequency ACK channel.
- Retries with exponential backoff when ACKs are not received.
- Visible version code/name on the page so the live build can be identified.
- Single acoustic setup path tuned for phone/laptop speaker and microphone transfer.
- ACK listener is armed before each send, and receiver ACKs are repeated after a turnaround delay.
- Acoustic calibration independently scores sender-to-receiver and receiver-to-sender audio before file transfer.
- Headless tests for framing, reassembly, receiver UI behavior, and modem loopback.

## Requirements

- Node.js 20.19 or newer, or Node.js 22.12 or newer.
- A modern browser with Web Audio API, AudioWorklet, and microphone support.
- `localhost` or HTTPS. Browser microphone access is blocked on ordinary insecure origins.

## Run Locally

```sh
npm install
npm run dev
```

Open the local Vite URL in two tabs or on two devices. Click **Start Receiving** on the receiver first, then choose a file and click **Send File** on the sender.

For best results, keep devices close together, use moderate speaker volume, and test with a small file first. Audio transfer is slow by design because the setup prioritizes reliability over speed.

Start listening on the receiver, then run **Calibrate Link** on the sender. The sender reports two scores: outgoing sound heard by the receiver, and return sound heard by the sender. If either score is weak, adjust volume, distance, and speaker/mic alignment on the relevant device, then calibrate again.

## Optical Flash Direction

The planned screen/camera mode should use high-contrast light pulses, not QR codes. The protocol should be an on/off keyed optical transport with Manchester timing, a calibration preamble, CRC checks, and fountain-style redundancy so the receiver can recover even if camera frames are dropped. The same framing and reassembly layer can be reused once the optical symbol decoder is added.

## Checks

```sh
npm run typecheck
npm test -- --run
npm run build
npm audit --audit-level=moderate
```

## Project Layout

- `src/dsp`: 4-FSK modem, AudioWorklet receiver, channel constants.
- `src/transport`: framing, compact ACKs, CRC validation, file reassembly.
- `src/ui`: sender/receiver UI wiring and spectrogram rendering.
- `public`: quiet.js assets kept for experimentation and deployment compatibility.
- `TECHNICAL_PLAN.md`: original architecture plan and future roadmap.
