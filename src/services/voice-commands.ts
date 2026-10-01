/**
 * Voice control of the app's own buttons: say the label, optionally with "on"/"off"
 * (or show/hide, open/close, start/stop, enable/disable), or a level ("reverb 40 percent").
 *
 *   "Cockpits on"  "hide cockpit"  "Zen off"  "mirror effect"  "start recording"
 *   "light source top left"  "style starflight voyager"  "reverb 40 percent"
 *
 * Kept free of Angular so the matching can be unit-tested on plain strings.
 */
export interface VoiceControl {
  /** Spoken names; the first is the display label. Matching ignores case, punctuation, hyphens and plural "s". */
  names: string[];
  /** Current state, for on/off controls. Omit for one-shot actions (next style, launch...). */
  isOn?: () => boolean;
  /** Toggles an on/off control, or performs a one-shot action. May return a reply to show instead of the default. */
  run?: () => string | void;
  /** Sets a 0–100 level ("reverb 40 percent"). */
  setPercent?: (pct: number) => void;
}

export type VoiceIntent = 'on' | 'off' | 'toggle';

export interface VoiceMatch {
  control: VoiceControl;
  intent: VoiceIntent;
  percent: number | null;
}

const ON_WORDS = new Set(['on', 'enable', 'show', 'open', 'start', 'activate', 'begin', 'expand', 'display']);
const OFF_WORDS = new Set(['off', 'disable', 'hide', 'close', 'stop', 'deactivate', 'exit', 'end', 'dismiss']);

/** Lowercase, drop punctuation, turn hyphens into spaces, pad with spaces for whole-word search. */
export function normalizeSpeech(text: string): string {
  const words = text.toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-_/:]/g, ' ')
    .replace(/[^a-z0-9% ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return ` ${words.join(' ')} `;
}

/** Spellings to try for a name: as-is, singular/plural, and joined ("tri fold" → "trifold"). */
function nameVariants(name: string): string[] {
  const n = normalizeSpeech(name).trim();
  const variants = new Set([n, n.endsWith('s') ? n.slice(0, -1) : `${n}s`]);
  if (n.includes(' ')) variants.add(n.replace(/ /g, ''));
  return [...variants].filter(Boolean);
}

/** Finds the control whose name matches most specifically (longest name wins), plus the on/off intent and any level. */
export function matchVoiceCommand(transcript: string, controls: VoiceControl[]): VoiceMatch | null {
  const text = normalizeSpeech(transcript);
  const hasLevel = /\d/.test(text);
  let best: { control: VoiceControl; name: string } | null = null;
  for (const control of controls) {
    // A level-only control ("Volume") needs a number, so "volume up" stays with the voicebot's built-ins
    if (!control.run && !hasLevel) continue;
    for (const name of control.names) {
      for (const variant of nameVariants(name)) {
        if (text.includes(` ${variant} `) && (!best || variant.length > best.name.length)) {
          best = { control, name: variant };
        }
      }
    }
  }
  if (!best) return null;

  // Intent words outside the matched name; the last one spoken wins ("turn zen off")
  const rest = text.replace(` ${best.name} `, ' ').trim().split(' ');
  let intent: VoiceIntent = 'toggle';
  for (const word of rest) {
    if (ON_WORDS.has(word)) intent = 'on';
    else if (OFF_WORDS.has(word)) intent = 'off';
  }

  const level = rest.join(' ').match(/(\d{1,3})\s*(%|percent)?/);
  const percent = level ? Math.min(100, Math.max(0, parseInt(level[1], 10))) : null;
  return { control: best.control, intent, percent };
}

/** Carries out a match and returns a short reply describing what actually happened. */
export function applyVoiceMatch(match: VoiceMatch): string {
  const { control, intent, percent } = match;
  const label = control.names[0];

  if (control.setPercent && percent !== null) {
    control.setPercent(percent);
    return `${label} set to ${percent}%`;
  }
  if (!control.run) return `Say a level, e.g. "${label} 40 percent"`;
  if (!control.isOn) {
    return control.run() || `${label} ✓`;
  }

  const wasOn = control.isOn();
  const wantOn = intent === 'toggle' ? !wasOn : intent === 'on';
  if (wantOn === wasOn) return `${label} is already ${wasOn ? 'ON' : 'OFF'}`;
  const reply = control.run();
  if (reply) return reply;
  // Some toggles are gated (Pro features, device limits); report the real outcome
  return control.isOn() === wantOn ? `${label} ${wantOn ? 'ON' : 'OFF'}` : `${label} couldn't be switched right now`;
}
