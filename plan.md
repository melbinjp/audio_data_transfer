Nice — this is a great, ambitious experiment. I’ll give you a complete, practical, implementation-ready plan that maximizes versatility, robustness, and future-proofing while staying fully client-side (browser only). I’ve highlighted concrete constraints you’ll hit in browsers and with real hardware, and given choices (with tradeoffs) so you can pick the right path for whatever you eventually want this to become.

# High-level summary

Build a browser app that: (1) lets one device **encode** arbitrary data (files, blobs, JSON) into audio, (2) plays that audio through the speaker, (3) another device captures the audio with its mic and **decodes** it back into the original data, and (4) shows live transfer speed, progress, and diagnostics. Use modular DSP + transport + FEC + crypto layers, implement core DSP in WASM for performance, and rely on the Web Audio API + getUserMedia for capture/playback. Use existing battle-tested audio-modem libraries where possible (e.g., Quiet.js) to avoid reinventing core modem work. ([MDN Web Docs][1], [GitHub][2])

---

# Goals & constraints (must-know)

* **Client-side only**: everything runs in the browser; no servers required for data transfer.
* **No limit on data type**: binary-safe transport (send arbitrary bytes).
* **Robust in noisy environments**: design profiles for “quiet room”, “noisy room”, and “near-field / cable” (fallback).
* **Show real-time throughput & diagnostics**: bytes/sec, BER estimates, SNR estimate, chunk retransmissions.
* **Cross-device compatibility**: desktops, Android, iOS (note: mobile Safari has special rules).
* **Health & hardware caution**: ultrasound (>20 kHz) is risky/inconsistent; many phones/speakers/mics vary in frequency response — test and provide audible fallback. ([MDN Web Docs][3], [Quiet Project][4])

---

# Big picture architecture

1. **UI layer**

   * Sender: file picker, compression toggle, optional password, transmit button, transmit profile selector, power/volume guidance, real-time spectrogram, bytes/s, ETA.
   * Receiver: request mic permission, “Receive” button, live spectrogram, transfer progress, decoded file download.
2. **Transport layer** (framing + reliability)

   * Chunk data into frames (e.g., 1–8 KB payload per frame) with sequence numbers, length, CRC, and optional AES-GCM tag.
   * Frame-level ACKs or use FEC/fountain codes (see below) for headless transfers.
3. **Modem (PHY) layer — DSP modem**

   * Choose modulation profiles (robust low bitrate, higher bitrate, near-ultrasonic or audible). Implement these as selectable "profiles". Use AudioWorklet for low latency, generate Float32 buffers to play. Capture via MediaStream → AudioContext → AudioWorklet for decoding. Use WASM for FFT, FEC, heavy DSP. ([MDN Web Docs][1])
4. **Error control**

   * CRC for frames + FEC (Reed-Solomon or Raptor/LT) depending on expected packet loss. Provide retransmit option if ACK channel exists.
5. **Security**

   * Optional AES-GCM per session with a short passphrase exchanged visually (QR or short audible handshake) or via user confirmation.
6. **Diagnostics & adaptation**

   * Send preamble for SNR/impulse response estimation, adapt modulation and bitrate accordingly. Show SNR / BER estimates in UI.

---

# Recommended modem/profile options & tradeoffs

(implement multiple; pick automatically after calibration)

1. **Robust audible profile (recommended default)**

   * Frequency band: 2–8 kHz. Good balance between speaker/mic response and audibility. Lower risk of failure.
   * Modulation: PSK/GMSK or robust multi-tone OFDM with low symbol rate.
   * Throughput: tens to a few hundred bits/s to a few kb/s depending on environment and frame size.
   * When to use: noisy room, long distance.

2. **High-throughput cable/near-field profile**

   * Use 3.5 mm analog loopback or very close speaker→mic alignment, sample rates permitting. Can hit tens of kb/s (Quiet/libquiet notes \~40 kb/s on cable profiles). Use only when testing via direct contact or near-line-of-sight and low noise. ([GitHub][2])

3. **Near-ultrasonic profile (experimental)**

   * Center \~16–19 kHz (some phones have energy here). Avoid >20 kHz for reliability and health. Ultrasonic is device-dependent and will fail on many speakers/mics. Use only as an *optional* profile and show explicit warnings. ([Quiet Project][4])

**Why multiple profiles:** speaker/mic frequency response and sample rates vary across devices; having profiles lets you adapt without breaking UX.

---

# Concrete transmission pipeline (sender)

1. **User picks file** → compress (optional) → chunk into frames.
2. **Encrypt** (optional) using AES-GCM with a session key derived from passphrase (PBKDF2/Scrypt). Include key id in preamble.
3. **Add frame metadata**: seq, total frames, length, CRC32/CRC16.
4. **Interleave / FEC**: apply Reed-Solomon or LT fountain code across frames (configurable).
5. **Add preamble/pilot**: known chirp/pilot sequence for sync & channel estimation.
6. **Modulate frames** into audio symbols per chosen profile (use time domain waveforms or OFDM symbols). Schedule via AudioContext (AudioWorklet). Use small guard intervals and pre-emphasis if needed. Use `AudioContext.currentTime` for play scheduling. ([MDN Web Docs][5])

