/**
 * From-scratch 4-FSK audio modem.
 *
 * Exports the same public interface as the replaced quiet-modem.ts
 * (primeAudio, TransmitterSession, startListening) so no changes are needed
 * in calling UI code other than updating the import path.
 *
 * ── Architecture ────────────────────────────────────────────────────────────
 *
 *   TX  Pre-computes the entire acoustic frame as raw PCM on the main thread,
 *       then hands it to an AudioBufferSourceNode for playback.  No DSP runs
 *       on the main thread during playback; the audio rendering thread handles
 *       it entirely.
 *
 *   RX  An AudioWorklet processor (loaded via Blob URL — works in Vite without
 *       any special plugin) runs on the audio rendering thread.  It accumulates
 *       mic samples into fixed-length symbol windows and applies the Goertzel
 *       algorithm for each of the four FSK tones, posting symbol-index events
 *       to the main thread.  A lightweight state machine on the main thread
 *       converts symbols → bytes → complete application frames.
 *
 * ── Acoustic frame wire format ───────────────────────────────────────────────
 *
 *   [PREAMBLE_SYMBOLS × preamble-tone symbols]
 *   [4 symbols  encoding SYNC_BYTE]
 *   [4 × N symbols  encoding N bytes of the application frame]
 *   [4 symbols  encoding XOR checksum of the N data bytes]
 *   [GUARD_SYMBOLS × silent symbols]
 *
 * ── Error detection layers ───────────────────────────────────────────────────
 *
 *   1. Goertzel dominance check  — per-symbol noise gate
 *   2. Acoustic-layer XOR checksum  — fast fail-fast for corrupted symbols
 *   3. Application-layer CRC32  — in framing.ts, catches any remaining errors
 */

