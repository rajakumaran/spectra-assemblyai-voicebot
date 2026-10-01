/**
 * A minimal host for the voicebot: ten commands, wired end to end.
 *
 * Spectra's own registry has 77 controls plus 161 visual-style names; this is the same shape, cut
 * down to something you can read in one sitting. Say "dark mode on", "volume 40 percent",
 * "next slide", "what can i say".
 */
import { Component, computed, signal } from '@angular/core';
import { VoicebotComponent } from '../src/assemblyai-voicebot/voicebot.component';
import { VoicebotAppCommand, VoicebotCommand } from '../src/assemblyai-voicebot/voicebot.types';
import { VoiceControl, applyVoiceMatch, matchVoiceCommand } from '../src/services/voice-commands';

@Component({
  selector: 'app-demo',
  standalone: true,
  imports: [VoicebotComponent],
  template: `
    <h1>Voicebot demo</h1>
    <p>Dark mode: {{ isDark() ? 'ON' : 'OFF' }} &nbsp;|&nbsp; Volume: {{ volume() }}% &nbsp;|&nbsp; Slide {{ slide() }}</p>

    <app-voicebot
      [appCommandResolver]="voiceCommandResolver"
      [keyterms]="voiceKeyterms()"
      (command)="onBuiltInCommand($event)">
    </app-voicebot>
  `,
})
export class DemoComponent {
  readonly isDark = signal(false);
  readonly volume = signal(70);
  readonly slide = signal(1);
  readonly isPlaying = signal(false);

  /**
   * Each control lists the phrases it answers to; the first is its display label.
   *
   *   `run`        toggles, or performs a one-shot action. Return a string to override the reply.
   *   `isOn`       present only for on/off controls, so "dark mode on" is a no-op when already on.
   *   `setPercent` for level controls, driven by "volume 40 percent".
   */
  private readonly controls: VoiceControl[] = [
    // One-shot actions: no `isOn`, so intent words are ignored and the action simply runs
    { names: ['Play', 'play music', 'start music', 'resume'], run: () => this.play() },
    { names: ['Pause', 'pause music', 'stop', 'stop music'], run: () => this.pause() },
    { names: ['Next slide', 'next', 'forward'], run: () => this.move(1) },
    { names: ['Previous slide', 'previous', 'go back'], run: () => this.move(-1) },
    { names: ['First slide', 'start over', 'back to the beginning'], run: () => { this.slide.set(1); return 'Slide 1'; } },

    // On/off controls: `isOn` lets the matcher honour "on", "off", "show", "hide" and report
    // "already ON" rather than blindly flipping
    { names: ['Dark mode', 'dark theme', 'night mode'], isOn: () => this.isDark(), run: () => { this.isDark.update(v => !v); } },

    // Level control: needs a number, so a bare "volume" falls through to the voicebot's built-ins
    { names: ['Volume', 'loudness'], setPercent: (pct) => this.volume.set(pct) },

    // A control may return its own reply instead of the default confirmation
    { names: ['Status', 'where am i', 'what is the state'], run: () => `Slide ${this.slide()}, volume ${this.volume()}%` },
    { names: ['Voice commands', 'what can i say', 'help'], run: () => this.helpText() },
  ];

  /** Tried before the voicebot's own keyword fallbacks. Returning null lets those handle it. */
  readonly voiceCommandResolver = (transcript: string): VoicebotAppCommand | null => {
    const match = matchVoiceCommand(transcript, this.controls);
    if (!match) return null;
    return { label: match.control.names[0], run: () => applyVoiceMatch(match) };
  };

  /**
   * Sent to AssemblyAI as `keyterms_prompt`, biasing recognition toward this app's own vocabulary.
   * The cap is 100 terms of at most 50 characters; the device engine ignores them.
   */
  readonly voiceKeyterms = computed(() => this.controls.map(c => c.names[0]));

  /** The voicebot's generic fallbacks (next/previous/play/pause/volume) arrive here. */
  onBuiltInCommand(cmd: VoicebotCommand): void {
    switch (cmd.action) {
      case 'PLAY': this.play(); break;
      case 'PAUSE': this.pause(); break;
      case 'NEXT_TRACK': this.move(1); break;
      case 'PREV_TRACK': this.move(-1); break;
      case 'VOLUME_CHANGE':
        this.volume.update(v => Math.max(0, Math.min(100, v + (cmd.params?.volumeDelta ?? 0) * 100)));
        break;
      default: break; // AI_CHAT / UNKNOWN are answered by the voicebot itself
    }
  }

  // Replies describe what actually happened — a confident reply over a silent no-op reads as
  // "the app didn't understand me", which is worse than an error.
  private play(): string {
    if (this.isPlaying()) return 'Already playing';
    this.isPlaying.set(true);
    return 'Playing';
  }

  private pause(): string {
    if (!this.isPlaying()) return 'Already paused';
    this.isPlaying.set(false);
    return 'Paused';
  }

  private move(step: 1 | -1): string {
    const next = this.slide() + step;
    if (next < 1) return 'Already on the first slide';
    this.slide.set(next);
    return `Slide ${next}`;
  }

  private helpText(): string {
    return 'Try: "play", "dark mode on", "volume 40 percent", "next slide", "status"';
  }
}
