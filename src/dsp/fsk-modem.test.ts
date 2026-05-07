/**
 * Headless FSK modem loopback tests.
 *
 * Strategy: encodeFrameToAudio (pure TX function) produces a Float32Array of
 * PCM.  We feed that PCM directly into FskDecoder.pushSamples() in 128-sample
 * chunks — exactly as an AudioWorklet would deliver them — and verify the
 * decoded bytes match the original frame.
 *
 * No speakers, no microphone, no browser APIs required.
 * Runs entirely in Node.js via `npm test -- --run`.
 */

import { describe, it, expect } from 'vitest';
import {
    FskDecoder,
    ACK_CHANNEL,
} from './fsk-modem';

import {
    createFileDataFrames,
    createFileStartFrame,
    createCompactAckFrame,
    deframe,
} from '../transport/framing';

// ── Constants mirrored from modem-config (avoid re-importing to keep the
//    test self-contained and independent of config changes) ─────────────────
const SAMPLE_RATE = 48000;
const SYMBOL_DURATION_MS = 10;
const SYMBOL_SAMPLES = Math.round((SYMBOL_DURATION_MS * SAMPLE_RATE) / 1000); // 480
const PREAMBLE_SYMBOLS = 30;
const GUARD_SYMBOLS = 12;
const SYNC_BYTE = 0xAB;
const K_VALUES = [4, 8, 12, 16];

// ── TX helper (mirrors encodeFrameToAudio in fsk-modem.ts) ────────────────
// Re-implemented here so the test does not rely on a non-exported function.
function synthesiseTone(k: number, N: number, sr: number): Float32Array {
    const freq = (k * sr) / N;
    const out = new Float32Array(N);
    const w = (2 * Math.PI * freq) / sr;
    for (let i = 0; i < N; i++) out[i] = Math.sin(w * i);
    return out;
}

function byteToSymbols(b: number): [number, number, number, number] {
    return [(b >> 6) & 3, (b >> 4) & 3, (b >> 2) & 3, b & 3];
}

function encodeFrame(
    frame: ArrayBuffer,
    kValues: readonly number[] = K_VALUES,
    preambleTone = 1,
    preambleCount = PREAMBLE_SYMBOLS,
): Float32Array {
    const N = SYMBOL_SAMPLES;
    const sr = SAMPLE_RATE;
    const data = new Uint8Array(frame);
    const tones = kValues.map(k => synthesiseTone(k, N, sr));

    let checksum = 0;
    for (const b of data) checksum ^= b;

    const totalSymbols = preambleCount + 4 + data.length * 4 + 4 + GUARD_SYMBOLS;
    const pcm = new Float32Array(totalSymbols * N);
    let pos = 0;

    const write = (ti: number) => { pcm.set(tones[ti], pos); pos += N; };

    for (let i = 0; i < preambleCount; i++) write(preambleTone);
    for (const s of byteToSymbols(SYNC_BYTE)) write(s);
    for (const b of data) for (const s of byteToSymbols(b)) write(s);
    for (const s of byteToSymbols(checksum)) write(s);

    return pcm;
}

/** Feed PCM into the decoder in 128-sample chunks (AudioWorklet quantum size). */
function feedPcm(decoder: FskDecoder, pcm: Float32Array, chunkSize = 128): void {
    for (let off = 0; off < pcm.length; off += chunkSize) {
        decoder.pushSamples(pcm.subarray(off, off + chunkSize));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('FSK modem headless loopback', () => {

    it('encodeFrame produces deterministic PCM', () => {
        const frame = new Uint8Array([0, 5, 72, 101, 108, 108, 111]).buffer;
        const pcm1 = encodeFrame(frame);
        const pcm2 = encodeFrame(frame);
        expect(pcm1).toEqual(pcm2);
        expect(pcm1.length).toBeGreaterThan(0);
    });

    it('single-frame loopback: encoded bytes match decoded bytes', () => {
        const payload = 'Hello FSK!';
        const fileBuffer = new TextEncoder().encode(payload).buffer;
        const frames = createFileDataFrames(fileBuffer, 'test-loopback-id');
        expect(frames.length).toBe(1);

        const appFrame = frames[0];
        const pcm = encodeFrame(appFrame);

        const received: ArrayBuffer[] = [];
        const decoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            onData: buf => received.push(buf),
        });

        feedPcm(decoder, pcm);

        expect(received.length).toBe(1);

        // The decoded buffer is the raw acoustic payload (the app frame bytes).
        // Verify by deframing and checking the content.
        const { header, payload: decodedPayload } = deframe(received[0]);
        expect(header.type).toBe('file-data');
        expect(new TextDecoder().decode(decodedPayload)).toBe(payload);
    });

    it('multi-frame loopback: all frames decoded in order', () => {
        // 200 bytes → 4 frames of 64 bytes (PAYLOAD_SIZE = 64)
        const content = 'A'.repeat(200);
        const fileBuffer = new TextEncoder().encode(content).buffer;
        const fileId = 'multi-frame-test';
        const frames = createFileDataFrames(fileBuffer, fileId);
        expect(frames.length).toBeGreaterThan(1);

        const received: ArrayBuffer[] = [];
        const decoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            onData: buf => received.push(buf),
        });

        for (const appFrame of frames) {
            feedPcm(decoder, encodeFrame(appFrame));
        }

        expect(received.length).toBe(frames.length);

        // Reassemble manually
        const chunks: Uint8Array[] = received.map(buf => new Uint8Array(deframe(buf).payload));
        let totalLen = 0;
        for (const c of chunks) totalLen += c.length;
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.length; }
        const reassembled = new TextDecoder().decode(merged);
        expect(reassembled).toBe(content);
    });

    it('ACK channel loopback: compact ack-frame decoded on ACK_CHANNEL', () => {
        const fileId = 'abcdef12-0000-0000-0000-000000000000';
        const ackFrame = createCompactAckFrame(fileId, 3);

        // ACK channel uses different k-values and preamble tone
        const ACK_K_VALUES = [22, 26, 30, 34];
        const ACK_PREAMBLE_TONE = 1;
        const ACK_PREAMBLE_SYMBOLS = 30;

        const pcm = encodeFrame(ackFrame, ACK_K_VALUES, ACK_PREAMBLE_TONE, ACK_PREAMBLE_SYMBOLS);

        const received: ArrayBuffer[] = [];
        const decoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            channel: ACK_CHANNEL,
            onData: buf => received.push(buf),
        });

        feedPcm(decoder, pcm);

        expect(received.length).toBe(1);
    });

    it('file-start frame survives the loopback', () => {
        const file = { name: 'test.txt', type: 'text/plain', size: 64 } as File;
        const startFrame = createFileStartFrame(file, 'start-test-id');
        const pcm = encodeFrame(startFrame);

        const received: ArrayBuffer[] = [];
        const decoder = new FskDecoder({
            sampleRate: SAMPLE_RATE,
            onData: buf => received.push(buf),
        });

        feedPcm(decoder, pcm);

        expect(received.length).toBe(1);
        const { header } = deframe(received[0]);
        expect(header.type).toBe('file-start');
        expect(header.fileName).toBe('test.txt');
    });
});
