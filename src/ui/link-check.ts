import { startListening, TransmitterSession, DATA_CHANNEL, ACK_CHANNEL } from '../dsp/fsk-modem';
import { createProbeFrame, getAckToken, parseCompactAck } from '../transport/framing';
import type { AcousticProfile } from './acoustic-profile';

const LINK_CHECK_BACKOFF_MS = 700;

export async function runAcousticLinkCheck(
    profile: AcousticProfile,
    onStatus: (message: string) => void,
): Promise<boolean> {
    const probeId = crypto.randomUUID();
    const token = getAckToken(probeId);
    const tx = new TransmitterSession(DATA_CHANNEL, profile.sender.transmitter);
    let stopAckListener: (() => void) | null = null;
    let pendingAck: ((ok: boolean) => void) | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPendingAck = () => {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingAck = null;
    };

    const waitForProbeAck = (): Promise<boolean> =>
        new Promise(resolve => {
            clearPendingAck();
            pendingAck = resolve;
            pendingTimer = setTimeout(() => {
                clearPendingAck();
                resolve(false);
            }, profile.sender.ackTimeoutMs);
        });

    try {
        onStatus('Opening speaker and microphone...');
        await tx.init();
        const { stop } = await startListening((rawFrame) => {
            const ack = parseCompactAck(rawFrame);
            if (ack?.type === 'probe-ack' && ack.token === token && pendingAck) {
                const resolve = pendingAck;
                clearPendingAck();
                resolve(true);
            }
        }, ACK_CHANNEL, profile.sender.ackListen);
        stopAckListener = stop;

        if (profile.sender.listenerSettleMs > 0) {
            onStatus('Syncing microphone...');
            await new Promise<void>(r => setTimeout(r, profile.sender.listenerSettleMs));
        }

        const probeFrame = createProbeFrame(probeId);
        for (let attempt = 0; attempt < profile.sender.linkCheckRetries; attempt++) {
            onStatus(
                attempt === 0
                    ? 'Playing link check tone...'
                    : `Repeating link check (${attempt + 1}/${profile.sender.linkCheckRetries})...`,
            );
            const ackPromise = waitForProbeAck();
            await tx.send(probeFrame);
            onStatus('Waiting for receiver confirmation...');
            if (await ackPromise) {
                onStatus('Link ready.');
                return true;
            }
            if (attempt < profile.sender.linkCheckRetries - 1) {
                await new Promise<void>(r => setTimeout(r, LINK_CHECK_BACKOFF_MS));
            }
        }

        onStatus('No confirmation heard.');
        return false;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onStatus(`Link check error: ${msg}`);
        return false;
    } finally {
        clearPendingAck();
        tx.destroy();
        stopAckListener?.();
    }
}
