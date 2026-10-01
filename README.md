


# AssemblyAI Voicebot — a drop-in voice layer for Angular apps

A self-contained Angular module that lets users **operate an entire application by speaking**, built on
**AssemblyAI Universal-3.5 Pro**. Extracted from [Spectra](#about-spectra), a commercial real-time music
visualiser, where it drives 238 commands across playback, visuals and audio.

Its only external dependencies are `@angular/core` and `@angular/common`.

---

Built by Muthukumaran Azhagesan on **AssemblyAI Universal-3.5 Pro**.
spectra.damnittameitai.co
musicvisuals.tech
damnittameitai.co
https://tr.ee/XQ0qKh - Overall career portfolio of Mr. Muthukumaran Azhagesan 
Software Architect, Developer, AI Engineer & FDE, Inventor, Scientist

## Why it exists

Spectra runs on phones, laptops, tablets and smart TVs. The controls that make it expressive are fiddly on a six-inch phone and absurd from a sofa three metres from a TV. AssemblyAI removes the problem! : the whole player is
operable in any form factor **without pressing a single button, yes all via voice commands**.

The feature that changed how it feels is **mid-sentence language switching**. Assembly AI Universal-3.5 Pro code-switches
across 18 languages with no configuration and returns each speaker's own script — Devanagari, kanji, Han. A bilingual user never stops, re-phrases, or hunts for a language menu.

---

## What's NOT in the box. Spectra Music Player software. Of course it is a separate software built with months of efforts. 

## What's in the box (Only AssemblyAI voicebot module)

| Capability | Where |
|---|---|
| Streaming STT over WebSocket (live partial text) | `assemblyai.service.ts` |
| **Sync STT** — one clip, one HTTPS request | `assemblyai.service.ts`, `pcm-wav.ts` |
| Free on-device fallback (Web Speech API) | `assemblyai.service.ts` |
| Keyterm prompting (up to 100 app terms per session) | `assemblyai.service.ts` |
| Turn-detection tuning so pauses don't cut speakers off | `assemblyai.service.ts` |
| Command matching — speech → app action | `services/voice-commands.ts` |
| Floating mascot UI, push-to-talk and tap-to-toggle | `voicebot.component.*` |
| Server-side token minting (key never reaches the browser) | `api/assemblyai-token.js` |
| Server-side audio proxy for Sync STT | `api/assemblyai-sync.js` |

### Three engines, one button

The user taps the engine badge to cycle:

1. **On-device** — Web Speech API. No key, no cost, one language at a time. The shipping default.
2. **AssemblyAI Live** — `wss://streaming.assemblyai.com/v3/ws`, Assembly AI Universal-3.5 Pro. Partial text as you speak,
   native code-switching.
3. **Sync STT** — records until you stop, then posts a single WAV. Nothing can finalise a turn early, so this
   is the one to use for mixed-language speech.

Engines 2 and 3 appear only when their environment flag is set, so the default build behaves exactly as it did
before voice was added.

---

## Setup

### 1. Copy the files in

```
src/assemblyai-voicebot/      the module
src/services/voice-commands.ts  the matcher (optional, but it is what makes commands feel natural)
api/                          two serverless functions (Vercel-style Node handlers)
```

### 2. Environment variables

| Variable | Effect |
|---|---|
| `ASSEMBLYAI_API_KEY` | Your key. **Server-side only** — never expose it to the client. |
| `ENABLE_ASSEMBLYAI` | `true` / `1` / `yes` / `on` (case-insensitive) turns the cloud engines on. |
| `MULTI_LANGUAGE_SUPPORT` | Must be **exactly** the lowercase string `true`. Adds the Sync STT engine, the language picker, and the widened pause window. |

`MULTI_LANGUAGE_SUPPORT` is matched case-sensitively on purpose: a stray `TRUE` or `1` cannot switch it on by
accident. See `.env.example`.

### 3. Drop the component in your template

```html
<app-voicebot
  [appCommandResolver]="voiceCommandResolver"
  [keyterms]="voiceKeyterms()"
  (command)="handleVoicebotCommand($event)">
</app-voicebot>
```

### 4. Teach it your commands

See `example/demo-usage.ts` for a runnable 10-command host. The shape is:

```ts
const controls: VoiceControl[] = [
  { names: ['Play', 'play music', 'start music'], run: () => this.player.play() },
  { names: ['Dark mode', 'dark theme'], isOn: () => this.isDark(), run: () => this.toggleDark() },
  { names: ['Volume'], setPercent: (pct) => this.setVolume(pct / 100) },
];

readonly voiceCommandResolver = (transcript: string) => {
  const match = matchVoiceCommand(transcript, controls);
  return match ? { label: match.control.names[0], run: () => applyVoiceMatch(match) } : null;
};
```

---

## How one command travels

```
User taps mascot
  → UI asks /api/assemblyai-token          (server mints a 5-minute token)
  → UI streams 16 kHz mono PCM16 over WSS  ─┐ the only legs that leave the device
  → AssemblyAI returns a finalised Turn    ─┘
  → matchVoiceCommand(transcript)
  → the matched control runs, and replies with what actually happened
  → microphone closes immediately, so speakers never feed back into it
```

In Sync STT mode the two middle legs collapse into one HTTPS POST carrying a single WAV clip.

---

## Design decisions worth knowing

**The API key never reaches the browser.** The client receives short-lived tokens, or posts audio through a
proxy that attaches the key server-side. A direct-key path exists for local development only.

**Longest match wins.** `"stop recording"` stops the recorder rather than the music, because `recording`
outranks `stop`. This keeps a large vocabulary unambiguous without a grammar.

**Replies state the real outcome.** `"No track loaded yet"`, `"Already playing"`, `"… couldn't be switched
right now"` — never a false confirmation. A confident reply plus nothing happening is indistinguishable from
"the app didn't understand me", which is worse than an error.

**The matcher is Angular-free** (`voice-commands.ts`), so command matching is unit-testable on plain strings
without a browser or a test harness.

**Turn detection is widened when multi-language is on.** Universal-3.5 Pro ends a turn after about a second of
silence by default, which is enough to cut a speaker off as they switch language. The module raises that window
to four seconds, and leaves the snappier default in place for single-language sessions.

**iOS gets a plain microphone.** Requesting echo cancellation makes iOS activate its voice-processing audio
unit, which ducks all other audio to silence and routes output to the earpiece. Since music has to keep playing
while the user talks, iOS is given an unprocessed capture instead. The trade is that the mic there also hears
the track.

**The microphone is never routed to the speakers.** A `ScriptProcessorNode` only keeps firing while it has a
path to the destination, so it feeds a gain node pinned at zero.

---

## Known limitations

- **Commands are matched in English.** Speech code-switches and is displayed in the speaker's own script, but
  the control names are English. `normalizeSpeech` also strips non-ASCII characters, so a Devanagari or CJK
  transcript cannot currently match a command — and accented Latin (`nächster`) is mangled. Making the matcher
  Unicode-aware is the prerequisite for localised command names.
- **Sync STT is for short clips.** Long recordings return `audio_too_large`.
- **Mute, playlist shuffle and repeat** are not voice-addressable in the host app yet — those features did not
  exist to point a command at.
- `ScriptProcessorNode` is deprecated in favour of `AudioWorklet`. It is used here for its synchronous
  resampling and broad Safari support; migrating is a known future change.

---

## About Spectra

[Spectra](https://github.com/) is a commercial Angular 21 real-time music visualiser: 161 visual styles, a 3D
space stage of aircraft and orbital stations, true-peak limiting, and 4K capture. This module is its entire
voice layer, extracted unchanged.

## Licence

**Not yet chosen** — see `LICENSE`. Decide before making the repository public.

## Credits

Built by Muthukumaran Azhagesan on **AssemblyAI Universal-3.5 Pro**.
spectra.damnittameitai.co
musicvisuals.tech
damnittameitai.co
https://tr.ee/XQ0qKh - Overall career portfolio of Mr. Muthukumaran Azhagesan 
Software Architect, Developer, AI Engineer & FDE, Inventor, Scientist


#ai #musicvisuals #assemblyai #voicebots #spacecrafts #attractivevisuals #entertainment #TV #lablabai #music #voice #voicebot #angular #typescript #webdevelopment #nodejs #tailwindcss