import { Component, OnInit, OnDestroy, output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AssemblyAIService } from './assemblyai.service';
import { AssemblyAITurnMessage, VoicebotCommand, VoicebotCommandResolver } from './voicebot.types';

@Component({
  selector: 'app-voicebot',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voicebot.component.html',
  styleUrls: ['./voicebot.component.css']
})
export class VoicebotComponent implements OnInit, OnDestroy {
  // Outputs for host music player
  command = output<VoicebotCommand>();
  transcriptChange = output<string>();

  // Optional Inputs
  accentColor = input<string>('#06b6d4');
  /** Host app commands (button labels, on/off), tried before the built-in keywords. */
  appCommandResolver = input<VoicebotCommandResolver | null>(null);
  /** Words AssemblyAI should favour (button labels, style names). The device engine ignores them. */
  keyterms = input<string[]>([]);

  // UI State Signals
  isExpanded = signal<boolean>(false);
  isMinimized = signal<boolean>(false);
  isHolding = signal<boolean>(false);
  /** Language chooser, only reachable while MULTI_LANGUAGE_SUPPORT is on. */
  showLanguages = signal<boolean>(false);
  botReply = signal<string>('How are you feeling today? Tap "Push & Talk" or tap avatar to speak!');
  lastCommand = signal<string | null>(null);

  // 3D Tri-Fold Perspective Angles (matching the attached Melody Forest illustration)
  bubblePerspective: string = 'perspective(900px) rotateY(-18deg) rotateX(10deg) rotateZ(-3deg)';
  // Gentler yaw than the bubble's: at -12deg the receding wing was noticeably squashed
  avatarPerspective: string = 'perspective(900px) rotateY(-6deg) rotateX(6deg) rotateZ(2deg)';

  private unsubscribeTurn: (() => void) | null = null;
  private holdTimeout: any = null;
  private autoCollapseTimeout: any = null;
  private isHoldingActive = false;
  private justReleasedHold = false;

  constructor(public assemblyAI: AssemblyAIService) {}

  ngOnInit(): void {
    // Listen for AssemblyAI real-time transcript turns
    this.unsubscribeTurn = this.assemblyAI.onTurn((turn: AssemblyAITurnMessage) => {
      this.handleFinalTurn(turn);
    });
  }

  ngOnDestroy(): void {
    if (this.holdTimeout) {
      clearTimeout(this.holdTimeout);
    }
    if (this.autoCollapseTimeout) {
      clearTimeout(this.autoCollapseTimeout);
    }
    if (this.unsubscribeTurn) {
      this.unsubscribeTurn();
    }
    this.assemblyAI.stopListening();
  }

  /**
   * Push & Talk - Hold down to speak (pointerdown / mousedown / touchstart)
   */
  public onPushToTalkStart(event: Event): void {
    this.justReleasedHold = false;
    this.holdTimeout = setTimeout(() => {
      this.isHoldingActive = true;
      this.isHolding.set(true);
      this.isExpanded.set(true);
      if (this.assemblyAI.status() !== 'listening') {
        this.lastCommand.set(null);
        this.assemblyAI.startListening({ keytermsPrompt: this.keyterms() });
        this.botReply.set('Listening... Speak your command!');
      }
    }, 250);
  }

  /**
   * Push & Talk - Release to finish (pointerup / mouseup / touchend)
   */
  public onPushToTalkEnd(event: Event): void {
    if (this.holdTimeout) {
      clearTimeout(this.holdTimeout);
      this.holdTimeout = null;
    }

    if (this.isHoldingActive) {
      this.isHoldingActive = false;
      this.isHolding.set(false);
      this.justReleasedHold = true;
      // Brief 250ms grace window for final audio buffer to be processed
      setTimeout(() => {
        if (this.assemblyAI.status() === 'listening') {
          this.assemblyAI.stopListening();
        }
      }, 250);
    }
  }

  /**
   * Tap / Click to toggle Push & Talk
   */
  public onPushToTalkClick(event: Event): void {
    event.stopPropagation();
    // If the click was fired right after releasing a press-and-hold, suppress it
    if (this.justReleasedHold) {
      this.justReleasedHold = false;
      return;
    }
    this.toggleListening();
  }

  /**
   * Tap / Click speech bubble to toggle listening
   */
  public onBubbleClick(event: Event): void {
    event.stopPropagation();
    this.toggleListening();
  }