# Concrete receive pipeline (receiver)

1. **Permission**: ask for mic permission via `navigator.mediaDevices.getUserMedia({audio:true})`. Must request user permission. ([MDN Web Docs][6])
2. **Capture**: MediaStream → AudioContext → AudioWorkletProcessor for low-latency buffer access.
3. **Preprocessing**: AGC (automatic gain control), bandpass filter per profile, resample if needed (AudioContext sample rate is device dependent; account for it). ([MDN Web Docs][3])
4. **Sync**: detect preamble using matched filter or cross-correlation; find symbol timing and coarse frequency offset.
5. **Demodulate**: FFT/phase tracking depending on scheme, extract symbols.
6. **FEC/Frame reassembly**: check CRCs, apply FEC (RS/Raptor) and reconstruct original data.
7. **Decrypt** (if used), reconstruct file blob, present for download.

---

# Key browser & hardware gotchas (and how to handle them)

* **AudioContext sampleRate is device-determined** and not changeable. Don’t assume 48kHz; read `audioCtx.sampleRate`. Design DSP to handle variable sample rates or resample in software. ([MDN Web Docs][3])
* **getUserMedia requires explicit permission** and may be blocked in background tabs or if not served over HTTPS (must be secure context). Always handle permission rejections elegantly. ([MDN Web Docs][6])
* **Autoplay / background capture**: playback usually allowed, but some browsers (esp. iOS Safari) have stricter policies; test iOS specifically and guide users to interact (tap) before transmit.
* **Device frequency response varies** — ultrasonic often fails. Provide audible fallback and calibration routine. ([Quiet Project][4])
* **Cross-device differences**: Android, iOS, desktop have different mic latency and sample rates — implement adaptive calibration and multiple test profiles.
* **Existing SDKs/licensing**: Chirp was widely used but its SDK availability changed after acquisition; use open projects (Quiet/libquiet / quiet-js) to avoid closed SDK issues. ([Wikipedia][7], [Quiet Project][4])

---

# Reliability & error control (recommended)

* **Per-frame CRC** (16 or 32 bits).
* **Forward Error Correction**: Reed-Solomon for small numbers of lost bytes; use fountain codes (LT/Raptor) for large files and receiver dropouts/no ACKs. FEC in combination with small frame sizes will raise success rate.
* **ACK strategy**: If both devices can emit audio → implement a short ACK channel (tiny packets) to accept/reject frames and request retransmit. If ACK not feasible, rely on FEC.
* **Retransmit window**: If you implement ACKs, use sequence windows and exponential backoff for retries.
* **Adaptive bitrate**: measure SNR from preamble and pick profile (lower bitrates in high noise).

---

# Security & privacy

* **Encryption**: AES-GCM with per-session key (derived from passphrase or exchanged via visual QR). Audio channel is insecure — anyone nearby can record it. Make users aware.
* **No server needed**: but if you ever add server features (for QR generation or fallback), document the privacy implications.
* **Opt-in permissions**: list microphone access clearly; log nothing without consent.

---

# UX / UI features (practical list)

* Start screen: “Send” and “Receive” big buttons.
* **Calibration wizard**: play a chirp, measure mic levels, guide user to optimal speaker volume & distance.
* Live **spectrogram** and waveform while transmitting/receiving (helps debugging).
* **Profile selector** + “Auto” mode that runs short preamble and picks best profile.
* **Progress bar & throughput** (bytes/sec measured from decode timestamps). Show both instantaneous and average.
* **Diagnostics panel**: SNR, packet loss %, BER estimate, device sample rate, chosen modulation params.
* **Fallback**: if audio fails, show QR generation of data chunk or provide “save as file for manual transfer”.
* **Accessibility**: alternative textual instructions, big buttons, volume guidance.

---

# Testing plan (must do across many devices)

* **Controlled lab tests**: desktop-to-desktop in quiet, laptop speakers -> phone mic, phone→phone at different distances, outdoors, cafe noise, recorded background noise overlays.
* **Metrics to record**: throughput (bytes/sec), transfer success rate, average SNR, BER, CPU usage, energy impact on phones.
* **Edge tests**: phones in pockets, speakers at low volume, multi-source interference (multiple simultaneous transmissions).
* **Regression harness**: use recorded WAV test files to run repeated decoding tests offline (deterministic).

---

# Libraries & tools to reuse

* **Quiet / quiet-js** — proven audio modem with JS bindings (good for prototyping and has ultrasonic & cable profiles). ([GitHub][2], [Quiet Project][4])
* **Web Audio API** (AudioContext, AudioWorklet) for generation & capture. ([MDN Web Docs][1])
* **libFEC / Reed-Solomon** implementations (WASM ports) for FEC.
* **WASM FFT** implementations (for speed in demodulation).
* Use `navigator.mediaDevices.getUserMedia` for microphone permission & capture. ([MDN Web Docs][6])

