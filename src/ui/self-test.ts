import { startListening, TransmitterSession, DATA_CHANNEL, ACK_CHANNEL, type ChannelConfig } from '../dsp/fsk-modem';
import { createProbeFrame, deframe } from '../transport/framing';
import {
    ACOUSTIC_SETTINGS,
    SignalQualityMeter,
    formatQuality,
    type AcousticSettings,
    type QualitySummary,
} from './acoustic-settings';

export interface LocalSelfTestResult {
    ok: boolean;
    dataTone: QualitySummary;
    ackTone: QualitySummary;
}

let localSelfTestPassed = false;

export function hasLocalSelfTestPassed(): boolean {
    return localSelfTestPassed;
}

export function resetLocalSelfTest(): void {
    localSelfTestPassed = false;
}

export async function runLocalSelfTest(
    settings: AcousticSettings,
    onStatus: (message: string) => void,
): Promise<LocalSelfTestResult> {
    onStatus('Testing this device speaker and microphone...');
    const dataTone = await testOneChannel('data', DATA_CHANNEL, settings.sender.transmitter, settings.receiver.listen, onStatus);
    const ackTone = await testOneChannel('ack', ACK_CHANNEL, settings.receiver.ackTransmitter, settings.sender.ackListen, onStatus);
    const ok = dataTone.score >= settings.minQuality && ackTone.score >= settings.minQuality;
    localSelfTestPassed = ok;
    onStatus(`Data tone ${formatQuality(dataTone)}, ACK tone ${formatQuality(ackTone)}${ok ? ' - ready' : ' - weak'}.`);
    return { ok, dataTone, ackTone };
}

export function runDefaultLocalSelfTest(onStatus: (message: string) => void): Promise<LocalSelfTestResult> {
    return runLocalSelfTest(ACOUSTIC_SETTINGS, onStatus);
}

async function testOneChannel(
    label: 'data' | 'ack',
    channel: ChannelConfig,
    transmitterOptions: AcousticSettings['sender']['transmitter'],
    listenOptions: AcousticSettings['sender']['ackListen'],
    onStatus: (message: string) => void,
): Promise<QualitySummary> {
    const probeId = crypto.randomUUID();
    const meter = new SignalQualityMeter();
    const tx = new TransmitterSession(channel, transmitterOptions);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveHeard: (heard: boolean) => void = () => {};
    const heard = new Promise<boolean>(resolve => {
        resolveHeard = resolve;
    });
    const listener = await startListening((frame) => {
        try {
            const { header } = deframe(frame);
            if (header.type === 'probe' && header.fileId === probeId) {
                if (timer) clearTimeout(timer);
                resolveHeard(true);
            }
        } catch {
            // Ignore noise frames during self-test.
        }
    }, channel, {
        ...listenOptions,
        onSignal: signal => meter.add(signal),
    });

    try {
        await tx.init();
        await new Promise<void>(r => setTimeout(r, ACOUSTIC_SETTINGS.sender.listenerSettleMs));
        onStatus(`Playing ${label.toUpperCase()} tone locally...`);
        timer = setTimeout(() => resolveHeard(false), ACOUSTIC_SETTINGS.sender.ackTimeoutMs);
        await tx.send(createProbeFrame(probeId));
        await heard;
        return meter.summarize();
    } finally {
        if (timer) clearTimeout(timer);
        tx.destroy();
        listener.stop();
    }
}