  /**
   * Toggle listening state
   */
  public toggleListening(): void {
    if (this.autoCollapseTimeout) {
      clearTimeout(this.autoCollapseTimeout);
      this.autoCollapseTimeout = null;
    }

    if (this.assemblyAI.status() === 'listening' || this.assemblyAI.status() === 'processing') {
      this.assemblyAI.stopListening();
      this.botReply.set('Mic muted. Tap "Push & Talk" to speak!');
    } else {
      this.isExpanded.set(true);
      this.lastCommand.set(null);
      this.assemblyAI.startListening({ keytermsPrompt: this.keyterms() });
      this.botReply.set('Listening... Say a button name + "on" or "off", e.g. "Cockpits on", "Zen off", "next style"');
    }
  }

  public toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  /** Short badge for the engine switcher. Sync STT only appears with MULTI_LANGUAGE_SUPPORT on. */
  public engineLabel(): string {
    switch (this.assemblyAI.selectedEngine()) {
      case 'assemblyai': return 'AssemblyAI';
      case 'assemblyai-sync': return 'Multi-Lang';
      default: return 'Standard';
    }
  }

  /** "Auto" when nothing is pinned - Universal-3.5 Pro code-switches on its own. */
  public languageSummary(): string {
    const codes = this.assemblyAI.selectedLanguages();
    if (!codes.length) return 'Auto';
    return codes
      .map(c => this.assemblyAI.availableLanguages.find(l => l.code === c)?.label ?? c)
      .join(', ');
  }

