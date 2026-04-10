let initPromise: Promise<void> | null = null;

/**
 * Polyfill navigator.getUserMedia with the modern Promise-based API so that
 * quiet.js (which uses the old callback-based navigator.getUserMedia /
 * navigator.webkitGetUserMedia) can still create a receiver on browsers that
 * have removed the legacy API (Chrome 74+).
 *
 * Must be called before any Quiet.receiver() invocation.
 */
function polyfillGetUserMedia(): void {
    if (
        typeof (navigator as unknown as { getUserMedia?: unknown }).getUserMedia === 'undefined' &&
        navigator.mediaDevices?.getUserMedia
    ) {
        (navigator as unknown as { getUserMedia: unknown }).getUserMedia =
            function (
                constraints: MediaStreamConstraints,
                success: (stream: MediaStream) => void,
                error: (err: Error) => void,
            ) {
                navigator.mediaDevices.getUserMedia(constraints).then(success).catch(error);
            };
    }
}

/** Delay (ms) before closing the temporary AudioContext created by primeAudio(). */
const PRIME_AUDIO_CONTEXT_CLOSE_DELAY_MS = 500;

/**
 * "Prime" the Web Audio API by creating and resuming a temporary AudioContext
 * synchronously within a user-gesture handler.
 *
 * Chrome's autoplay policy suspends AudioContexts that are created (or whose
 * resume() is called) outside a synchronous user-gesture frame.  The policy is
 * enforced at the *document* level: once any AudioContext has been successfully
 * started from a user gesture, all subsequent AudioContext.resume() calls on
 * the same document — even from async code — will succeed.
 *
 * **MUST be called synchronously at the top of a click/keydown handler, before
 * any `await`.**
 */
export function primeAudio(): void {
    try {
        const ctx = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext)();
        ctx.resume().catch(() => {});
        // Close after a brief delay so we don't leave a dangling context open.
        setTimeout(() => ctx.close().catch(() => {}), PRIME_AUDIO_CONTEXT_CLOSE_DELAY_MS);
    } catch (e) {
        console.warn('primeAudio: could not create AudioContext:', e);
    }
}

/**
 * Profile used for file-data frames (sender → receiver).
 *
 * 'audible-fsk' uses FSK8 modulation with a v29 convolutional outer FEC,
 * centred at 8 kHz with 50 samples/symbol (~250 bytes/sec at typical sample
 * rates).  This is 5× faster than the former 'audible-fsk-robust' profile
 * (250 samples/symbol, ~50 bytes/sec), which caused every 4096-byte frame to
 * require ~81 s of audio — far exceeding the 30 s transmission timeout and
 * making all transfers fail after the first frame.  'audible-fsk' still uses
 * the same FSK8/v29-FEC modem and is reliable for typical desktop/phone use.
 */
export const DATA_MODEM_PROFILE = 'audible-fsk';

/**
 * Profile used for ACK frames (receiver → sender).
 *
 * 'audible-fsk' uses the same FSK8/v29 modem as DATA_MODEM_PROFILE but with
 * only 50 samples/symbol (vs 250), reducing the Kaiser-filter tap-count from
 * 3,250 to 650.  This cuts the per-audio-buffer Emscripten DSP cost by ~5×,
 * keeping the main thread responsive while the sender is simultaneously
 * transmitting data and listening for ACKs.  ACKs are small and benefit from
 * the app-level retry logic, so the slightly reduced noise immunity is fine.
 */
export const ACK_MODEM_PROFILE = 'audible-fsk';

/**
 * Accumulates the raw byte stream delivered by quiet.js's per-acoustic-frame
 * `onReceive` callbacks and emits complete application frames.
 *
 * quiet.js slices every `transmit(buf)` call into individual PHY-layer frames
 * (~20–25 bytes each) and calls `onReceive` once per PHY frame.  Our
 * application frames are much larger (header + payload), so we must reassemble
 * them from the stream before handing them to higher-level protocol code.
 *
 * Frame wire format (produced by `createFrame` in framing.ts):
 *   [total_content_length (2 bytes, big-endian)] [content…]
 *
 * The buffer resets itself automatically after extracting each complete frame,
 * and can be cleared explicitly when the caller knows a transmission was
 * interrupted (e.g. on a new listening session).
 */
