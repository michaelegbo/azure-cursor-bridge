// App-wide preferences shared by the Electron app and the proxy. Stored in the
// SQLite settings table under 'app-settings'; anything missing or invalid falls
// back to these defaults, so a fresh install works with no configuration.
export const APP_DEFAULTS = Object.freeze({
  // 'auto' = the user's own Cloudflare tunnel when one is configured, else a
  // temporary public URL. 'named' / 'quick' / 'off' force one choice.
  tunnelMode: 'auto',
  // If the user's tunnel fails, publish a temporary public URL instead.
  tunnelFallback: true,
  analyzerModel: 'azure-astra',
  claudeCliPath: '',
  codexCliPath: '',
  requestHistoryLimit: 500,
  breakdownLimit: 60,
  // Bloat remover: 'off' | 'small' | 'medium' | 'high' | 'aggressive' | 'deep'.
  bloatLevel: 'off',
  // The model that writes 'deep' summaries; a small, fast one is best.
  bloatModel: 'bridge-claude-haiku',
});
export const BLOAT_LEVEL_IDS = ['off', 'small', 'medium', 'high', 'aggressive', 'deep'];

export const TUNNEL_MODES = ['auto', 'named', 'quick', 'off'];
const intIn = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
const pathOrEmpty = v => (typeof v === 'string' && v.length <= 1024 && !/[\0\r\n]/.test(v) ? v.trim() : '');

export function normalizeAppSettings(raw = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    tunnelMode: TUNNEL_MODES.includes(s.tunnelMode) ? s.tunnelMode : APP_DEFAULTS.tunnelMode,
    tunnelFallback: typeof s.tunnelFallback === 'boolean' ? s.tunnelFallback : APP_DEFAULTS.tunnelFallback,
    analyzerModel: typeof s.analyzerModel === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(s.analyzerModel) ? s.analyzerModel : APP_DEFAULTS.analyzerModel,
    claudeCliPath: pathOrEmpty(s.claudeCliPath),
    codexCliPath: pathOrEmpty(s.codexCliPath),
    requestHistoryLimit: intIn(s.requestHistoryLimit, 50, 10000, APP_DEFAULTS.requestHistoryLimit),
    breakdownLimit: intIn(s.breakdownLimit, 10, 1000, APP_DEFAULTS.breakdownLimit),
    bloatLevel: BLOAT_LEVEL_IDS.includes(s.bloatLevel) ? s.bloatLevel : APP_DEFAULTS.bloatLevel,
    bloatModel: typeof s.bloatModel === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(s.bloatModel) ? s.bloatModel : APP_DEFAULTS.bloatModel,
  };
}

export function appSettings(db) {
  try { return normalizeAppSettings(db.settingGet('app-settings') || {}); } catch { return normalizeAppSettings(); }
}

// Models a fresh install starts with (and "reset models to defaults" restores):
// they only need a Claude or ChatGPT login, no Azure deployment.
export const DEFAULT_CUSTOM_MODELS = Object.freeze([
  { id: 'bridge-claude-fable', deployment: 'claude-fable-5-1', label: 'Claude · Fable 5.1', protocol: 'claude-cli', contextWindow: 200000, maxOutputTokens: 64000, tokensPerMinute: 0, defaultEffort: 'high' },
  { id: 'bridge-claude-opus', deployment: 'claude-opus-5-5', label: 'Claude · Opus 5.5', protocol: 'claude-cli', contextWindow: 500000, maxOutputTokens: 64000, tokensPerMinute: 0, defaultEffort: 'high' },
  { id: 'bridge-claude-sonnet', deployment: 'claude-sonnet-5', label: 'Claude · Sonnet 5', protocol: 'claude-cli', contextWindow: 200000, maxOutputTokens: 64000, tokensPerMinute: 0, defaultEffort: 'medium' },
  { id: 'bridge-claude-haiku', deployment: 'claude-haiku-4-5-20251001', label: 'Claude · Haiku 4.5', protocol: 'claude-cli', contextWindow: 200000, maxOutputTokens: 64000, tokensPerMinute: 0, defaultEffort: 'medium' },
  ...[
    ['astra', 'gpt-6-astra', 'GPT-6 Astra'], ['sol', 'gpt-6-sol', 'GPT-6 Sol'], ['luna', 'gpt-6-luna', 'GPT-6 Luna'],
    ['5-6-sol', 'gpt-5.6-sol', 'GPT-5.6 Sol'], ['5-6-terra', 'gpt-5.6-terra', 'GPT-5.6 Terra'], ['5-6-luna', 'gpt-5.6-luna', 'GPT-5.6 Luna'],
    ['5-5', 'gpt-5.5', 'GPT-5.5'],
  ].map(([id, deployment, name]) => ({ id: `bridge-chatgpt-${id}`, deployment, label: `ChatGPT · ${name}`, protocol: 'chatgpt', contextWindow: 272000, maxOutputTokens: 128000, tokensPerMinute: 0, defaultEffort: 'medium', fast: false })),
].map(m => Object.freeze(m)));
