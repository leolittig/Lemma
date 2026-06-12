// All user settings in one hook, each persisted to localStorage so it
// survives reloads. To add a new setting: add a usePersistentState line with
// the right load/save pair, return it from the hook, and wire it into
// SettingsModal.jsx (or wherever its control lives).

import { usePersistentState } from './usePersistentState';
import {
  CTX_STEPS, CTX_DEFAULT_INDEX,
  MAX_TOKENS_STEPS, MAX_TOKENS_DEFAULT_INDEX,
} from '../constants';

// load/save pairs for usePersistentState. Defined at module level so their
// identity is stable across renders.
const asString = (fallback) => (stored) => (stored !== null ? stored : fallback);
const saveString = (value) => value;
// Empty string means "unset": the key is removed rather than stored.
const saveStringOrUnset = (value) => (value === '' ? null : value);
const loadFloat = (fallback) => (stored) => (stored !== null ? parseFloat(stored) : fallback);
const saveFloat = (value) => String(value);
const loadBool = (defaultValue) => (stored) =>
  (defaultValue ? stored !== '0' : stored === '1');
const saveBool = (value) => (value ? '1' : '0');

export function useSettings() {
  // The default "Instructions" (system prompt). Seeds new chats — it is sent
  // along when a conversation is created — and survives reloads.
  const [systemPrompt, setSystemPrompt] = usePersistentState(
    'system_prompt', asString(''), saveString);

  // Generation params sent with each /chat message. Temperature defaults to
  // 1.0; the token counts are strings ('' = unlimited) so fields can be
  // cleared.
  const [temperature, setTemperature] = usePersistentState(
    'temperature', loadFloat(1.0), saveFloat);
  const [contextSize, setContextSize] = usePersistentState(
    'context_size', asString(String(CTX_STEPS[CTX_DEFAULT_INDEX])), saveStringOrUnset);
  const [maxTokens, setMaxTokens] = usePersistentState(
    'max_tokens', asString(String(MAX_TOKENS_STEPS[MAX_TOKENS_DEFAULT_INDEX])), saveStringOrUnset);

  // Whether the model's reasoning phase is enabled (sent as enable_thinking).
  const [thinkingEnabled, setThinkingEnabled] = usePersistentState(
    'thinking_enabled', loadBool(true), saveBool);

  // Smart context window: head/middle/tail bands when on, a plain recency cut
  // (keep the most recent messages that fit) when off.
  const [smartContext, setSmartContext] = usePersistentState(
    'smart_context', loadBool(true), saveBool);

  // UI preference: whether the conversation sidebar is collapsed.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(
    'sidebar_collapsed', loadBool(false), saveBool);

  // Whether the brain memory feature is enabled.
  const [brainEnabled, setBrainEnabled] = usePersistentState(
    'brain_enabled', loadBool(true), saveBool);

  // UI preference: whether memory logs in the explorer are detailed or simplified.
  const [detailedLogs, setDetailedLogs] = usePersistentState(
    'detailed_logs', loadBool(false), saveBool);

  return {
    systemPrompt, setSystemPrompt,
    temperature, setTemperature,
    contextSize, setContextSize,
    maxTokens, setMaxTokens,
    thinkingEnabled, setThinkingEnabled,
    smartContext, setSmartContext,
    sidebarCollapsed, setSidebarCollapsed,
    brainEnabled, setBrainEnabled,
    detailedLogs, setDetailedLogs,
  };
}