class StreamBuffer {
    private buf = new Uint8Array(0);

    /** Append a new chunk (one acoustic frame) to the internal buffer. */
    append(chunk: ArrayBuffer): void {
        const incoming = new Uint8Array(chunk);
        const next = new Uint8Array(this.buf.length + incoming.length);
        next.set(this.buf);
        next.set(incoming, this.buf.length);
        this.buf = next;
    }

    /**
     * Try to extract one complete application frame from the buffer.
     * Returns the frame (including the 2-byte length prefix so `deframe`
     * receives it in the expected format) or `null` if more bytes are needed.
     */
    tryExtract(): ArrayBuffer | null {
        if (this.buf.length < 2) return null;
        const contentLength = (this.buf[0] << 8) | this.buf[1];
        const totalLength = 2 + contentLength;
        if (this.buf.length < totalLength) return null;

        // Slice out the complete frame and advance the buffer.
        const frame = this.buf.slice(0, totalLength).buffer;
        this.buf = this.buf.slice(totalLength);
        return frame;
    }

    /** Discard all buffered bytes (call when starting a new listen session). */
    clear(): void {
        this.buf = new Uint8Array(0);
    }
}

/**
 * Initialize the Quiet.js library.
 * 
 * IMPORTANT TIMING: Quiet.init() must be called BEFORE quiet-emscripten.js
 * finishes loading. The emscripten script calls Quiet.onEmscriptenInitialized()
 * when it's ready, and the library needs profilesPrefix set before that happens
 * so it can fetch quiet-profiles.json. If both conditions (emscripten loaded +
 * profiles fetched) are met, the ready callbacks fire.
 * 
 * We call init() eagerly when this module is first imported (see bottom of file).
 */
function doInit(): Promise<void> {
    if (initPromise) {
        return initPromise;
    }

    initPromise = new Promise((resolve, reject) => {
        // Use Vite's BASE_URL to correctly resolve paths when the app is
        // served under a sub-path (e.g., /audio_data_transfer/).
        const base = import.meta.env.BASE_URL || '/';

        // Quiet.init() tells the library where to find:
        //   - quiet-profiles.json (at profilesPrefix + "quiet-profiles.json")
        //   - quiet-emscripten.js.mem (at memoryInitializerPrefix + "quiet-emscripten.js.mem")
        //   - libfec.js (at libfecPrefix + "libfec.js")
        // onReady fires when both emscripten and profiles are loaded.
        Quiet.init({
            profilesPrefix: base,
            memoryInitializerPrefix: base,
            libfecPrefix: base,
            onReady: () => {
                console.log("Quiet.js initialized successfully.");
                resolve();
            },
            onError: (reason: string) => {
                console.error("Quiet.js initialization failed:", reason);
                reject(new Error(`Quiet init failed: ${reason}`));
            },
        });
    });

    return initPromise;
}

/**
 * Wait for Quiet.js to be ready. If already initialized, resolves immediately.
 */
export function initQuiet(): Promise<void> {
    return doInit();
}

// Eagerly start initialization as soon as this module is imported.
// This ensures the profiles prefix is set before quiet-emscripten.js
// finishes loading (which happens asynchronously via the <script async> tag).
doInit().catch((err) => {
    console.error("Early Quiet.js init failed (will retry on first use):", err);
    // Reset so it can be retried on first actual use
    initPromise = null;
});

/** Maximum time (ms) to wait for a single frame transmission to finish.
 *
 * With the 'audible-fsk' profile (50 samples/symbol, FSK8) the effective
 * application-layer throughput is approximately 250 bytes/sec.  A 4096-byte
 * application frame therefore takes roughly 4096 / 250 ≈ 16 s to play out at
 * typical sample rates.  60 s provides a 3.7× safety margin to accommodate
 * slower devices and non-standard sample rates (e.g. 44.1 kHz).
 */
