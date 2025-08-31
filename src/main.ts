import { initializeSender } from './ui/sender';
import { initializeReceiver } from './ui/receiver';
import { initializeChat } from './ui/chat';

console.log("Data Over Audio app is running!");

document.addEventListener('DOMContentLoaded', () => {
    const fileMode = document.getElementById('file-transfer-mode')!;
    const chatMode = document.getElementById('chat-mode')!;
    const modeFileButton = document.getElementById('mode-file')!;
    const modeChatButton = document.getElementById('mode-chat')!;

    initializeSender();
    initializeReceiver();
    initializeChat();

    modeFileButton.addEventListener('click', () => {
        fileMode.style.display = 'block';
        chatMode.style.display = 'none';
    });

    modeChatButton.addEventListener('click', () => {
        fileMode.style.display = 'none';
        chatMode.style.display = 'block';
    });
});
