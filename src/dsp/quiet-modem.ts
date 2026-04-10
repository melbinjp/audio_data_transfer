let initPromise: Promise<void> | null = null;

/**
 * Profile used for all transmit/receive operations.
 *
 * 'audible-fsk-robust' uses FSK8 modulation with a v29 convolutional outer FEC,
 * centred at 8 kHz.  FSK is more tolerant of amplitude variations (different
 * speaker/microphone gains) than GMSK, making it better suited for real-world
 * device-to-device transfers across an air gap.
 */
const MODEM_PROFILE = 'audible-fsk-robust';

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

/**
 * Transmit an ArrayBuffer as audio.
 * Returns a Promise that resolves when onFinish fires (all audio played out).
 * The transmitter handles internal framing — just pass the full data buffer.
 */
export async function sendData(data: ArrayBuffer): Promise<void> {
    await initQuiet();
    return new Promise((resolve, reject) => {
        try {
            const transmitter = Quiet.transmitter({
                profile: MODEM_PROFILE,
                onFinish: () => {
                    console.log('Transmission finished.');
                    transmitter.destroy();
                    resolve();
                },
                clampFrame: true,
            });
            transmitter.transmit(data);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Start listening for audio data via the microphone.
 * Returns an AnalyserNode for spectrogram visualization.
 *
 * Quiet.js delivers `onReceive` callbacks once per PHY-layer acoustic frame
 * (~20–25 bytes).  Internally this function uses a `StreamBuffer` to
 * accumulate those chunks and only invokes `onData` when a complete
 * application frame (identified by the 2-byte length prefix written by
 * `createFrame`) has been fully received.  Corrupted or partial frames are
 * silently discarded so that the next retransmit starts with a clean buffer.
 */
export async function startListening(onData: (data: ArrayBuffer) => void): Promise<{ analyser: AnalyserNode }> {
    await initQuiet();

    // Create our own AudioContext for the spectrogram analyser.
    // Quiet.js creates its own internal AudioContext for the receiver,
    // so we run a parallel analyser on the raw mic stream for visualization.
    const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // Fire-and-forget: don't await resume() here. When called from an async
    // chain that is no longer within a synchronous user-gesture frame (e.g.
    // the sender's startAckListener, which runs after await file.arrayBuffer()),
    // Chrome's autoplay policy may keep the promise pending indefinitely,
    // stalling the entire send flow at "Preparing to send".  The analyser
    // will start providing data once the context resumes on its own.
    audioCtx.resume().catch(err => console.warn('AudioContext resume warning:', err));

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);

    const streamBuf = new StreamBuffer();

    // Create the Quiet receiver. It will call getUserMedia internally as well.
    // Both our analyser and Quiet's receiver will process the mic stream.
    Quiet.receiver({
        profile: MODEM_PROFILE,
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
        },
        onCreateFail: (reason: string) => {
            console.error('Failed to create receiver:', reason);
        },
        onReceiveFail: (num_fails: number) => {
            console.warn(`Receive checksum failures: ${num_fails}`);
        },
    });

    return { analyser };
}
