import type { FskSignal, StartListeningOptions, TransmitterOptions } from '../dsp/fsk-modem';

export interface AcousticSettings {
    minQuality: number;
    sender: {
        ackTimeoutMs: number;
        listenerSettleMs: number;
        linkCheckRetries: number;
        retryBaseDelayMs: number;
        maxRetries: number;
        maxHandshakeRetries: number;
        postAckGuardMs: number;
        transmitter: TransmitterOptions;
        ackListen: StartListeningOptions;
    };
    receiver: {
        ackTurnaroundMs: number;
        ackRepeatCount: number;
        ackRepeatGapMs: number;
        listen: StartListeningOptions;
        ackTransmitter: TransmitterOptions;
    };
}

export const ACOUSTIC_SETTINGS: AcousticSettings = {
    minQuality: 55,
    sender: {
        ackTimeoutMs: 18000,
        listenerSettleMs: 700,
        linkCheckRetries: 4,
        retryBaseDelayMs: 800,
        maxRetries: 8,
        maxHandshakeRetries: -1,
        postAckGuardMs: 900,
        transmitter: { gain: 0.95 },
        ackListen: { silenceThreshold: 0.0025, toneDominanceRatio: 0.32 },
    },
    receiver: {
        ackTurnaroundMs: 500,
        ackRepeatCount: 3,
        ackRepeatGapMs: 180,
        listen: { silenceThreshold: 0.0025, toneDominanceRatio: 0.32 },
        ackTransmitter: { gain: 1 },
    },
};

export interface QualitySummary {
    score: number;
    avgDominance: number;
    avgRms: number;
    samples: number;
}

export class SignalQualityMeter {
    private readonly samples: FskSignal[] = [];

    constructor(private readonly maxSamples = 180) {}

    add(signal: FskSignal): void {
        if (signal.toneIndex < 0) return;
        this.samples.push(signal);
        if (this.samples.length > this.maxSamples) {
            this.samples.shift();
        }
    }

    reset(): void {
        this.samples.length = 0;
    }

    summarize(): QualitySummary {
        if (this.samples.length === 0) {
            return { score: 0, avgDominance: 0, avgRms: 0, samples: 0 };
        }

        const total = this.samples.reduce(
            (acc, signal) => {
                acc.dominance += signal.dominance;
                acc.rms += signal.rms;
                return acc;
            },
            { dominance: 0, rms: 0 },
        );
        const avgDominance = total.dominance / this.samples.length;
        const avgRms = total.rms / this.samples.length;
        const dominanceScore = clamp01((avgDominance - 0.3) / 0.5) * 75;
        const levelScore = clamp01(avgRms / 0.06) * 25;
        return {
            score: Math.round(dominanceScore + levelScore),
            avgDominance,
            avgRms,
            samples: this.samples.length,
        };
    }
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function formatQuality(summary: QualitySummary): string {
    return `${summary.score}/100`;
}