  public toggleLanguagePicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.showLanguages.update(v => !v);
  }

  public onLanguageToggle(code: string, event?: Event): void {
    if (event) event.stopPropagation();
    this.assemblyAI.toggleLanguage(code);
    this.botReply.set(`Languages: ${this.languageSummary()}`);
  }

  public clearLanguages(event?: Event): void {
    if (event) event.stopPropagation();
    this.assemblyAI.setLanguages([]);
    this.botReply.set('Languages: Auto — the model will detect and switch on its own.');
  }

  public closeBubble(event?: Event): void {
    if (event) event.stopPropagation();
    this.isExpanded.set(false);
  }

  public toggleMinimized(event?: Event): void {
    if (event) event.stopPropagation();
    this.isMinimized.update(v => !v);
  }

  public onAvatarClick(event: Event): void {
    event.stopPropagation();
    if (this.isMinimized()) {
      this.isMinimized.set(false);
      this.isExpanded.set(true);
      return;
    }
    this.toggleListening();
  }

  /**
   * Toggle between Spectra Voice & AssemblyAI Cloud Pro (when enabled via Vercel)
   */
  public toggleEngine(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    if (!this.assemblyAI.isCloudAssemblyAIEnabled()) {
      return;
    }
    this.assemblyAI.toggleEngine();
    const current = this.assemblyAI.selectedEngine();
    if (current === 'device') {
      this.botReply.set('✨ Active: Spectra Voice Engine.');
    } else if (current === 'assemblyai-sync') {
      this.botReply.set(`🌐 Active: AssemblyAI Multi-Language (Sync STT). Languages: ${this.languageSummary()}`);
    } else {
      this.botReply.set('⚡ Active: AssemblyAI Universal-3.5 Streaming Engine!');
    }
  }

  /**
   * Dispatches command to host and IMMEDIATELY stops listening to prevent
   * speaker music playback from feeding into the mic and interrupting playback!
   */
  private dispatchAndStop(cmd: VoicebotCommand, reply: string, label: string): void {
    this.showResultAndStop(reply, label);
    // 2. Dispatch command to host player
    this.command.emit(cmd);
  }

  private showResultAndStop(reply: string, label: string): void {
    // 1. Immediately shut off mic to prevent audio loop!
    this.assemblyAI.stopListening();
    this.lastCommand.set(label);
    this.botReply.set(reply);
    this.isExpanded.set(true);

    // Auto-collapse after 5.5 seconds so bottom player controls remain unobstructed
    if (this.autoCollapseTimeout) {
      clearTimeout(this.autoCollapseTimeout);
    }
    this.autoCollapseTimeout = setTimeout(() => {
      if (this.assemblyAI.status() !== 'listening') {
        this.isExpanded.set(false);
      }
    }, 5500);
  }

  /**
   * Interpret speech transcript turns into voice commands
   */
  private handleFinalTurn(turn: AssemblyAITurnMessage): void {
    const raw = (turn.transcript || '').trim();
    if (!raw) return;

    this.transcriptChange.emit(raw);

    // 0. Host app commands first, so "next style" or "stop recording" aren't taken by the generic keywords below
    const appCommand = this.appCommandResolver()?.(raw);
    if (appCommand) {
      // Mic off before acting (the command may start music), then report what actually happened
      this.showResultAndStop('', appCommand.label);
      this.botReply.set(appCommand.run());
      return;
    }

    const lower = raw.toLowerCase();

    // 1. Next track
    if (lower.includes('next') || lower.includes('skip') || lower.includes('forward')) {
      this.dispatchAndStop(
        { action: 'NEXT_TRACK', rawText: raw },
        'Playing next track for you!',
        'Next Track ⏭'
      );
      return;
    }

    // 2. Previous track
    if (lower.includes('previous') || lower.includes('back') || lower.includes('prior') || lower.includes('last song')) {
      this.dispatchAndStop(
        { action: 'PREV_TRACK', rawText: raw },
        'Going back to previous track!',
        'Previous Track ⏮'
      );
      return;
    }

    // 3. Pause / Stop
    if (lower.includes('pause') || lower.includes('stop') || lower.includes('freeze') || lower.includes('halt')) {
      this.dispatchAndStop(
        { action: 'PAUSE', rawText: raw },
        'Pausing the music for you.',
        'Pause ⏸'
      );
      return;
    }

    // 4. Play / Resume
    if (lower.includes('play') || lower.includes('resume') || lower.includes('start') || lower.includes('unpause')) {
      this.dispatchAndStop(
        { action: 'PLAY', rawText: raw },
        'Sound on! Resuming playback. Mic muted for music.',
        'Play ▶'
      );
      return;
    }

    // 5. Starflight Voyager / Multicolor
    if (lower.includes('starflight') || lower.includes('voyager') || lower.includes('multicolor') || lower.includes('multi-color')) {
      const themeName = lower.includes('multicolor') || lower.includes('multi-color')
        ? 'Starflight Voyager Multi-Color'
        : 'Starflight Voyager';
      this.dispatchAndStop(
        { action: 'THEME_CHANGE', rawText: raw, params: { themeName } },
        `Engaging ${themeName}! Ready for hypersonic warp.`,
        `Switched to ${themeName} 🚀`
      );
      return;
    }

    // 6. Top Gun / Fighter Jets
    if (lower.includes('jet') || lower.includes('fighter') || lower.includes('top gun') || lower.includes('raptor')) {
      this.dispatchAndStop(
        { action: 'THEME_CHANGE', rawText: raw, params: { themeName: 'Top Gun Jets: Stealth Squadron (Showcase)' } },
        'Scrambling Top Gun fighter jets to escort your sound!',
        'Top Gun Jets ✈'
      );
      return;
    }

    // 7. Flying Machines
    if (lower.includes('flying machine') || lower.includes('armada') || lower.includes('valkyrie')) {
      this.dispatchAndStop(
        { action: 'THEME_CHANGE', rawText: raw, params: { themeName: 'Flying Machines (Showcase)' } },
        'Launching the 8-ship Flying Machines armada.',
        'Flying Machines 🛸'
      );
      return;
    }

    // 8. Volume Controls
    if (lower.includes('louder') || lower.includes('volume up') || lower.includes('turn it up')) {
      this.dispatchAndStop(
        { action: 'VOLUME_CHANGE', rawText: raw, params: { volumeDelta: 0.15 } },
        'Pumping up the volume!',
        'Volume Up 🔊'
      );
      return;
    }

    if (lower.includes('softer') || lower.includes('volume down') || lower.includes('turn it down') || lower.includes('quieter')) {
      this.dispatchAndStop(
        { action: 'VOLUME_CHANGE', rawText: raw, params: { volumeDelta: -0.15 } },
        'Softening the volume for you.',
        'Volume Down 🔉'
      );
      return;
    }

    // 9. Conversational / Q&A
    if (lower.includes('how are you') || lower.includes('feeling')) {
      this.dispatchAndStop(
        { action: 'AI_CHAT', rawText: raw, params: { chatReply: 'Feeling electric and vibing to the music! What track shall we play?' } },
        'Feeling electric and vibing to the music! What track shall we play?',
        'AI Chat 💬'
      );
      return;
    }

    if (lower.includes('who are you') || lower.includes('what are you') || lower.includes('what can you do')) {
      const isAai = this.assemblyAI.isCloudAssemblyAIEnabled() && this.assemblyAI.selectedEngine() === 'assemblyai';
      const reply = isAai
        ? '⚡ I am your Spectra Voice Companion powered by AssemblyAI Universal-3.5! Say "play", "next", or "starflight"!'
        : '✨ I am your Spectra Voice Companion! Say "play", "next", or "starflight"!';
      this.dispatchAndStop(
        { action: 'AI_CHAT', rawText: raw, params: { chatReply: reply } },
        reply,
        'Spectra AI 💬'
      );
      return;
    }

    // Default friendly acknowledgment - stop mic to avoid loop
    this.dispatchAndStop(
      { action: 'UNKNOWN', rawText: raw },
      `Heard: "${raw}". Tap Push & Talk to command.`,
      `Heard: "${raw}"`
    );
  }
}