const SEND_TIMEOUT_MS = 60_000;

/**
 * Transmit an ArrayBuffer as audio.
 * Returns a Promise that resolves when onFinish fires (all audio played out).
 * The transmitter handles internal framing — just pass the full data buffer.
 *
 * @param data The data to transmit.
 * @param profile The Quiet.js modem profile to use (defaults to DATA_MODEM_PROFILE).
 *
 * A timeout is applied so that if the AudioContext is permanently suspended
 * (e.g. blocked by the browser's autoplay policy) the caller receives a
 * rejection instead of hanging forever.  Call {@link primeAudio} from a
 * synchronous user-gesture handler before invoking this function to prevent
 * the timeout from triggering.
 */
export async function sendData(data: ArrayBuffer, profile = DATA_MODEM_PROFILE): Promise<void> {
    await initQuiet();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(
                'Transmission timed out: the browser AudioContext may be suspended. ' +
                'Ensure primeAudio() was called synchronously in the click handler ' +
                'before any async operations.',
            ));
        }, SEND_TIMEOUT_MS);

        try {
            const transmitter = Quiet.transmitter({
                profile: profile,
                onFinish: () => {
                    clearTimeout(timeout);
                    console.log('Transmission finished.');
                    transmitter.destroy();
                    resolve();
                },
                clampFrame: false,
            });
            transmitter.transmit(data);
        } catch (err) {
            clearTimeout(timeout);
            reject(err);
        }
    });
}

/**
 * A reusable transmitter session that creates a single `Quiet.transmitter`
 * (and therefore a single `ScriptProcessorNode`) for an entire file transfer,
 * rather than creating and tearing down one per frame.
 *
 * Each `send()` call updates a mutable callback reference that the shared
 * `onFinish` handler delegates to, so the quiet.js transmitter can be reused
 * across multiple sequential `transmit()` invocations without being destroyed
 * and recreated between frames.
 *
 * Usage:
 *   const session = new TransmitterSession();
 *   await session.init();
 *   await session.send(frame1);
 *   await session.send(frame2);
 *   session.destroy();
 */
export class TransmitterSession {
    private transmitter: { transmit: (data: ArrayBuffer) => void; destroy: () => void } | null = null;
    /** Resolves the Promise returned by the current in-flight `send()` call. */
    private onFinishRef: (() => void) | null = null;
    private isDestroyed = false;

    constructor(private readonly profile: string = DATA_MODEM_PROFILE) {}

    /**
     * Initialises Quiet.js and creates the underlying transmitter.
     * Must be called once before any `send()` calls.
     */
    async init(): Promise<void> {
        await initQuiet();
        this.transmitter = Quiet.transmitter({
            profile: this.profile,
            onFinish: () => {
                console.log('Transmission finished.');
                // Delegate to whichever frame's resolve callback is currently set.
                this.onFinishRef?.();
            },
            clampFrame: false,
        });
    }

    /**
     * Transmits `data` as audio and resolves when playback is complete.
     * Calls must be awaited sequentially — do not overlap concurrent sends.
     */
    send(data: ArrayBuffer): Promise<void> {
        return new Promise((resolve, reject) => {
            const transmitter = this.transmitter;
            if (this.isDestroyed || !transmitter) {
                reject(new Error('TransmitterSession has been destroyed'));
                return;
            }

            const timeout = setTimeout(() => {
                this.onFinishRef = null;
                reject(new Error(
                    'Transmission timed out: the browser AudioContext may be suspended. ' +
                    'Ensure primeAudio() was called synchronously in the click handler ' +
                    'before any async operations.',
                ));
            }, SEND_TIMEOUT_MS);

            this.onFinishRef = () => {
                clearTimeout(timeout);
                this.onFinishRef = null;
                resolve();
            };

            try {
                transmitter.transmit(data);
            } catch (err) {
                clearTimeout(timeout);
                this.onFinishRef = null;
                reject(err);
            }
        });
    }

