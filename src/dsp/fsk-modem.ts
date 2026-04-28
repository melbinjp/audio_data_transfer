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
    ACK_PREAMBLE_SYMBOLS,
    PREAMBLE_MIN_SYMBOLS,
    ACK_PREAMBLE_MIN_SYMBOLS,
    PREAMBLE_MISS_COST,
    SYNC_BYTE,
    GUARD_SYMBOLS,
    SILENCE_THRESHOLD,
    TONE_DOMINANCE_RATIO,
    SYNC_MAX_RETRIES,
    SYNC_HAMMING_TOLERANCE,
    ACK_K_VALUES,
    ACK_PREAMBLE_TONE,
} from './modem-config';

// ─────────────────────────────────────────────────────────────────────────────
// Channel configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Describes the frequency characteristics of one logical modem channel.
 * Both TX and RX use the same `ChannelConfig` so that they agree on which
 * physical tones carry data and which tone is used as the preamble beacon.
 */
export interface ChannelConfig {
    /** The four Goertzel k-values that define the four FSK tones for this channel. */
    kValues: readonly number[];
    /** Index into kValues for the preamble tone. */
    preambleTone: number;
    /**
     * Number of preamble symbols prepended to every TX frame on this channel.
     * Defaults to PREAMBLE_SYMBOLS when not set.
     */
    preambleSymbols?: number;
    /**
     * Minimum consecutive preamble-tone symbols required for preamble lock on
     * this channel (RX side).  Defaults to PREAMBLE_MIN_SYMBOLS when not set.
     */
    preambleMinSymbols?: number;
}

/** Data channel (sender → receiver): tones at 400, 800, 1200, 1600 Hz. */
export const DATA_CHANNEL: ChannelConfig = {
    kValues: Array.from(K_VALUES),
    preambleTone: PREAMBLE_TONE,
};

/**
 * ACK back-channel (receiver → sender): tones at 2200, 2600, 3000, 3400 Hz.
 *
 * Using a frequency band completely above the data channel ensures the sender's
 * ACK listener cannot decode its own outgoing data transmissions as ACKs.
 *
 * A longer TX preamble (ACK_PREAMBLE_SYMBOLS) gives the sender's listener
 * more time to achieve lock before the short ACK payload arrives.  A lower
 * RX preamble-min threshold (ACK_PREAMBLE_MIN_SYMBOLS) makes lock easier to
 * achieve when the first few symbols are attenuated by smartphone speaker
 * warm-up or room acoustics.
 */
export const ACK_CHANNEL: ChannelConfig = {
    kValues: Array.from(ACK_K_VALUES),
    preambleTone: ACK_PREAMBLE_TONE,
    preambleSymbols: ACK_PREAMBLE_SYMBOLS,
    preambleMinSymbols: ACK_PREAMBLE_MIN_SYMBOLS,
};

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
 * `kValue` is the integer Goertzel bin number; the tone frequency is
 *   freq = kValue × sampleRate / symbolSamples  Hz.
 * Because kValue is an integer and symbolSamples = round(SYMBOL_DURATION_MS × sr),
 * exactly kValue full cycles fit in the window, eliminating spectral leakage.
 */
