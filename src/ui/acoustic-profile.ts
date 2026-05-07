import type { StartListeningOptions, TransmitterOptions } from '../dsp/fsk-modem';

export type AcousticProfileId = 'balanced' | 'phone-reliable';

export interface AcousticProfile {
    id: AcousticProfileId;
    label: string;
    description: string;
    sender: {
        ackTimeoutMs: number;
        listenerSettleMs: number;
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

export const ACOUSTIC_PROFILES: Record<AcousticProfileId, AcousticProfile> = {
    balanced: {
        id: 'balanced',
        label: 'Balanced',
        description: 'Shorter frames and normal thresholds for nearby laptops.',
        sender: {
            ackTimeoutMs: 12000,
            listenerSettleMs: 250,
            retryBaseDelayMs: 500,
            maxRetries: 5,
            maxHandshakeRetries: -1,
            postAckGuardMs: 400,
            transmitter: { gain: 0.9 },
            ackListen: { silenceThreshold: 0.004, toneDominanceRatio: 0.38 },
        },
        receiver: {
            ackTurnaroundMs: 250,
            ackRepeatCount: 2,
            ackRepeatGapMs: 120,
            listen: { silenceThreshold: 0.004, toneDominanceRatio: 0.38 },
            ackTransmitter: { gain: 1 },
        },
    },
    'phone-reliable': {
        id: 'phone-reliable',
        label: 'Phone reliable',
        description: 'Longer waits and more sensitive detection for phone speaker/mic ACKs.',
        sender: {
            ackTimeoutMs: 18000,
            listenerSettleMs: 700,
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
    },
};

export function getSelectedAcousticProfile(): AcousticProfile {
    const el = document.getElementById('acoustic-profile') as HTMLSelectElement | null;
    const id = el?.value as AcousticProfileId | undefined;
    return id && ACOUSTIC_PROFILES[id] ? ACOUSTIC_PROFILES[id] : ACOUSTIC_PROFILES['phone-reliable'];
}

export function initializeAcousticProfileUi(): void {
    const select = document.getElementById('acoustic-profile') as HTMLSelectElement | null;
    const description = document.getElementById('acoustic-profile-description');
    if (!select) return;

    const stored = localStorage.getItem('acousticProfile') as AcousticProfileId | null;
    if (stored && ACOUSTIC_PROFILES[stored]) {
        select.value = stored;
    } else {
        select.value = 'phone-reliable';
    }

    const updateDescription = () => {
        const profile = getSelectedAcousticProfile();
        if (description) {
            description.textContent = profile.description;
        }
        localStorage.setItem('acousticProfile', profile.id);
    };

    select.addEventListener('change', updateDescription);
    updateDescription();
}
