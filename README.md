# Data Over Audio

A browser-based file transfer experiment that sends arbitrary files through audible 4-FSK audio. One browser tab or device plays encoded frames through its speaker, and another listens through its microphone, acknowledges received frames, reassembles the file, and offers it for download.

## What Works

- File selection and acoustic transmission from the sender panel.
- Microphone-based receiving with a live frequency display.
- Binary-safe frame format with CRC32 payload validation.
- Stop-and-wait acknowledgements over a separate high-frequency ACK channel.
- Retries with exponential backoff when ACKs are not received.
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

For best results, keep devices close together, use moderate speaker volume, and test with a small file first. Audio transfer is slow by design because the default profile prioritizes reliability over speed.

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
