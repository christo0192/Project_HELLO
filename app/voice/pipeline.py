"""
Reusable Pipecat pipeline factory for the screening bot (pipecat 1.4.0).

build_task(transport, system_text=, opening_text=, ...) wires the pipeline
with an STT_VENDOR-selectable backend:

  STT_VENDOR=deepgram_flux (default):
      DeepgramFluxSTTService + ExternalUserTurnStrategies() — no VAD needed;
      Flux drives turns via StartOfTurn/EndOfTurn frames.

  STT_VENDOR=sarvam:
      SarvamSTTService + ConfirmedSmartTurnStopStrategy (consensus gate:
      Smart Turn v3 COMPLETE + CONFIRM_DELAY_MS silence window + finalized
      transcript) + Silero VAD on the aggregator.

TTS (Sarvam) + LLM (Anthropic) are shared across both paths.
Prompt building lives in context.py / prompts.py; this module is
prompt-agnostic so run_local.py (mic) and server.py (browser/WebRTC)
share identical call logic.
"""

import asyncio
import os

from loguru import logger

from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    EndTaskFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    StartFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies, UserTurnStrategies
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.sarvam.stt import SarvamSTTService
from pipecat.services.sarvam.tts import SarvamTTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.asyncio.task_manager import BaseTaskManager
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

# Phrases Maya uses to close the screening (see prompts.py).
_GOODBYE_MARKERS = (
    "goodbye", "have a great day", "team will be in touch",
    "team will follow up", "be in touch about next steps", "all the best", "take care",
)


class ConfirmedSmartTurnStopStrategy(BaseUserTurnStopStrategy):
    """Consensus turn-end gate for the Sarvam STT path.

    Commits the user turn ONLY when ALL three conditions hold simultaneously:

    1. LocalSmartTurnAnalyzerV3 predicts COMPLETE (probability >=
       SMART_TURN_COMPLETE_THRESHOLD) on the VADUserStoppedSpeakingFrame event.
    2. A confirmation window (confirm_delay_ms milliseconds) elapses AFTER
       Smart Turn says COMPLETE with NO VADUserStartedSpeakingFrame arriving
       during that window. Speech resumption cancels the window and resets the
       COMPLETE state.
    3. At least one TranscriptionFrame with non-empty text has been received
       (wait_for_transcript semantics — does not commit on empty text).

    A VADUserStartedSpeakingFrame at any point cancels any pending confirmation
    timer and clears the COMPLETE flag so the cycle restarts cleanly.
    """

    def __init__(self, *, turn_analyzer, confirm_delay_ms: int = 1000, **kwargs):
        """
        Args:
            turn_analyzer: A LocalSmartTurnAnalyzerV3 (or compatible) instance,
                already configured with its _predict_endpoint wrapper if needed.
            confirm_delay_ms: Silence window in milliseconds after Smart Turn
                reports COMPLETE. Defaults to 1000 ms.
        """
        super().__init__(**kwargs)
        self._analyzer = turn_analyzer
        self._confirm_delay: float = confirm_delay_ms / 1000.0

        self._vad_user_speaking: bool = False
        self._smart_complete: bool = False
        self._transcript_ready: bool = False
        # True once the confirm timer runs to completion (not cancelled).
        self._confirm_elapsed: bool = False
        self._confirm_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def setup(self, task_manager: BaseTaskManager):
        await super().setup(task_manager)

    async def reset(self):
        """Reset all gate state and cancel any in-flight confirm timer."""
        await super().reset()
        self._vad_user_speaking = False
        self._smart_complete = False
        self._transcript_ready = False
        self._confirm_elapsed = False
        await self._cancel_confirm()

    async def cleanup(self):
        """Tear down the strategy and the underlying analyzer."""
        await super().cleanup()
        await self._analyzer.cleanup()
        await self._cancel_confirm()

    # ------------------------------------------------------------------
    # Frame processing
    # ------------------------------------------------------------------

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        await super().process_frame(frame)

        if isinstance(frame, StartFrame):
            # Let Smart Turn know the sample rate of incoming audio.
            self._analyzer.set_sample_rate(frame.audio_in_sample_rate)

        elif isinstance(frame, InputAudioRawFrame):
            # Feed audio continuously so Smart Turn's ring-buffer stays current.
            # We do not act on the return value here; COMPLETE is determined only
            # on VADUserStoppedSpeakingFrame via analyze_end_of_turn().
            self._analyzer.append_audio(frame.audio, self._vad_user_speaking)

        elif isinstance(frame, VADUserStartedSpeakingFrame):
            # User resumed — cancel confirm window and reset COMPLETE state.
            self._vad_user_speaking = True
            self._smart_complete = False
            self._confirm_elapsed = False
            await self._cancel_confirm()

        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._vad_user_speaking = False
            state, _ = await self._analyzer.analyze_end_of_turn()
            if state == EndOfTurnState.COMPLETE:
                self._smart_complete = True
                # (Re)start the confirmation window. Any prior timer was already
                # cancelled by the preceding VADUserStartedSpeakingFrame.
                self._confirm_elapsed = False
                self._confirm_task = self.task_manager.create_task(
                    self._confirm_handler(), f"{self}::_confirm_handler"
                )

        elif isinstance(frame, TranscriptionFrame):
            if frame.text.strip():
                self._transcript_ready = True
            # If the confirm window already elapsed before this transcript
            # arrived, attempt a commit now so late transcripts are not blocked.
            if self._confirm_elapsed:
                await self._maybe_trigger()

        return ProcessFrameResult.CONTINUE

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _cancel_confirm(self):
        """Cancel the confirm timer task if one is running."""
        if self._confirm_task is not None:
            await self.task_manager.cancel_task(self._confirm_task)
            self._confirm_task = None

    async def _confirm_handler(self):
        """Sleep the confirm window; then fire if all conditions hold.

        If the transcript is not yet ready when the window expires, the flag
        is set so the TranscriptionFrame handler can commit once it arrives.
        """
        try:
            await asyncio.sleep(self._confirm_delay)
        except asyncio.CancelledError:
            return
        finally:
            self._confirm_task = None

        self._confirm_elapsed = True
        await self._maybe_trigger()

    async def _maybe_trigger(self):
        """Fire turn-end when all three consensus conditions are satisfied."""
        if (
            not self._vad_user_speaking
            and self._smart_complete
            and self._transcript_ready
            and self._confirm_elapsed
        ):
            await self.trigger_user_turn_stopped()


