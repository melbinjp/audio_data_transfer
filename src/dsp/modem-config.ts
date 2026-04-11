/**
 * Shared constants for the from-scratch 4-FSK audio modem.
 *
 * Modem specification:
 *   Modulation:           4-FSK (4 tones, 2 bits per symbol)
 *   Symbol duration:      10 ms  →  100 symbols/sec
 *   Tones:                ~400, ~800, ~1200, ~1600 Hz
 *   Acoustic throughput:  ~25 bytes/sec (raw 200 bits/sec)
 *
 * Both TX and RX derive
 *   symbolSamples = Math.round(SYMBOL_DURATION_MS × sampleRate / 1000)
 * at runtime from their own AudioContext.sampleRate.  This guarantees the same
 * physical tone frequencies (in Hz) regardless of whether the device runs at
 * 44.1 kHz, 48 kHz, or any other standard sample rate.
 *
 * Because SYMBOL_DURATION_MS = 10 ms = 1 / 100 s, and because each k value is
 * chosen so that k full cycles of the tone fit exactly in the symbol window:
 *
 *   k = 4  →  4 × (1000/10) = 400 Hz
 *   k = 8  →  8 × 100       = 800 Hz
 *   k = 12 → 12 × 100       = 1200 Hz
 *   k = 16 → 16 × 100       = 1600 Hz
 *
 * Integer-cycle alignment eliminates spectral leakage and maximises the
 * Goertzel signal-to-noise ratio.  Using 10 ms (vs. the previous 5 ms) doubles
 * the number of samples per Goertzel window, giving roughly 2× better SNR and
 * dramatically improving tone discrimination on Android devices where hardware
 * audio processing can distort the signal even when software processing is
 * disabled via getUserMedia constraints.
 */

/** Real-time duration of one FSK symbol in milliseconds (10 ms = 100 symbols/sec). */
export const SYMBOL_DURATION_MS = 10;

/**
 * Goertzel frequency bins (k values) for the 4 FSK tones of the DATA channel
 * (sender → receiver).
 * Actual tone Hz = k × (1000 / SYMBOL_DURATION_MS) = k × 100.
 * Frequencies match the previous 5 ms configuration (400, 800, 1200, 1600 Hz);
 * only k is doubled so that exactly k integer cycles fit in the wider window.
 */
export const K_VALUES = [4, 8, 12, 16] as const;

/**
 * Tone index (into K_VALUES) used for the data-channel preamble.
 * Index 1 → k = 8 → ~800 Hz: above typical low-frequency ambient noise and
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
 *   k = 22 → 22 × 100 = 2200 Hz
 *   k = 26 → 26 × 100 = 2600 Hz
 *   k = 30 → 30 × 100 = 3000 Hz
 *   k = 34 → 34 × 100 = 3400 Hz
 *
 * Because the ACK listener on the sender side only looks for tones in this
 * upper band, the sender's own outgoing data transmissions (400–1600 Hz)
 * cannot be misinterpreted as incoming ACKs, eliminating self-reception errors.
 * k values are doubled relative to the old 5 ms configuration to maintain the
 * same physical frequencies with the new 10 ms symbol window.
 */
export const ACK_K_VALUES = [22, 26, 30, 34] as const;

/**
 * Preamble tone index into ACK_K_VALUES.
 * Index 1 → k = 26 → 2600 Hz.
 */
export const ACK_PREAMBLE_TONE = 1;

/**
 * Number of preamble symbols prepended to every data acoustic frame.
 * Raised from 20 to 30 to give the receiver more time to re-acquire preamble
 * lock after ACK transmission and acoustic ring-down (2A).  At 10 ms/symbol
 * this adds 100 ms of preamble per frame, a worthwhile cost for the
 * substantially improved lock reliability on subsequent frames.
 */
export const PREAMBLE_SYMBOLS = 30;

/**
 * Number of preamble symbols prepended to every ACK frame (receiver → sender).
 * Higher than PREAMBLE_SYMBOLS so the sender's ACK listener has more time to
 * achieve preamble lock before the short ACK payload begins.  Smartphone
 * speakers may have a slow gain ramp at startup; extra preamble compensates
 * for the first few attenuated symbols.
 */
export const ACK_PREAMBLE_SYMBOLS = 30;

/**
 * Minimum consecutive preamble-tone symbols required to declare preamble lock
 * on the ACK back-channel.  Lower than PREAMBLE_MIN_SYMBOLS so that the
 * sender's listener can lock on even when the first few ACK preamble symbols
 * are weakened by speaker warm-up or room acoustics.
 */
export const ACK_PREAMBLE_MIN_SYMBOLS = 12;

/**
 * Minimum consecutive preamble-tone symbols required to declare preamble lock.
 * Lower than PREAMBLE_SYMBOLS so that a few leading symbols caught mid-window
 * do not prevent detection.  Raised from 14 to 16 to further reduce false
 * triggers from ambient noise while still leaving 4 symbols of margin before
 * the sync byte arrives.
 */
export const PREAMBLE_MIN_SYMBOLS = 16;

/**
 * Sync byte marking the start of data after the preamble.
 * 0xAB = 10101011 → 4-FSK symbols [2, 2, 2, 3].
 * This bit pattern is unlikely to occur in a random noise context.
 */
export const SYNC_BYTE = 0xAB;

/** Silent guard symbols appended after each acoustic frame. */
export const GUARD_SYMBOLS = 12;

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
 * without throwing away the whole reception attempt.  Raised from 8 to 16 to
 * tolerate a larger range of clock-alignment offsets before giving up.
 */
export const SYNC_MAX_RETRIES = 16;

/**
 * Maximum allowed Hamming distance between the received sync byte and
 * SYNC_BYTE.  A value of 1 tolerates single-bit errors in the sync byte
 * caused by hardware audio processing on Android devices attenuating or
 * distorting one of the four FSK tones.
 */
export const SYNC_HAMMING_TOLERANCE = 1;

/**
 * Preamble-credit cost per non-preamble symbol in IDLE state.
 *
 * The classic approach resets `preambleCount` to 0 on any miss, so a single
 * noise burst (e.g. the tail of ACK speaker ring-down) erases all accumulated
 * preamble progress.  A "leaky bucket" approach subtracts this cost instead,
 * meaning brief noise bursts slow preamble lock rather than preventing it.
 *
 * With PREAMBLE_MISS_COST = 1:
 *   • Each bad symbol costs 1 credit (vs. resetting to 0).
 *   • A burst of 3 noise symbols costs only 3 credits — the detector recovers
 *     after 3 more good preamble symbols rather than needing PREAMBLE_MIN_SYMBOLS
 *     all over again (2B).
 */
export const PREAMBLE_MISS_COST = 1;

/**
 * Milliseconds to wait after ACK playback finishes before re-enabling the
 * receiver's RX state machine (1C).
 *
 * Smartphone speakers continue to vibrate ("ring down") briefly after the
 * last PCM sample plays.  Room reverb also produces a tail of energy in the
 * data-channel band (400–1600 Hz).  Keeping the RX muted for this window
 * prevents the acoustic tail from being mistaken for preamble symbols on the
 * next incoming data frame.
 *
 * 50 ms is sufficient for typical consumer hardware in a quiet room.  Raise
 * this value if ring-down artefacts are still visible in the spectrogram after
 * ACK transmission ends.
 */
export const ACK_RING_DOWN_MS = 50;
