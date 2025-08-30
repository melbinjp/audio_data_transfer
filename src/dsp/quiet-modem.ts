let isQuietInitialized = false;

function stringToArrayBuffer(str: string): ArrayBuffer {
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0; i < str.length; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
}

function arrayBufferToString(buf: ArrayBuffer): string {
    return String.fromCharCode.apply(null, Array.from(new Uint8Array(buf)));
}

export function initQuiet(): Promise<void> {
    if (isQuietInitialized) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        Quiet.addReadyCallback(async () => {
            try {
                // quiet-js-profiles.json should be served from the public directory
                const response = await fetch('quiet-js-profiles.json');
                if (!response.ok) {
                    throw new Error(`Failed to fetch profiles: ${response.statusText}`);
                }
                const profiles = await response.json();
                Quiet.init({ profiles, onInitialized: () => {
                    isQuietInitialized = true;
                    resolve();
                } });
            } catch (error) {
                reject(error);
            }
        }, (reason) => reject(reason));
    });
}

export async function sendData(data: ArrayBuffer) {
    await initQuiet();
    const transmitter = Quiet.transmitter({
        profile: 'ultrasonic-fsk', // A robust default profile
        onFinish: () => {
            console.log('Transmission finished.');
            // The transmitter is destroyed by the caller
        },
    });
    transmitter.transmit(data);
    return transmitter;
}

export async function startListening(onData: (data: ArrayBuffer) => void): Promise<{ analyser: AnalyserNode }> {
    await initQuiet();

    // The Quiet receiver function in the original library is complex and
    // doesn't directly expose the AudioNode for us to connect an analyser.
    // The library creates its own audio context and graph internally.
    // To implement a spectrogram, we need to get access to the raw microphone stream
    // before it goes into the Quiet receiver.

    // We will create our own AudioContext and connect the microphone stream to both
    // the Quiet receiver and our AnalyserNode. This is a common pattern for
    // visualization when working with black-box audio libraries.

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    await audioCtx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(stream);

    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);

    // Now, we need to pass this stream to Quiet.js.
    // The `Quiet.receiver` function doesn't take a stream as an argument.
    // This is a limitation of the library as used.
    // However, Quiet.js internally calls getUserMedia. If we call it before
    // quiet.js, it might reuse the existing permission and stream.
    // The visualization will work, but it will be on a parallel path to Quiet's processing.

    Quiet.receiver({
        profile: 'ultrasonic-fsk',
        onReceive: (payload) => {
            onData(payload);
        },
        onCreateFailed: (reason) => {
            console.error('Failed to create receiver:', reason);
        },
        onReceiveFailed: (num_fails) => {
            console.error(`Receive failed after ${num_fails} attempts.`);
        },
    });

    return { analyser };
}