class EndCallOnGoodbye(FrameProcessor):
    """Auto-ends the call once Maya finishes her closing turn.

    Watches the LLM's text per turn; if it contains a goodbye phrase, arms an end.
    When the bot then finishes speaking (BotStoppedSpeakingFrame), it pushes an
    EndTaskFrame upstream so the call hangs up gracefully AFTER the goodbye plays.
    """

    def __init__(self):
        super().__init__()
        self._buf: list[str] = []
        self._active = False
        self._armed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = []
            self._active = True
        elif isinstance(frame, LLMTextFrame) and self._active:
            self._buf.append(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame) and self._active:
            self._active = False
            text = "".join(self._buf).lower()
            if any(m in text for m in _GOODBYE_MARKERS):
                self._armed = True
        elif isinstance(frame, BotStoppedSpeakingFrame) and self._armed:
            self._armed = False
            logger.info("[bot] closing detected — ending call")
            await self.push_frame(EndTaskFrame(), FrameDirection.UPSTREAM)
        await self.push_frame(frame, direction)


def build_services(system_text: str):
    """Construct STT, LLM, and TTS services.

    STT is selected by STT_VENDOR env var:
      - deepgram_flux (default): DeepgramFluxSTTService
      - sarvam: SarvamSTTService

    LLM (Anthropic) and TTS (Sarvam) are the same on both paths.
    """
    vendor = os.getenv("STT_VENDOR", "deepgram_flux").lower()

    if vendor == "sarvam":
        stt = SarvamSTTService(
            api_key=os.environ["SARVAM_API_KEY"],
            model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            mode="transcribe",
            sample_rate=int(os.getenv("STT_SAMPLE_RATE", "16000")),
            # Sarvam's own server-side VAD decides when a speech segment ends.
            # With Smart Turn as the COMPLETE decider, Sarvam should finalize
            # fast so the transcript is ready when the model says "done".
            # neg_frames_count=18 ≈ 0.58s silence (Sarvam default, frame=32ms@16kHz).
            settings=SarvamSTTService.Settings(
                high_vad_sensitivity=False,
                negative_frames_count=int(os.getenv("SARVAM_NEG_FRAMES_COUNT", "18")),
                negative_frames_window=int(os.getenv("SARVAM_NEG_FRAMES_WINDOW", "24")),
            ),
        )
    else:
        # deepgram_flux (default) — unchanged from original pipeline
        stt = DeepgramFluxSTTService(
            api_key=os.environ["DEEPGRAM_API_KEY"],
            sample_rate=int(os.getenv("STT_SAMPLE_RATE", "16000")),
            settings=DeepgramFluxSTTService.Settings(
                model=os.getenv("FLUX_MODEL", "flux-general-en"),
                eot_threshold=float(os.getenv("FLUX_EOT_THRESHOLD", "0.7")),
                eot_timeout_ms=int(os.getenv("FLUX_EOT_TIMEOUT_MS", "5000")),
            ),
        )

    llm = AnthropicLLMService(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        settings=AnthropicLLMService.Settings(
            model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
            # Maya's prompt MUST be the LLM's *base* system_instruction so the
            # turn-completion mixin APPENDS its markers to it. If it lived only as a
            # context system message, the mixin's instruction would REPLACE it
            # (pipecat warns "Both ... set. Using system_instruction.") and Maya
            # would lose her persona, flow, and "no markdown" rules entirely.
            system_instruction=system_text,
            # Cache Maya's large system prompt → lower TTFB (faster first audio)
            # and ~10% cost on cached input each turn.
            enable_prompt_caching=True,
        ),
    )

    tts = SarvamTTSService(
        api_key=os.environ["SARVAM_API_KEY"],
        settings=SarvamTTSService.Settings(
            voice=os.getenv("SARVAM_TTS_VOICE", "anushka"),
            model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v2"),
            language=Language.EN_IN,
        ),
        sample_rate=int(os.getenv("TTS_SAMPLE_RATE", "8000")),  # telephony narrowband
        # Strip any stray markdown (**bold**, lists) so Sarvam doesn't choke on
        # symbol-only chunks or speak "asterisk asterisk".
        text_filters=[MarkdownTextFilter()],
    )
    return stt, llm, tts


