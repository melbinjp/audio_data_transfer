import { initializeSender } from './ui/sender';
import { initializeReceiver } from './ui/receiver';
import { initializeAcousticProfileUi } from './ui/acoustic-profile';
import { formatAppVersion } from './version';

console.log("Data Over Audio app is running!");

document.addEventListener('DOMContentLoaded', () => {
    const versionEl = document.getElementById('app-version');
    if (versionEl) {
        versionEl.textContent = formatAppVersion();
    }
    initializeAcousticProfileUi();
    initializeSender();
    initializeReceiver();
});
