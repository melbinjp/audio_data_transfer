import { createChatEnvelope } from '../transport/framing';
import { sendData } from '../dsp/quiet-modem';

const CHAT_HISTORY_KEY = 'chat-history';

interface ChatMessage {
    id: number;
    text: string;
    sender: 'me' | 'other';
}

let chatMessagesEl: HTMLElement;
let chatHistory: ChatMessage[] = [];

function saveChatHistory() {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatHistory));
}

function loadChatHistory() {
    const saved = localStorage.getItem(CHAT_HISTORY_KEY);
    if (saved) {
        chatHistory = JSON.parse(saved);
        chatHistory.forEach(msg => renderMessage(msg));
    }
}

function deleteMessage(id: number) {
    chatHistory = chatHistory.filter(msg => msg.id !== id);
    saveChatHistory();
    const msgEl = document.getElementById(`msg-${id}`);
    if (msgEl) {
        msgEl.remove();
    }
}

function renderMessage(message: ChatMessage) {
    const msgContainer = document.createElement('div');
    msgContainer.id = `msg-${message.id}`;
    msgContainer.style.textAlign = message.sender === 'me' ? 'right' : 'left';

    const msgBubble = document.createElement('span');
    msgBubble.textContent = message.text;
    msgBubble.style.backgroundColor = message.sender === 'me' ? '#dcf8c6' : '#fff';
    msgBubble.style.padding = '5px 10px';
    msgBubble.style.borderRadius = '7px';
    msgContainer.appendChild(msgBubble);

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'x';
    deleteButton.style.marginLeft = '5px';
    deleteButton.onclick = () => deleteMessage(message.id);
    msgContainer.appendChild(deleteButton);

    chatMessagesEl.appendChild(msgContainer);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function addMessage(text: string, sender: 'me' | 'other') {
    const message: ChatMessage = {
        id: Date.now(),
        text,
        sender,
    };
    chatHistory.push(message);
    saveChatHistory();
    renderMessage(message);
}

export function displayChatMessage(text: string) {
    addMessage(text, 'other');
}

export function initializeChat() {
    const chatInput = document.getElementById('chat-input') as HTMLInputElement;
    const chatSendButton = document.getElementById('chat-send-button') as HTMLButtonElement;
    chatMessagesEl = document.getElementById('chat-messages')!;

    loadChatHistory();

    const sendMessage = async () => {
        const text = chatInput.value;
        if (!text) return;

        addMessage(text, 'me');
        chatInput.value = '';

        try {
            // Create a chat envelope and transmit via audio
            const envelope = createChatEnvelope(text);
            await sendData(envelope);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('Chat send error:', msg);
        }
    };

    chatSendButton.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
}