import {
    SYMBOL_DURATION_MS,
    K_VALUES,
    PREAMBLE_TONE,
    PREAMBLE_SYMBOLS,
    PREAMBLE_MIN_SYMBOLS,
    SYNC_BYTE,
    GUARD_SYMBOLS,
    SILENCE_THRESHOLD,
    TONE_DOMINANCE_RATIO,
} from './modem-config';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the symbol length (in samples) for a given AudioContext sample rate. */
function getSymbolSamples(sampleRate: number): number {
    return Math.round((SYMBOL_DURATION_MS * sampleRate) / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// TX helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesise one FSK symbol as a Float32Array of sine-wave samples.
 * For tone index i, k = K_VALUES[i]; the tone frequency is
 *   freq = k × sampleRate / symbolSamples  Hz.
 * Because k is an integer and symbolSamples = round(SYMBOL_DURATION_MS × sr),
 * exactly k full cycles fit in the window, eliminating spectral leakage.
 */
function synthesiseTone(
    toneIndex: number,
    symbolSamples: number,
    sampleRate: number,
): Float32Array {
    const k = K_VALUES[toneIndex];
    const freq = (k * sampleRate) / symbolSamples;
    const out = new Float32Array(symbolSamples);
    const twoPiFreqOverSr = (2 * Math.PI * freq) / sampleRate;
    for (let i = 0; i < symbolSamples; i++) {
        out[i] = Math.sin(twoPiFreqOverSr * i);
    }
    return out;
}

/** Encode one byte as four 4-FSK symbol indices (MSB-first, 2 bits each). */
function byteToSymbols(b: number): [number, number, number, number] {
    return [(b >> 6) & 0x3, (b >> 4) & 0x3, (b >> 2) & 0x3, b & 0x3];
}

/**
 * Encode a complete application-layer frame (ArrayBuffer) into a Float32Array
 * of PCM audio samples ready for AudioBufferSourceNode playback.
 */
function encodeFrameToAudio(
    frame: ArrayBuffer,
    symbolSamples: number,
    sampleRate: number,
): Float32Array {
    const data = new Uint8Array(frame);

    // Pre-synthesise all four tone waveforms once to avoid redundant computation.
    const tones = K_VALUES.map((_, i) => synthesiseTone(i, symbolSamples, sampleRate));

    // XOR checksum over every data byte (acoustic-layer error detection).
    let checksum = 0;
    for (const b of data) checksum ^= b;

    // Total audio size (GUARD_SYMBOLS tail is zero-filled by Float32Array init).
    const totalSymbols = PREAMBLE_SYMBOLS + 4 + data.length * 4 + 4 + GUARD_SYMBOLS;
    const pcm = new Float32Array(totalSymbols * symbolSamples);
    let writePos = 0;

    const writeTone = (toneIndex: number) => {
        pcm.set(tones[toneIndex], writePos);
        writePos += symbolSamples;
    };

    // 1. Preamble
    for (let i = 0; i < PREAMBLE_SYMBOLS; i++) writeTone(PREAMBLE_TONE);

    // 2. Sync byte
    for (const s of byteToSymbols(SYNC_BYTE)) writeTone(s);

    // 3. Data bytes (each byte → 4 symbols)
    for (const b of data) {
        for (const s of byteToSymbols(b)) writeTone(s);
    }

    // 4. Acoustic checksum byte
    for (const s of byteToSymbols(checksum)) writeTone(s);

    // 5. Guard silence — already zero-initialised; writePos not advanced further.

    return pcm;
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioWorklet RX processor (inlined as a Blob URL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the JavaScript source code for the AudioWorklet RX processor.
 *
 * The processor runs on the audio rendering thread and is loaded via a Blob URL
 * so that it works in Vite (dev and production) without any special plugin.
 *
 * Processor parameters are received through `processorOptions` at
 * AudioWorkletNode construction time:
 *   symbolSamples    — number of samples per FSK symbol
 *   kValues          — array of four Goertzel k-values
 *   silenceThreshold — RMS threshold below which a symbol is treated as silence
 *
 * For each complete symbol window the processor posts a message:
 *   { type: 'symbol', toneIndex: -1|0|1|2|3, rms: number, dominance: number }
 * where toneIndex === -1 means silence.
 */
function getRxProcessorSource(): string {
    // Written as plain ES5-compatible JavaScript so it is valid in all browsers'
    // AudioWorkletGlobalScope (which does not support TypeScript or npm imports).
    return `
class FskRxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = (options && options.processorOptions) || {};
    this._N    = opts.symbolSamples    || 240;
    this._kv   = opts.kValues          || [2, 4, 6, 8];
    this._silT = opts.silenceThreshold || 0.005;
    this._buf  = new Float32Array(0);
    this._run  = true;
    var self = this;
    this.port.onmessage = function(e) { if (e.data === 'stop') self._run = false; };
  }

  /**
   * Goertzel algorithm: efficiently computes energy at frequency
   * f = k * sampleRate / N  without a full FFT.
   * Returns a power estimate (arbitrary units, proportional to amplitude²).
   */
  _goertzel(buf, k) {
    var N = buf.length;
    var coeff = 2.0 * Math.cos((2.0 * Math.PI * k) / N);
    var q1 = 0.0, q2 = 0.0;
    for (var i = 0; i < N; i++) {
      var q0 = buf[i] + coeff * q1 - q2;
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
  }

  process(inputs) {
    if (!this._run) return false;
    var ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    /* Append new samples to accumulation buffer. */
    var merged = new Float32Array(this._buf.length + ch.length);
    merged.set(this._buf);
    merged.set(ch, this._buf.length);
    this._buf = merged;

    /* Process complete symbol windows. */
    while (this._buf.length >= this._N) {
      var sym = this._buf.subarray(0, this._N);

      /* RMS — silence gate. */
      var sumSq = 0.0;
      for (var i = 0; i < sym.length; i++) sumSq += sym[i] * sym[i];
      var rms = Math.sqrt(sumSq / sym.length);

      if (rms < this._silT) {
        this.port.postMessage({ type: 'symbol', toneIndex: -1, rms: rms, dominance: 0 });
      } else {
        /* Goertzel energy for each of the four tones. */
        var energies = [];
        for (var j = 0; j < this._kv.length; j++) {
          energies.push(this._goertzel(sym, this._kv[j]));
        }
        var total = 0.0;
        for (var j = 0; j < energies.length; j++) total += energies[j];
        var maxE = -1.0, best = 0;
        for (var j = 0; j < energies.length; j++) {
          if (energies[j] > maxE) { maxE = energies[j]; best = j; }
        }
        var dom = total > 0.0 ? maxE / total : 0.0;
        this.port.postMessage({ type: 'symbol', toneIndex: best, rms: rms, dominance: dom });
      }

      /* Advance buffer by one symbol. */
      this._buf = this._buf.slice(this._N);
    }

    return true;
  }
}

registerProcessor('fsk-rx-processor', FskRxProcessor);
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// primeAudio
// ─────────────────────────────────────────────────────────────────────────────

const PRIME_CTX_CLOSE_MS = 500;

/**
 * Unlocks the Web Audio API inside a synchronous user-gesture handler.
 *
 * Chrome's autoplay policy suspends AudioContexts created outside a
 * synchronous user-gesture frame.  Calling this function at the very top of a
 * click/keydown handler (before any `await`) ensures that all subsequent
 * AudioContext.resume() calls in the same document succeed.
 */
export function primeAudio(): void {
    try {
        const ctx = new AudioContext();
        ctx.resume().catch(() => {});
        setTimeout(() => ctx.close().catch(() => {}), PRIME_CTX_CLOSE_MS);
    } catch (e) {
        console.warn('primeAudio: could not create AudioContext:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TransmitterSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages a single file-transfer TX session.
 *
 * One AudioContext is created for the entire transfer.  Each `send()` call
 * pre-computes the acoustic frame as raw PCM on the main thread and plays it
 * via an AudioBufferSourceNode, resolving when the `ended` event fires.
 * No DSP runs on the main thread during playback.
 */
export class TransmitterSession {
    private ctx: AudioContext | null = null;
    private isDestroyed = false;

    /** Initialises the AudioContext.  Must be called once before any send(). */
    async init(): Promise<void> {
        try {
            this.ctx = new AudioContext();
            await this.ctx.resume();
        } catch (err) {
            this.ctx = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `TransmitterSession: failed to create or resume AudioContext — ${msg}. ` +
                'Ensure primeAudio() was called synchronously in the click handler.',
            );
        }
    }

    /**
     * Encodes `data` as a 4-FSK acoustic frame and plays it to the speaker.
     * Resolves when playback is complete.  Calls must be awaited sequentially.
     */
    send(data: ArrayBuffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.isDestroyed || !this.ctx) {
                reject(new Error('TransmitterSession has been destroyed or not initialised'));
                return;
            }
            const ctx = this.ctx;
            const symbolSamples = getSymbolSamples(ctx.sampleRate);

            let pcm: Float32Array;
            try {
                pcm = encodeFrameToAudio(data, symbolSamples, ctx.sampleRate);
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }

            const audioBuf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
            audioBuf.copyToChannel(pcm, 0);

            const src = ctx.createBufferSource();
            src.buffer = audioBuf;
            src.connect(ctx.destination);
            src.onended = () => resolve();
            src.start();
        });
    }

    /** Releases the AudioContext.  Safe to call multiple times. */
    destroy(): void {
        if (!this.isDestroyed) {
            this.isDestroyed = true;
            this.ctx?.close().catch(() => {});
            this.ctx = null;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// startListening
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts listening for 4-FSK data via the microphone.
 *
 * Returns:
 *   analyser  AnalyserNode connected to the mic stream (for spectrogram UI).
 *   stop      Call to tear down the AudioWorklet, release the microphone, and
 *             close the AudioContext.
 *
 * @param onData  Invoked with each complete, checksum-verified application frame.
 */
export async function startListening(
    onData: (data: ArrayBuffer) => void,
): Promise<{ analyser: AnalyserNode; stop: () => void }> {
    const ctx = new AudioContext();
    await ctx.resume();

    if (!ctx.audioWorklet) {
        ctx.close().catch(() => {});
        throw new Error(
            'AudioWorklet is not supported in this browser. ' +
            'Please use Chrome 66+, Firefox 76+, or Safari 14.1+.',
        );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
    }).catch(
        (err: unknown) => {
            ctx.close().catch(() => {});
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `startListening: microphone access failed — ${msg}. ` +
                'Check browser permissions and ensure a microphone is connected.',
            );
        },
    );
    const source = ctx.createMediaStreamSource(stream);

    // AnalyserNode for spectrogram visualisation (connected to the raw mic stream).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Load the RX processor via a Blob URL — compatible with Vite dev and
    // production builds without any special plugin configuration.
    const processorBlob = new Blob([getRxProcessorSource()], { type: 'application/javascript' });
    const processorUrl = URL.createObjectURL(processorBlob);
    await ctx.audioWorklet.addModule(processorUrl);
    URL.revokeObjectURL(processorUrl);

    const symbolSamples = getSymbolSamples(ctx.sampleRate);
    const rxNode = new AudioWorkletNode(ctx, 'fsk-rx-processor', {
        processorOptions: {
            symbolSamples,
            kValues: Array.from(K_VALUES),
            silenceThreshold: SILENCE_THRESHOLD,
        },
    });
    // Connect source → worklet but NOT worklet → destination (avoid mic loopback).
    source.connect(rxNode);

    // ── RX state machine ──────────────────────────────────────────────────────
    //
    // States:
    //   IDLE      — watching for PREAMBLE_MIN_SYMBOLS consecutive preamble-tone symbols
    //   SYNC      — reading 4 symbols to decode SYNC_BYTE; mismatches reset to IDLE
    //   DATA      — decoding data bytes 4-symbols-at-a-time; first 2 bytes give length
    //   CHECKSUM  — reading 4 symbols (1 XOR byte) and verifying; delivers frame on match
    //
    type RxState = 'IDLE' | 'SYNC' | 'DATA' | 'CHECKSUM';
    let rxState: RxState = 'IDLE';
    let preambleCount = 0;
    let symbolAccum: number[] = [];  // sub-phase accumulator (max 4 symbols = 1 byte)
    let dataBytes: number[] = [];    // decoded bytes of the current acoustic frame
    let totalExpected = 0;           // total data bytes once the length prefix is known

    function resetState() {
        rxState = 'IDLE';
        preambleCount = 0;
        symbolAccum = [];
        dataBytes = [];
        totalExpected = 0;
    }

    /** Decode the 4 accumulated symbol indices into one byte and clear the accumulator. */
    function flushByte(): number {
        const b = (symbolAccum[0] << 6) | (symbolAccum[1] << 4) |
                  (symbolAccum[2] << 2) |  symbolAccum[3];
        symbolAccum = [];
        return b & 0xFF;
    }

    rxNode.port.onmessage = (event) => {
        const msg = event.data as { type: string; toneIndex: number; dominance: number };
        if (msg.type !== 'symbol') return;

        const { toneIndex, dominance } = msg;
        const validTone = toneIndex >= 0 && dominance >= TONE_DOMINANCE_RATIO;

        switch (rxState) {
            case 'IDLE':
                if (validTone && toneIndex === PREAMBLE_TONE) {
                    preambleCount++;
                    if (preambleCount >= PREAMBLE_MIN_SYMBOLS) {
                        rxState = 'SYNC';
                        symbolAccum = [];
                    }
                } else {
                    preambleCount = 0;
                }
                break;

            case 'SYNC':
                if (!validTone) { resetState(); break; }
                symbolAccum.push(toneIndex);
                if (symbolAccum.length === 4) {
                    const syncByte = flushByte();
                    if (syncByte === SYNC_BYTE) {
                        rxState = 'DATA';
                        dataBytes = [];
                        totalExpected = 0;
                    } else {
                        console.warn(
                            `FSK RX: sync mismatch (got 0x${syncByte.toString(16).toUpperCase()})`,
                        );
                        resetState();
                    }
                }
                break;

            case 'DATA':
                if (!validTone) {
                    console.warn('FSK RX: noise during data symbols — discarding frame');
                    resetState();
                    break;
                }
                symbolAccum.push(toneIndex);
                if (symbolAccum.length === 4) {
                    const byte = flushByte();
                    dataBytes.push(byte);

                    // After the first 2 bytes we know the total application frame length.
                    if (dataBytes.length === 2 && totalExpected === 0) {
                        const contentLength = (dataBytes[0] << 8) | dataBytes[1];
                        totalExpected = 2 + contentLength;
                    }

                    if (totalExpected > 0 && dataBytes.length === totalExpected) {
                        rxState = 'CHECKSUM';
                        symbolAccum = [];
                    }
                }
                break;

            case 'CHECKSUM':
                if (!validTone) {
                    console.warn('FSK RX: noise during checksum symbol — discarding frame');
                    resetState();
                    break;
                }
                symbolAccum.push(toneIndex);
                if (symbolAccum.length === 4) {
                    const rxChecksum = flushByte();
                    let expectedChecksum = 0;
                    for (const b of dataBytes) expectedChecksum ^= b;

                    if (rxChecksum === (expectedChecksum & 0xFF)) {
                        const frameBuf = new Uint8Array(dataBytes).buffer;
                        try {
                            onData(frameBuf);
                        } catch (err) {
                            console.error('FSK RX: onData callback threw:', err);
                        }
                    } else {
                        console.warn(
                            `FSK RX: checksum mismatch ` +
                            `(expected 0x${(expectedChecksum & 0xFF).toString(16).toUpperCase()}, ` +
                            `got 0x${rxChecksum.toString(16).toUpperCase()})`,
                        );
                    }
                    resetState();
                }
                break;
        }
    };

    const stop = () => {
        rxNode.port.postMessage('stop');
        rxNode.disconnect();
        source.disconnect();
        stream.getTracks().forEach(track => track.stop());
        ctx.close().catch(() => {});
    };

    return { analyser, stop };
}