    /**
     * Immediately stops audio playback and releases the `ScriptProcessorNode`.
     * Safe to call multiple times.
     */
    destroy(): void {
        if (!this.isDestroyed) {
            this.isDestroyed = true;
            this.transmitter?.destroy();
            this.transmitter = null;
        }
    }
}

/**
 * Start listening for audio data via the microphone.
 * Returns an AnalyserNode for spectrogram visualization and a `stop` function
 * that tears down the receiver, mic stream, and AudioContext.
 *
 * Call `stop()` as soon as the session is no longer needed to release the
 * ScriptProcessorNode (which runs DSP on the main thread) and the microphone.
 *
 * @param onData Callback invoked with each complete reassembled application frame.
 * @param profile The Quiet.js modem profile to use (defaults to DATA_MODEM_PROFILE).
 *
 * Quiet.js delivers `onReceive` callbacks once per PHY-layer acoustic frame
 * (~20–25 bytes).  Internally this function uses a `StreamBuffer` to
 * accumulate those chunks and only invokes `onData` when a complete
 * application frame (identified by the 2-byte length prefix written by
 * `createFrame`) has been fully received.  Corrupted or partial frames are
 * silently discarded so that the next retransmit starts with a clean buffer.
 */
export async function startListening(
    onData: (data: ArrayBuffer) => void,
    profile = DATA_MODEM_PROFILE,
): Promise<{ analyser: AnalyserNode; stop: () => void }> {
    await initQuiet();

    // Ensure quiet.js can call getUserMedia on modern Chrome (74+) where the
    // legacy callback-based navigator.getUserMedia has been removed.
    polyfillGetUserMedia();

    // Create our own AudioContext for the spectrogram analyser.
    // Quiet.js creates its own internal AudioContext for the receiver,
    // so we run a parallel analyser on the raw mic stream for visualization.
    const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // Fire-and-forget resume: after primeAudio() has been called from a user
    // gesture, this will succeed quickly without blocking.  We still keep it
    // fire-and-forget so a slow/blocked resume does not stall the call chain.
    audioCtx.resume().catch(err => console.warn('AudioContext resume warning:', err));

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);

    const streamBuf = new StreamBuffer();

    // Create the Quiet receiver. It will call getUserMedia internally as well.
    // Both our analyser and Quiet's receiver will process the mic stream.
    // Wrap in a Promise so that a receiver-creation failure rejects the caller.
    let quietReceiver: { destroy: () => void } | null = null;
    await new Promise<void>((resolve, reject) => {
        quietReceiver = Quiet.receiver({
            profile: profile,
            onReceive: (chunk: ArrayBuffer) => {
                streamBuf.append(chunk);

                // Drain all complete application frames from the buffer.
                let frame: ArrayBuffer | null;
                while ((frame = streamBuf.tryExtract()) !== null) {
                    try {
                        onData(frame);
                    } catch (err) {
                        // A bad frame (CRC mismatch, malformed JSON, etc.) must not
                        // corrupt subsequent frames.  Log and continue draining.
                        console.warn('StreamBuffer: discarding malformed application frame:', err);
                    }
                }
            },
            onCreate: () => {
                console.log('Quiet receiver created and listening.');
                // Clear any leftover bytes from a previous session so the first
                // incoming transmission starts with a clean slate.
                streamBuf.clear();
                resolve();
            },
            onCreateFail: (reason: string) => {
                console.error('Failed to create receiver:', reason);
                reject(new Error(`Quiet receiver creation failed: ${reason}`));
            },
            onReceiveFail: (num_fails: number) => {
                console.warn(`Receive checksum failures: ${num_fails}`);
            },
        });
    });

    /**
     * Tears down the Quiet receiver, stops the microphone stream, and closes
     * the local AudioContext.  Call this as soon as listening is no longer
     * needed so that the ScriptProcessorNode (which runs Emscripten DSP on the
     * main thread) is released promptly.
     */
    const stop = () => {
        quietReceiver?.destroy();
        quietReceiver = null;
        stream.getTracks().forEach(track => track.stop());
        audioCtx.close().catch(() => {});
    };

    return { analyser, stop };
}