function synthesiseTone(
    kValue: number,
    symbolSamples: number,
    sampleRate: number,
): Float32Array {
    const freq = (kValue * sampleRate) / symbolSamples;
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
 *
 * @param channel  Which frequency channel to encode for (data or ACK).
 *                 Defaults to DATA_CHANNEL so existing callers are unaffected.
 */
function encodeFrameToAudio(
    frame: ArrayBuffer,
    symbolSamples: number,
    sampleRate: number,
    channel: ChannelConfig = DATA_CHANNEL,
): Float32Array {
    const data = new Uint8Array(frame);
    const { kValues, preambleTone } = channel;
    const preambleCount = channel.preambleSymbols ?? PREAMBLE_SYMBOLS;

    // Pre-synthesise all four tone waveforms once to avoid redundant computation.
    const tones = kValues.map(k => synthesiseTone(k, symbolSamples, sampleRate));

    // XOR checksum over every data byte (acoustic-layer error detection).
    let checksum = 0;
    for (const b of data) checksum ^= b;

    // Total audio size (GUARD_SYMBOLS tail is zero-filled by Float32Array init).
    const totalSymbols = preambleCount + 4 + data.length * 4 + 4 + GUARD_SYMBOLS;
    const pcm = new Float32Array(totalSymbols * symbolSamples);
    let writePos = 0;

    const writeTone = (toneIndex: number) => {
        pcm.set(tones[toneIndex], writePos);
        writePos += symbolSamples;
    };

    // 1. Preamble
    for (let i = 0; i < preambleCount; i++) writeTone(preambleTone);

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
    this._step = Math.max(1, Math.floor(this._N / 4));
    this._kv   = opts.kValues          || [2, 4, 6, 8];
    this._silT = opts.silenceThreshold || 0.005;
    this._buf  = new Float32Array(0);
    this._run  = true;
    this._seq  = 0;
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
        this.port.postMessage({ type: 'symbol', seq: this._seq, toneIndex: -1, rms: rms, dominance: 0 });
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
        this.port.postMessage({ type: 'symbol', seq: this._seq, toneIndex: best, rms: rms, dominance: dom });
      }

      /* Advance buffer by one step (overlapping windows). */
      this._seq++;
      this._buf = this._buf.slice(this._step);
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
 *
 * @param channel  Which frequency channel to transmit on.
 *                 Defaults to DATA_CHANNEL (400–1600 Hz) for the sender.
 *                 Pass ACK_CHANNEL (2200–3400 Hz) when the receiver sends ACKs.
 */
export class TransmitterSession {
    private ctx: AudioContext | null = null;
    private isDestroyed = false;

    constructor(private readonly channel: ChannelConfig = DATA_CHANNEL) {}

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
     * Encodes `data` as a 4-FSK acoustic frame on the configured channel and
     * plays it to the speaker.  Resolves when playback is complete.
     * Calls must be awaited sequentially.
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
                pcm = encodeFrameToAudio(data, symbolSamples, ctx.sampleRate, this.channel);
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }

            const audioBuf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
            audioBuf.copyToChannel(Float32Array.from(pcm), 0);

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
// FskDecoder — pure, testable RX state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Goertzel algorithm — computes energy at a single frequency bin k.
 * Identical to the AudioWorklet implementation but expressed as plain TypeScript
 * so it can run in Node.js (vitest) without any browser APIs.
 */
function goertzel(buf: Float32Array, k: number): number {
    const N = buf.length;
    const coeff = 2.0 * Math.cos((2.0 * Math.PI * k) / N);
    let q1 = 0.0, q2 = 0.0;
    for (let i = 0; i < N; i++) {
        const q0 = buf[i] + coeff * q1 - q2;
        q2 = q1;
        q1 = q0;
    }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

/**
 * Standalone 4-FSK RX decoder.
 *
 * Feed raw PCM via `pushSamples()`.  Runs the same sliding-window Goertzel
 * detector and PLL-assisted state machine as the AudioWorklet receiver, but
 * entirely in synchronous TypeScript — no browser APIs required.
 *
 * This makes the modem testable headlessly in vitest / Node.js:
 *   encodeFrameToAudio(frame) → pcm → decoder.pushSamples(pcm) → onData(frame)
 */
export class FskDecoder {
    private readonly kValues: readonly number[];
    private readonly preambleTone: number;
    private readonly preambleMinCount: number;
    private readonly onData: (data: ArrayBuffer) => void;
    private readonly symbolSamples: number;
    private readonly step: number;
    private readonly silenceThreshold: number;

    private buf: Float32Array = new Float32Array(0);
    private seq = 0;

    private rxState: 'IDLE' | 'SYNC' | 'DATA' | 'CHECKSUM' = 'IDLE';
    private preambleCount = 0;
    private symbolAccum: number[] = [];
    private dataBytes: number[] = [];
    private totalExpected = 0;
    private syncRetryCount = 0;
    private rxMuted = false;

    private microBuffer: { seq: number; toneIndex: number; dominance: number }[] = [];
    private nextSymbolSeq = 0;

    constructor(opts: {
        sampleRate: number;
        channel?: ChannelConfig;
        onData: (data: ArrayBuffer) => void;
        silenceThreshold?: number;
    }) {
        const channel = opts.channel ?? DATA_CHANNEL;
        this.kValues = channel.kValues;
        this.preambleTone = channel.preambleTone;
        this.preambleMinCount = channel.preambleMinSymbols ?? PREAMBLE_MIN_SYMBOLS;
        this.onData = opts.onData;
        this.symbolSamples = getSymbolSamples(opts.sampleRate);
        this.step = Math.max(1, Math.floor(this.symbolSamples / 4));
        this.silenceThreshold = opts.silenceThreshold ?? SILENCE_THRESHOLD;
    }

    /** Push a chunk of raw PCM samples. Can be called repeatedly. */
    pushSamples(samples: Float32Array): void {
        const merged = new Float32Array(this.buf.length + samples.length);
        merged.set(this.buf);
        merged.set(samples, this.buf.length);
        this.buf = merged;

        while (this.buf.length >= this.symbolSamples) {
            const sym = this.buf.subarray(0, this.symbolSamples);

            let sumSq = 0;
            for (let i = 0; i < sym.length; i++) sumSq += sym[i] * sym[i];
            const rms = Math.sqrt(sumSq / sym.length);

            let toneIndex: number, dominance: number;
            if (rms < this.silenceThreshold) {
                toneIndex = -1; dominance = 0;
            } else {
                const energies = Array.from(this.kValues).map(k => goertzel(sym, k));
                const total = energies.reduce((a, b) => a + b, 0);
                let maxE = -1, best = 0;
                for (let j = 0; j < energies.length; j++) {
                    if (energies[j] > maxE) { maxE = energies[j]; best = j; }
                }
                toneIndex = best;
                dominance = total > 0 ? maxE / total : 0;
            }

            this._handleSymbolMsg(this.seq, toneIndex, dominance);
            this.seq++;
            this.buf = this.buf.slice(this.step);
        }
    }

    /** Mutes/unmutes the state machine (call during ACK TX to prevent self-decode). */
    setMuted(muted: boolean): void {
        if (muted && !this.rxMuted) this._resetState();
        this.rxMuted = muted;
    }

    /**
     * Process one symbol event. Called from `pushSamples` (test/headless path)
     * or from the AudioWorklet `onmessage` handler (live browser path).
     * @internal
     */
    _handleSymbolMsg(seq: number, toneIndex: number, dominance: number): void {
        if (this.rxMuted) return;

        this.microBuffer.push({ seq, toneIndex, dominance });
        if (this.microBuffer.length > 16) this.microBuffer.shift();

        if (this.rxState === 'IDLE') {
            const validTone = toneIndex >= 0 && dominance >= TONE_DOMINANCE_RATIO;
            if (validTone && toneIndex === this.preambleTone) {
                this.preambleCount += 0.25;
                if (this.preambleCount >= this.preambleMinCount) {
                    let bestDom = -1, bestSeq = seq;
                    for (let i = 0; i < 4; i++) {
                        const s = this.microBuffer[this.microBuffer.length - 1 - i];
                        if (s && s.dominance > bestDom) { bestDom = s.dominance; bestSeq = s.seq; }
                    }
                    this.nextSymbolSeq = bestSeq + 4;
                    while (this.nextSymbolSeq <= seq) this.nextSymbolSeq += 4;
                    this.rxState = 'SYNC';
                    this.symbolAccum = [];
                }
            } else {
                this.preambleCount = Math.max(0, this.preambleCount - PREAMBLE_MISS_COST * 0.25);
            }
            return;
        }

        // PLL tracking (SYNC / DATA / CHECKSUM)
        const ci = this.microBuffer.findIndex(s => s.seq === this.nextSymbolSeq);
        if (ci !== -1 && ci < this.microBuffer.length - 1) {
            const center = this.microBuffer[ci];
            const early  = ci > 0 ? this.microBuffer[ci - 1] : center;
            const late   = this.microBuffer[ci + 1];

            if (center.dominance >= TONE_DOMINANCE_RATIO) {
                if (early.dominance > late.dominance + 0.2)      this.nextSymbolSeq += 3;
                else if (late.dominance > early.dominance + 0.2) this.nextSymbolSeq += 5;
                else                                              this.nextSymbolSeq += 4;
            } else {
                this.nextSymbolSeq += 4;
            }
            this._processSymbol(center.toneIndex, center.dominance);
        }
    }

    private _resetState(): void {
        this.rxState = 'IDLE';
        this.preambleCount = 0;
        this.symbolAccum = [];
        this.dataBytes = [];
        this.totalExpected = 0;
        this.syncRetryCount = 0;
    }

    private _flushByte(): number {
        const b = (this.symbolAccum[0] << 6) | (this.symbolAccum[1] << 4) |
                  (this.symbolAccum[2] << 2) |  this.symbolAccum[3];
        this.symbolAccum = [];
        return b & 0xFF;
    }

    private _hammingDistance(a: number, b: number): number {
        let diff = (a ^ b) & 0xFF, count = 0;
        while (diff !== 0) { count += diff & 1; diff >>>= 1; }
        return count;
    }

    private _processSymbol(toneIndex: number, dominance: number): void {
        const validTone = toneIndex >= 0 && dominance >= TONE_DOMINANCE_RATIO;

        switch (this.rxState) {
            case 'IDLE': break;

            case 'SYNC':
                if (toneIndex === -1) { this._resetState(); break; }
                if (!validTone) break;
                if (toneIndex === this.preambleTone && this.symbolAccum.length === 0) break;
                this.symbolAccum.push(toneIndex);
                if (this.symbolAccum.length === 4) {
                    const syncByte = this._flushByte();
                    if (this._hammingDistance(syncByte, SYNC_BYTE) <= SYNC_HAMMING_TOLERANCE) {
                        this.rxState = 'DATA';
                        this.dataBytes = [];
                        this.totalExpected = 0;
                    } else {
                        this.syncRetryCount++;
                        if (this.syncRetryCount >= SYNC_MAX_RETRIES) this._resetState();
                    }
                }
                break;

            case 'DATA':
                if (toneIndex === -1) { this._resetState(); break; }
                this.symbolAccum.push(toneIndex);
                if (this.symbolAccum.length === 4) {
                    const byte = this._flushByte();
                    this.dataBytes.push(byte);
                    if (this.dataBytes.length === 2 && this.totalExpected === 0) {
                        const cl = (this.dataBytes[0] << 8) | this.dataBytes[1];
                        if (cl === 0 || cl > 512) { this._resetState(); }
                        else { this.totalExpected = 2 + cl; }
                    }
                    if (this.totalExpected > 0 && this.dataBytes.length === this.totalExpected) {
                        this.rxState = 'CHECKSUM';
                        this.symbolAccum = [];
                    }
                }
                break;

            case 'CHECKSUM':
                if (toneIndex === -1) { this._resetState(); break; }
                this.symbolAccum.push(toneIndex);
                if (this.symbolAccum.length === 4) {
                    this._flushByte(); // XOR byte — CRC32 in framing.ts handles data integrity
                    try { this.onData(new Uint8Array(this.dataBytes).buffer); }
                    catch (err) { console.error('FSK RX: onData callback threw:', err); }
                    this._resetState();
                }
                break;
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
 * @param onData   Invoked with each complete, checksum-verified application frame.
 * @param channel  Which frequency channel to listen on.
 *                 Defaults to DATA_CHANNEL (400-1600 Hz) for the receiver.
 *                 Pass ACK_CHANNEL (2200-3400 Hz) when the sender listens for ACKs.
 */
export async function startListening(
    onData: (data: ArrayBuffer) => void,
    channel: ChannelConfig = DATA_CHANNEL,
): Promise<{ analyser: AnalyserNode; stop: () => void; setRxMuted: (muted: boolean) => void }> {
    const { kValues } = channel;
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
        // Disable all browser audio-processing pipelines. Echo cancellation
        // and noise suppression specifically target the 300-3400 Hz voice band,
        // which overlaps exactly with the FSK data channel (400-1600 Hz) and
        // ACK channel (2200-3400 Hz). Leaving them enabled causes the browser
        // to attenuate or distort the FSK tones before they reach the Goertzel
        // detector, producing sync mismatches and failed transfers.
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
        },
        video: false,
    }).catch(
        (err: unknown) => {
            ctx.close().catch(() => {});
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `startListening: microphone access failed - ${msg}. ` +
                'Check browser permissions and ensure a microphone is connected.',
            );
        },
    );
    const source = ctx.createMediaStreamSource(stream);

    // AnalyserNode for spectrogram visualisation (connected to the raw mic stream).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Load the RX processor via a Blob URL - compatible with Vite dev and
    // production builds without any special plugin configuration.
    const processorBlob = new Blob([getRxProcessorSource()], { type: 'application/javascript' });
    const processorUrl = URL.createObjectURL(processorBlob);
    await ctx.audioWorklet.addModule(processorUrl);
    URL.revokeObjectURL(processorUrl);

    const symbolSamples = getSymbolSamples(ctx.sampleRate);
    const rxNode = new AudioWorkletNode(ctx, 'fsk-rx-processor', {
        processorOptions: {
            symbolSamples,
            kValues: Array.from(kValues),
            silenceThreshold: SILENCE_THRESHOLD,
        },
    });
    // Connect source -> worklet but NOT worklet -> destination (avoid mic loopback).
    source.connect(rxNode);

    // Delegate all decoding to FskDecoder - same logic, no code duplication.
    const decoder = new FskDecoder({ sampleRate: ctx.sampleRate, channel, onData });

    rxNode.port.onmessage = (event) => {
        const msg = event.data as { type: string; seq: number; toneIndex: number; rms: number; dominance: number };
        if (msg.type !== 'symbol') return;
        decoder._handleSymbolMsg(msg.seq, msg.toneIndex, msg.dominance);
    };

    const stop = () => {
        rxNode.port.postMessage('stop');
        rxNode.disconnect();
        source.disconnect();
        stream.getTracks().forEach(track => track.stop());
        ctx.close().catch(() => {});
    };

    const setRxMuted = (muted: boolean): void => decoder.setMuted(muted);

    return { analyser, stop, setRxMuted };
}
