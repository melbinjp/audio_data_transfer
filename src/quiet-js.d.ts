/**
 * Type declarations for quiet-js (loaded via <script> tag as global `Quiet`).
 * Based on the actual quiet.js source code API.
 */
declare var Quiet: {
    /**
     * Initialize Quiet with paths to its required static assets.
     * This triggers loading of profiles and memory initializer.
     */
    init(options: {
        profilesPrefix?: string;
        memoryInitializerPrefix?: string;
        libfecPrefix?: string;
        onReady?: () => void;
        onError?: (reason: string) => void;
    }): void;

    /**
     * Register a callback for when Quiet is ready (profiles + emscripten loaded).
     * If already ready, callback fires immediately.
     */
    addReadyCallback(callback: () => void, onError?: (reason: string) => void): void;

    /**
     * Create a transmitter that encodes data into audio.
     */
    transmitter(options: {
        profile: string | object;
        onFinish?: () => void;
        onEnqueue?: () => void;
        clampFrame?: boolean;
    }): {
        transmit: (data: ArrayBuffer) => void;
        destroy: () => void;
        frameLength: number;
        getAverageEncodeTime: () => number;
        getProfile: () => object;
    };

    /**
     * Create a receiver that decodes audio from the microphone.
     */
    receiver(options: {
        profile: string | object;
        onReceive: (payload: ArrayBuffer) => void;
        onCreate?: () => void;
        onCreateFail?: (reason: string) => void;
        onReceiveFail?: (num_fails: number) => void;
    }): {
        destroy: () => void;
    };

    /**
     * Convert a string to an ArrayBuffer.
     */
    str2ab?(str: string): ArrayBuffer;

    /**
     * Convert an ArrayBuffer to a string.
     */
    ab2str?(buf: ArrayBuffer): string;
};