---

# Minimal viable product (MVP) roadmap (concrete steps)

**MVP (week 1–3)**

1. Small demo: transfer a short text string between two desktops using a simple FSK tone pair (very robust). Show progress & decoded text.
2. Replace FSK with a multi-tone/OFDM prototype using an existing lib (Quiet.js) to handle encoding/decoding. Add file chunking & CRC.
3. Add UI for file pick + download of received file, show bytes/sec. Test cross-browser basic flows.

**v1 (after MVP)**
4\. Add FEC (Reed-Solomon), AES-GCM encryption with passphrase, and a calibration wizard.
5\. Add multiple profiles (audible / ultrasonic / cable) + auto profile selection.
6\. Extensive cross-device testing and UX polish.

**v2 / advanced**
7\. Add ACK channel & retransmit, adaptive modulation, multi-device broadcast, and a developer API (WASM module + JS bindings).
8\. Provide mobile PWA packaging and native wrappers if desired.

---

# Example folder / module layout (frontend)

```
/src
  /ui
    App.jsx
    SenderPanel.jsx
    ReceiverPanel.jsx
    Spectrogram.jsx
  /dsp
    modem-wasm.wasm
    modem-wrapper.js   // JS glue to WASM modem encode/decode
    audioWorklet/      // AudioWorklet processors for capture and playback
  /transport
    framing.js
    fec.js
    encryption.js
  /utils
    calibration.js
    diagnostics.js
  index.html
  styles.css
```

---

# Quick prototyping tips & code pointers

* Use **AudioWorklet** for capture/playback buffer access (lower latency vs ScriptProcessor). ([MDN Web Docs][5])
* Use `audioCtx.sampleRate` to adapt symbol timing. ([MDN Web Docs][3])
* For initial prototype, implement **simple FSK** or use quiet-js to validate the whole pipeline quickly. Quiet-js has examples and already handles a lot of edge cases. ([GitHub][2])

---

# Safety, ethics & legal notes

* Warn users that audio transmissions are **eavesdroppable** by anyone nearby; for sensitive data, use strong encryption and short physical proximity exchange of passphrase.
* Ultrasonic and very loud tones can cause discomfort to humans/animals and may damage some speakers — add warnings and volume limits.

---

# Key references (most load-bearing claims)

* Web Audio API / AudioContext / scheduling and nodes. ([MDN Web Docs][1])
* getUserMedia permission requirements and usage for mic capture. ([MDN Web Docs][6])
* Quiet.js / libquiet: JavaScript bindings that demonstrate practical modem profiles (including near-ultrasonic and cable modes). ([Quiet Project][4], [GitHub][2])
* Chirp history (example of a commercial data-over-sound SDK and acquisition) — shows both interest and licensing pitfalls. ([Wikipedia][7], [Medium][8])

---

# Final recommendations (practical)

1. **Start by prototyping with Quiet.js** (or port its approach) to avoid spending months on low-level DSP. ([GitHub][2])
2. **Make calibration & auto-profile selection first class** — it’s the most important UX problem you’ll face.
3. **Use WASM** for heavy DSP (FFT / FEC) for consistent performance.
4. **Provide multiple transport strategies**: FEC or ACK/retransmit depending on whether two-way audio is available.
5. **Log metrics** and gather device fingerprints (sample rate, speaker model if possible) to build better heuristics over time.

---

If you want, I can now do any of these concrete next steps (pick one and I’ll implement it in this answer right away — no waiting):

* a) provide a minimal working **JS prototype** that sends and receives a short text string using FSK + Web Audio (sender + receiver code you can paste into two browser tabs), or
* b) produce a **detailed spec** (data frames, exact bit layout, CRC/FEC parameters, modulation parameters, exact audio preamble waveform) you can hand to a developer, or
* c) give a **test plan + CI harness** (how to produce WAV test vectors and automated decoding tests).

Which do you want first?

[1]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API?utm_source=chatgpt.com "Web Audio API - MDN - Mozilla"
[2]: https://github.com/quiet/quiet-js?utm_source=chatgpt.com "Quiet.js - Transmit data with sound using Web Audio"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/sampleRate?utm_source=chatgpt.com "BaseAudioContext: sampleRate property - MDN - Mozilla"
[4]: https://quiet.github.io/quiet-js/?utm_source=chatgpt.com "Quiet.js by quiet - Quiet Project"
[5]: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext?utm_source=chatgpt.com "AudioContext - MDN - Mozilla"
[6]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia?utm_source=chatgpt.com "MediaDevices: getUserMedia() method - MDN - Mozilla"
[7]: https://en.wikipedia.org/wiki/Chirp_%28company%29?utm_source=chatgpt.com "Chirp (company) - Wikipedia"
[8]: https://medium.com/chirp-io/a-fond-farewell-1792908af778?utm_source=chatgpt.com "A fond farewell - Chirp - Medium"