def build_task(transport, *, system_text: str, opening_text: str,
               transcript_processors=None, audio_buffer=None) -> PipelineTask:
    """Build a PipelineTask for a given transport.

    system_text: the full system prompt (built from role + resume by context.py).
    opening_text: Maya's deterministic AI-disclosure opener.
    transcript_processors: optional (user_processor, assistant_processor) spliced
    after STT / after output to capture turns.
    """
    stt, llm, tts = build_services(system_text)

    # No system message in the context — Maya's prompt is the LLM's base
    # system_instruction (see build_services) so turn-completion composes correctly.
    context = LLMContext(messages=[])

    vendor = os.getenv("STT_VENDOR", "deepgram_flux").lower()

    if vendor == "sarvam":
        # ----------------------------------------------------------------
        # Sarvam path: Smart Turn v3 consensus gate + Silero VAD on aggregator
        # ----------------------------------------------------------------

        analyzer = LocalSmartTurnAnalyzerV3(
            params=SmartTurnParams(stop_secs=float(os.getenv("SMART_TURN_STOP_SECS", "8.0")))
        )

        # The model's complete/incomplete cutoff defaults to prob > 0.5 with no
        # config knob, and the probability logs only at trace level. Wrap the
        # internal _predict_endpoint to (a) log the probability at INFO level
        # and (b) apply a tunable confidence threshold: the model must be >=
        # SMART_TURN_COMPLETE_THRESHOLD sure the turn is done; otherwise it is
        # treated as INCOMPLETE and the confirm window is not started.
        # Higher threshold = fewer premature cut-offs.
        _complete_threshold = float(os.getenv("SMART_TURN_COMPLETE_THRESHOLD", "0.6"))
        _orig_predict = analyzer._predict_endpoint

        def _predict_with_threshold(audio_array):
            res = _orig_predict(audio_array)
            prob = res.get("probability", 0.0)
            pred = 1 if prob >= _complete_threshold else 0
            res["prediction"] = pred
            logger.info(
                f"[smart-turn] prob_complete={prob:.3f} thr={_complete_threshold} "
                f"-> {'COMPLETE' if pred else 'INCOMPLETE (wait)'}"
            )
            return res

        analyzer._predict_endpoint = _predict_with_threshold

        stop_strategy = ConfirmedSmartTurnStopStrategy(
            turn_analyzer=analyzer,
            confirm_delay_ms=int(os.getenv("CONFIRM_DELAY_MS", "1000")),
        )

        # Deterministic noise guard: while the bot is speaking, require at least
        # NOISE_GUARD_MIN_WORDS transcribed words before the user counts as
        # interrupting. 0 = disabled (VAD-default start behaviour).
        noise_guard_min_words = int(os.getenv("NOISE_GUARD_MIN_WORDS", "0"))
        start_strategies = None
        if noise_guard_min_words > 0:
            from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
                MinWordsUserTurnStartStrategy,
            )
            start_strategies = [
                MinWordsUserTurnStartStrategy(min_words=noise_guard_min_words, use_interim=True)
            ]

        turn_strategies = UserTurnStrategies(
            start=start_strategies,
            stop=[stop_strategy],
        )

        # CRITICAL (pipecat 1.4.0): VAD lives on the AGGREGATOR, not the transport.
        # TransportParams has no vad_analyzer field, so the one passed in server.py is
        # silently dropped. Without this the VADController never runs, no
        # VADUserStopped frames are emitted, Smart Turn never fires, and every turn
        # falls back to transcript-only timing. This is the VAD-on-aggregator fix.
        aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=turn_strategies,
                vad_analyzer=SileroVADAnalyzer(params=VADParams(
                    confidence=float(os.getenv("VAD_CONFIDENCE", "0.75")),
                    start_secs=float(os.getenv("VAD_START_SECS", "0.35")),
                    stop_secs=float(os.getenv("VAD_STOP_SECS", "0.5")),
                    min_volume=float(os.getenv("VAD_MIN_VOLUME", "0.25")),
                )),
                # Long interview answers include pauses, restarts, and examples.
                # Keep Pipecat's safety net above normal candidate thinking time.
                user_turn_stop_timeout=float(os.getenv("USER_TURN_STOP_TIMEOUT", "45.0")),
            ),
        )

    else:
        # ----------------------------------------------------------------
        # Deepgram Flux path (default) — UNCHANGED from original pipeline.
        # Flux drives turn-taking externally: UserStartedSpeakingFrame on
        # StartOfTurn, UserStoppedSpeakingFrame + final TranscriptionFrame on
        # EndOfTurn. ExternalUserTurnStrategies defers to those signals;
        # no VAD needed here.
        # ----------------------------------------------------------------
        aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=ExternalUserTurnStrategies(),
                # Long interview answers can include pauses, restarts, and examples.
                # Keep Pipecat's safety net above normal candidate thinking time.
                user_turn_stop_timeout=float(os.getenv("USER_TURN_STOP_TIMEOUT", "45.0")),
            ),
        )

    if os.getenv("DROP_INTERRUPTED_ASSISTANT_CONTEXT", "true").lower() in {"1", "true", "yes"}:
        assistant_aggregator = aggregator.assistant()
        original_reset = assistant_aggregator.reset

        async def _drop_interrupted_assistant_turn(_frame):
            logger.info("[bot] interrupted assistant turn dropped from context")
            await original_reset()
            assistant_aggregator._assistant_turn_start_timestamp = ""

        assistant_aggregator._handle_interruptions = _drop_interrupted_assistant_turn

    tx_user, tx_assistant = (transcript_processors or (None, None))
    stages = [
        transport.input(),
        stt,
        *([tx_user] if tx_user else []),
        aggregator.user(),
        llm,
        # Capture bot text + detect goodbye HERE — LLMTextFrame/LLMFullResponse* frames
        # exist right after the LLM (the TTS consumes them, so they don't reach past output).
        # BotStoppedSpeakingFrame is pushed upstream too, so the goodbye-end still fires.
        *([tx_assistant] if tx_assistant else []),
        EndCallOnGoodbye(),
        tts,
        transport.output(),
        *([audio_buffer] if audio_buffer else []),   # records mixed user+bot audio
        aggregator.assistant(),
    ]
    pipeline = Pipeline(stages)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            # output rate is driven by the transport (8k telephony / 24k browser),
            # not forced here, so the two don't conflict.
        ),
    )

    async def _greet():
        await task.queue_frames([TTSSpeakFrame(opening_text)])

    task._greet = _greet  # called by the transport's client-connected handler
    task._stt = stt       # exposed so server.py can attach interim-transcript handlers
    logger.info("pipeline task built (STT_VENDOR=%s)", vendor)
    return task
