let initPromise: Promise<void> | null = null;

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
                profile: 'audible',
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
 * The onData callback fires for each received frame from Quiet.
 */
export async function startListening(onData: (data: ArrayBuffer) => void): Promise<{ analyser: AnalyserNode }> {
    await initQuiet();

    // Create our own AudioContext for the spectrogram analyser.
    // Quiet.js creates its own internal AudioContext for the receiver,
    // so we run a parallel analyser on the raw mic stream for visualization.
    const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    await audioCtx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);

    // Create the Quiet receiver. It will call getUserMedia internally as well.
    // Both our analyser and Quiet's receiver will process the mic stream.
    Quiet.receiver({
        profile: 'audible',
        onReceive: (payload) => {
            onData(payload);
        },
        onCreate: () => {
            console.log('Quiet receiver created and listening.');
        },
        onCreateFail: (reason) => {
            console.error('Failed to create receiver:', reason);
        },
        onReceiveFail: (num_fails) => {
            console.warn(`Receive checksum failures: ${num_fails}`);
        },
    });

    return { analyser };
}
