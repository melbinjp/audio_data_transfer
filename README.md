# Data Over Audio

An experimental browser application that transfers arbitrary files through audible 4-FSK audio. One browser tab or device plays encoded frames through its speaker; another listens through its microphone, acknowledges valid frames, reassembles the file, and offers it for download.

The transfer path uses sound instead of Wi-Fi, Bluetooth, or a local network. The web app still needs to be loaded in a browser, and the result is intentionally much slower than a normal file-transfer tool.

**Live demo:** [audiosen.wecanuseai.com](https://audiosen.wecanuseai.com)

**Current build:** Mango Modem 1.3.1 (`2026062501`, protocol `4`)

## What is implemented

- File selection and acoustic transmission from the sender panel.
- Microphone-based receiving with a live frequency display.
- Binary-safe framing with CRC32 payload validation.
- Stop-and-wait acknowledgements on a separate acoustic ACK channel.
- Retries with exponential backoff when ACKs are not received.
- Visible application and protocol identity in the UI.
- Local speaker-to-microphone self-test before transfer.
- Headless tests for framing, reassembly, receiver behavior, modem loopback, and simulated end-to-end transfer.

## How to use it

1. Open the [live demo](https://audiosen.wecanuseai.com), or run the app locally.
2. Open two browser tabs or use two physical devices.
3. Start receiving on the receiver first.
4. Run **Test This Device** on each device and adjust volume, distance, or alignment if the test is weak.
5. Select a file on the sender and start the transfer.

Keep the devices close, use moderate volume, and start with a small file. This is a research and learning experiment, not a replacement for Wi-Fi, Bluetooth, USB, or LAN file sharing.

## Run locally

Requirements:

- Node.js 20.19+ or 22.12+
- A modern browser with Web Audio API, AudioWorklet, and microphone support
- `localhost` or HTTPS for microphone access

```sh
npm install
npm run dev
```

Then open the Vite URL in two tabs or on two devices.

## Checks

```sh
npm run typecheck
npm test -- --run
npm run build
npm audit --audit-level=moderate
```

## Project layout

```text
src/dsp/          4-FSK modem, channels, and AudioWorklet receiver
src/transport/    framing, CRC validation, ACKs, and file reassembly
src/ui/           sender, receiver, self-test, and spectrogram wiring
docs/             protocol specification, technical plan, and task status
```

## Roadmap

An optical screen-to-camera transport is described as a planned extension in [`docs/PLATFORM_SPEC.md`](docs/PLATFORM_SPEC.md). It is not implemented in the current build.

## License

ISC. See [`LICENSE.md`](LICENSE.md).
