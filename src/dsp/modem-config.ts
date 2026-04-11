/**
 * Shared constants for the from-scratch 4-FSK audio modem.
 *
 * Modem specification:
 *   Modulation:           4-FSK (4 tones, 2 bits per symbol)
 *   Symbol duration:      5 ms  →  200 symbols/sec
 *   Tones:                ~400, ~800, ~1200, ~1600 Hz
 *   Acoustic throughput:  ~50 bytes/sec (raw 400 bits/sec)
 *
 * Both TX and RX derive
 *   symbolSamples = Math.round(SYMBOL_DURATION_MS × sampleRate / 1000)
 * at runtime from their own AudioContext.sampleRate.  This guarantees the same
 * physical tone frequencies (in Hz) regardless of whether the device runs at
 * 44.1 kHz, 48 kHz, or any other standard sample rate.
 *
 * Because SYMBOL_DURATION_MS = 5 ms = 1 / 200 s, and because each k value is
 * chosen so that k full cycles of the tone fit exactly in the symbol window:
 *
 *   k = 2  →  2 × (1000/5) = 400 Hz
 *   k = 4  →  4 × 200     = 800 Hz
 *   k = 6  →  6 × 200     = 1200 Hz
 *   k = 8  →  8 × 200     = 1600 Hz
 *
 * Integer-cycle alignment eliminates spectral leakage and maximises the
 * Goertzel signal-to-noise ratio.
 */

/** Real-time duration of one FSK symbol in milliseconds (5 ms = 200 symbols/sec). */
export const SYMBOL_DURATION_MS = 5;

/**
 * Goertzel frequency bins (k values) for the 4 FSK tones of the DATA channel
 * (sender → receiver).
 * Actual tone Hz = k × (1000 / SYMBOL_DURATION_MS) = k × 200.
 */
export const K_VALUES = [2, 4, 6, 8] as const;

/**
 * Tone index (into K_VALUES) used for the data-channel preamble.
 * Index 1 → k = 4 → ~800 Hz: above typical low-frequency ambient noise and
 * microphone roll-off, yet well within every consumer speaker's passband.
 */
export const PREAMBLE_TONE = 1;

/**
 * Goertzel frequency bins (k values) for the ACK back-channel
 * (receiver → sender).
 *
 * These bins are chosen to be completely non-overlapping with the data-channel
 * tones (400–1600 Hz) while remaining within the passband of every consumer
 * speaker and microphone (≤ ~8 kHz):
 *
 *   k = 11 → 11 × 200 = 2200 Hz
 *   k = 13 → 13 × 200 = 2600 Hz
 *   k = 15 → 15 × 200 = 3000 Hz
 *   k = 17 → 17 × 200 = 3400 Hz
 *
 * Because the ACK listener on the sender side only looks for tones in this
 * upper band, the sender's own outgoing data transmissions (400–1600 Hz)
 * cannot be misinterpreted as incoming ACKs, eliminating self-reception errors.
 */
export const ACK_K_VALUES = [11, 13, 15, 17] as const;

/**
 * Preamble tone index into ACK_K_VALUES.
 * Index 1 → k = 13 → 2600 Hz.
 */
export const ACK_PREAMBLE_TONE = 1;

/** Number of preamble symbols prepended to every acoustic frame. */
export const PREAMBLE_SYMBOLS = 16;

/**
 * Minimum consecutive preamble-tone symbols required to declare preamble lock.
 * Lower than PREAMBLE_SYMBOLS so that a few leading symbols caught mid-window
 * do not prevent detection.
 */
export const PREAMBLE_MIN_SYMBOLS = 10;

/**
 * Sync byte marking the start of data after the preamble.
 * 0xAB = 10101011 → 4-FSK symbols [2, 2, 2, 3].
 * This bit pattern is unlikely to occur in a random noise context.
 */
export const SYNC_BYTE = 0xAB;

/** Silent guard symbols appended after each acoustic frame. */
export const GUARD_SYMBOLS = 8;

/** RMS amplitude below this value is classified as silence (no active tone). */
export const SILENCE_THRESHOLD = 0.005;

/**
 * Minimum ratio of the strongest Goertzel-energy bin to the sum of all bins
 * for a symbol to be accepted as a valid tone (vs. noise).
 * Pure sine → ratio ≈ 1.0; flat noise → ratio ≈ 0.25 (one of four equal bins).
 */
export const TONE_DOMINANCE_RATIO = 0.4;

/**
 * Maximum number of consecutive sync-byte decode attempts before the receiver
 * abandons the current preamble and returns to IDLE to hunt for a new one.
 *
 * Due to symbol-clock misalignment between transmitter and receiver, the first
 * window after the preamble may straddle two different tones and decode to the
 * wrong value.  Allowing a small number of retries (sliding one window forward
 * each time) gives the state machine a chance to find a well-aligned window
 * without throwing away the whole reception attempt.
 */
export const SYNC_MAX_RETRIES = 8;
