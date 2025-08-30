declare var Quiet: {
    init(options: {
        profiles: { [key: string]: any };
        memorySize?: number;
        onInitialized: () => void;
        onInitFailed?: (reason: any) => void;
    }): void;

    transmitter(options: {
        profile: string;
        onFinish?: () => void;
        clampFrame?: boolean;
    }): {
        transmit: (data: ArrayBuffer) => void;
        destroy: () => void;
    };

    receiver(options: {
        profile: string;
        onReceive: (payload: ArrayBuffer) => void;
        onCreate?: () => void;
        onCreateFailed?: (reason: any) => void;
        onReceiveFailed?: (num_fails: number) => void;
    }): {
        destroy: () => void;
    };

    addReadyCallback(callback: () => void, onError?: (reason: any) => void): void;
};
