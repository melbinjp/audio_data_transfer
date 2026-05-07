# Project Status

The MVP is implemented as a client-side Vite app.

## Completed

- ISC license added.
- Browser sender and receiver UI added.
- 4-FSK modem implemented with Web Audio playback and AudioWorklet microphone decoding.
- Binary frame format added with CRC32 validation.
- File chunking and reassembly implemented.
- Compact ACK channel added for retransmission support.
- Tests added for framing, modem loopback, and receiver UI behavior.
- Build now runs strict TypeScript checking before bundling.

## Useful Next Improvements

- Add a visible stop control for long-running receive sessions.
- Add measured throughput and retry counters to the UI.
- Add a calibration mode for speaker volume and microphone level.
- Add recorded WAV fixtures for deterministic decoder regression tests.
- Add optional encryption for sensitive transfers.
