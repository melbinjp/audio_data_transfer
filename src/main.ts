import { initializeSender } from './ui/sender';
import { initializeReceiver } from './ui/receiver';

console.log("Data Over Audio app is running!");

document.addEventListener('DOMContentLoaded', () => {
    initializeSender();
    initializeReceiver();
});
