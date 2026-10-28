// Every assumption about ChatGPT's page structure lives here. When ChatGPT
// changes its interface, this is the file to update. Each list is tried in
// order; any match counts. If none of the composer selectors match, the page
// status is reported as "unknown" rather than guessed.

export interface SelectorConfig {
  /** The message input. */
  composer: string[];
  /** The control that stops a response while it is generating. */
  stopControl: string[];
  /** The send control (present when idle; never clicked by the extension). */
  sendControl: string[];
  /** Markers that a response is still streaming. */
  streamingMarker: string[];
  /** Rendered assistant messages. Only their count and id attribute are read, never their text. */
  assistantMessage: string[];
  /** Attribute holding a stable id on assistant messages. */
  messageIdAttribute: string;
  /** Regions where ChatGPT shows errors and limit notices. Text inside conversation messages is excluded. */
  noticeRegion: string[];
  /** Any element matching this is a conversation message; notices inside it are ignored. */
  messageContainer: string;
}

export const DEFAULT_SELECTORS: SelectorConfig = {
  composer: [
    '#prompt-textarea',
    'textarea[name="prompt-textarea"]',
    'form [contenteditable="true"][role="textbox"]',
    'form textarea',
  ],
  stopControl: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop answering"]',
  ],
  sendControl: [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
  ],
  streamingMarker: ['.result-streaming', '[data-testid="streaming-indicator"]'],
  assistantMessage: ['[data-message-author-role="assistant"]'],
  messageIdAttribute: 'data-message-id',
  noticeRegion: [
    '[role="alert"]',
    '[role="status"]',
    '[data-testid*="toast"]',
    '[data-testid*="error"]',
    '[data-testid*="limit"]',
    '.text-token-text-error',
    '[class*="border-token-surface-error"]',
  ],
  messageContainer: '[data-message-author-role]',
};

// Patterns are matched against short notice texts only; the text is discarded right away.
export const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /you(?:'|’)ve (?:hit|reached) (?:the|your|our)\b[^.]{0,80}\blimit/i,
  /\busage (?:limit|cap)\b/i,
  /\blimit (?:resets|will reset)\b/i,
  /\btoo many requests\b/i,
  /\brate limit/i,
  /\bmessage cap\b/i,
];

export const ERROR_PATTERNS: RegExp[] = [
  /\bsomething went wrong\b/i,
  /\bthere was an error\b/i,
  /\berror (?:generating|in message stream|occurred)\b/i,
  /\bnetwork error\b/i,
  /\bunable to (?:load|generate)\b/i,
  /\brequest failed\b/i,
  /\bconversation not found\b/i,
];
