import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_DELAY_MS = 2000
const DEFAULT_DELAY_MS = 1000
const DEFAULT_ECHO_VOLUME = 72
const DEFAULT_DRY_VOLUME = 0

type MicStatus = 'off' | 'starting' | 'active' | 'blocked'

type LegacyAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

const statusCopy: Record<MicStatus, string> = {
  off: 'Mic is off.',
  starting: 'Starting mic and asking for access...',
  active: 'Mic is active. Speak slowly into the delayed echo.',
  blocked: 'Mic could not start.',
}

function readMicError(error: unknown) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support microphone capture. Open the Vercel HTTPS link in Safari or Chrome.'
  }

  if (!(error instanceof DOMException)) {
    return 'The microphone could not start. Check browser microphone access and try again.'
  }

  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access for this site, then tap Start Mic again.'
  }

  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect or enable a microphone and try again.'
  }

  return 'The microphone could not start. Check your device audio settings and try again.'
}

function SliderControl({
  label,
  max,
  min = 0,
  onChange,
  step,
  value,
  valueLabel,
}: {
  label: string
  max: number
  min?: number
  onChange: (value: number) => void
  step: number
  value: number
  valueLabel: string
}) {
  return (
    <label className="block min-w-0 overflow-hidden rounded-[1.5rem] border border-white/8 bg-white/[0.045] p-4 sm:p-5">
      <span className="mb-4 flex items-baseline justify-between gap-4">
        <span className="text-base font-semibold text-zinc-100">{label}</span>
        <span className="text-sm font-bold text-[#f5bf69]">{valueLabel}</span>
      </span>
      <input
        className="echo-range w-full"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  )
}

export default function App() {
  const [delayMs, setDelayMs] = useState(DEFAULT_DELAY_MS)
  const [echoVolume, setEchoVolume] = useState(DEFAULT_ECHO_VOLUME)
  const [dryVolume, setDryVolume] = useState(DEFAULT_DRY_VOLUME)
  const [micLevel, setMicLevel] = useState(0)
  const [status, setStatus] = useState<MicStatus>('off')
  const [errorMessage, setErrorMessage] = useState('')

  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const delayNodeRef = useRef<DelayNode | null>(null)
  const dryGainRef = useRef<GainNode | null>(null)
  const echoGainRef = useRef<GainNode | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startAttemptRef = useRef(0)
  const startingRef = useRef(false)

  const stopLevelMeter = useCallback(() => {
    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current)
      meterFrameRef.current = null
    }

    setMicLevel(0)
  }, [])

  const releaseAudioGraph = useCallback(() => {
    stopLevelMeter()

    micSourceRef.current?.disconnect()
    analyserRef.current?.disconnect()
    delayNodeRef.current?.disconnect()
    echoGainRef.current?.disconnect()
    dryGainRef.current?.disconnect()

    streamRef.current?.getTracks().forEach((track) => track.stop())

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close()
    }

    analyserRef.current = null
    audioContextRef.current = null
    delayNodeRef.current = null
    dryGainRef.current = null
    echoGainRef.current = null
    micSourceRef.current = null
    streamRef.current = null
  }, [stopLevelMeter])

  const startLevelMeter = useCallback((analyser: AnalyserNode) => {
    const samples = new Uint8Array(analyser.fftSize)

    const drawMeter = () => {
      analyser.getByteTimeDomainData(samples)

      let squaredSignal = 0
      for (const sample of samples) {
        const centeredSample = (sample - 128) / 128
        squaredSignal += centeredSample * centeredSample
      }

      const rms = Math.sqrt(squaredSignal / samples.length)
      setMicLevel(Math.min(100, Math.round(rms * 320)))
      meterFrameRef.current = requestAnimationFrame(drawMeter)
    }

    drawMeter()
  }, [])

  const startMic = useCallback(async () => {
    if (startingRef.current || streamRef.current) {
      return
    }

    const AudioContextClass =
      window.AudioContext ?? (window as LegacyAudioWindow).webkitAudioContext

    if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass) {
      setErrorMessage(
        'This browser does not support microphone capture. Open the Vercel HTTPS link in Safari or Chrome.',
      )
      setStatus('blocked')
      return
    }

    startingRef.current = true
    const startAttempt = startAttemptRef.current + 1
    startAttemptRef.current = startAttempt
    setErrorMessage('')
    setStatus('starting')

    let audioContext: AudioContext | null = null
    let stream: MediaStream | null = null

    try {
      // Create and unlock Web Audio only after the Start Mic tap. This matters
      // on iPhone Safari, which blocks audio that is started outside a gesture.
      audioContext = new AudioContextClass()
      audioContextRef.current = audioContext

      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      if (startAttempt !== startAttemptRef.current) {
        stream.getTracks().forEach((track) => track.stop())

        if (audioContext.state !== 'closed') {
          void audioContext.close()
        }

        if (audioContextRef.current === audioContext) {
          audioContextRef.current = null
        }

        return
      }

      const micSource = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      const delayNode = audioContext.createDelay(MAX_DELAY_MS / 1000)
      const echoGain = audioContext.createGain()
      const dryGain = audioContext.createGain()

      analyser.fftSize = 1024
      delayNode.delayTime.value = delayMs / 1000
      echoGain.gain.value = echoVolume / 100
      dryGain.gain.value = dryVolume / 100

      // Live microphone graph:
      // mic -> analyser -> DelayNode -> echo GainNode -> speakers
      // mic -> dry GainNode -> speakers (off by default)
      micSource.connect(analyser)
      analyser.connect(delayNode)
      delayNode.connect(echoGain)
      echoGain.connect(audioContext.destination)
      micSource.connect(dryGain)
      dryGain.connect(audioContext.destination)

      analyserRef.current = analyser
      delayNodeRef.current = delayNode
      dryGainRef.current = dryGain
      echoGainRef.current = echoGain
      micSourceRef.current = micSource
      streamRef.current = stream

      startLevelMeter(analyser)
      setStatus('active')
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())

      if (startAttempt !== startAttemptRef.current) {
        if (audioContext && audioContext.state !== 'closed') {
          void audioContext.close()
        }

        if (audioContextRef.current === audioContext) {
          audioContextRef.current = null
        }

        return
      }

      releaseAudioGraph()
      setErrorMessage(readMicError(error))
      setStatus('blocked')
    } finally {
      startingRef.current = false
    }
  }, [
    delayMs,
    dryVolume,
    echoVolume,
    releaseAudioGraph,
    startLevelMeter,
  ])

  const stopMic = useCallback(() => {
    startAttemptRef.current += 1
    startingRef.current = false
    releaseAudioGraph()
    setErrorMessage('')
    setStatus('off')
  }, [releaseAudioGraph])

  useEffect(() => {
    const audioContext = audioContextRef.current
    const delayNode = delayNodeRef.current

    if (audioContext && delayNode) {
      delayNode.delayTime.setTargetAtTime(
        delayMs / 1000,
        audioContext.currentTime,
        0.02,
      )
    }
  }, [delayMs])

  useEffect(() => {
    const audioContext = audioContextRef.current
    const echoGain = echoGainRef.current

    if (audioContext && echoGain) {
      echoGain.gain.setTargetAtTime(
        echoVolume / 100,
        audioContext.currentTime,
        0.02,
      )
    }
  }, [echoVolume])

  useEffect(() => {
    const audioContext = audioContextRef.current
    const dryGain = dryGainRef.current

    if (audioContext && dryGain) {
      dryGain.gain.setTargetAtTime(
        dryVolume / 100,
        audioContext.currentTime,
        0.02,
      )
    }
  }, [dryVolume])

  useEffect(
    () => () => {
      startAttemptRef.current += 1
      releaseAudioGraph()
    },
    [releaseAudioGraph],
  )

  return (
    <main className="min-h-svh overflow-hidden bg-[#080908] px-4 py-5 text-zinc-100 sm:px-6 sm:py-8">
      <section className="mx-auto flex min-w-0 w-full max-w-5xl flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.32fr)_minmax(18rem,0.68fr)] lg:gap-5">
        <div className="relative min-w-0 overflow-hidden rounded-[2rem] border border-white/10 bg-[#111412] p-5 shadow-console sm:p-7">
          <div className="console-grid absolute inset-0 opacity-55" aria-hidden="true" />
          <div className="relative">
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-[#66d7c6]">
              Delayed speech monitor
            </p>
            <h1 className="mt-3 max-w-2xl text-4xl font-black leading-none text-white sm:text-6xl">
              Echo Practice
            </h1>
            <p className="mt-4 max-w-xl break-words text-base leading-7 text-zinc-300 sm:text-lg">
              Hear your own voice a beat later while you rehearse pace, focus,
              and composure.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                className="min-h-20 rounded-[1.4rem] bg-[#f5bf69] px-5 text-xl font-black text-[#171108] transition hover:bg-[#ffce84] focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#f5bf69]/55 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                disabled={status === 'active' || status === 'starting'}
                onClick={() => void startMic()}
                type="button"
              >
                Start Mic
              </button>
              <button
                className="min-h-20 rounded-[1.4rem] border border-[#ff776e]/35 bg-[#291413] px-5 text-xl font-black text-[#ffd1cd] transition hover:border-[#ff776e]/60 hover:bg-[#351816] focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#ff776e]/45 disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.035] disabled:text-zinc-500"
                disabled={status === 'off'}
                onClick={stopMic}
                type="button"
              >
                Stop Mic
              </button>
            </div>

            <div className="mt-4 rounded-[1.6rem] border border-white/10 bg-black/35 p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-sm font-bold uppercase tracking-[0.12em] text-zinc-400">
                    Status
                  </p>
                  <p
                    className="mt-2 text-lg font-semibold text-white"
                    role="status"
                  >
                    {statusCopy[status]}
                  </p>
                </div>
                <span
                  className={`inline-flex w-fit items-center rounded-full px-3 py-1.5 text-sm font-bold ${
                    status === 'active'
                      ? 'bg-[#66d7c6]/16 text-[#92eee0]'
                      : status === 'blocked'
                        ? 'bg-[#ff776e]/16 text-[#ffb3ad]'
                        : 'bg-white/8 text-zinc-300'
                  }`}
                >
                  {status}
                </span>
              </div>

              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-zinc-300">
                    Mic level
                  </span>
                  <span className="text-sm text-zinc-400">{micLevel}%</span>
                </div>
                <div
                  aria-label={`Microphone level ${micLevel} percent`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={micLevel}
                  className="h-5 overflow-hidden rounded-full border border-white/10 bg-[#050605]"
                  role="meter"
                >
                  <div
                    className="meter-fill h-full rounded-full"
                    style={{ width: `${Math.max(3, micLevel)}%` }}
                  />
                </div>
              </div>

              {errorMessage && (
                <p
                  className="mt-4 rounded-[1.1rem] border border-[#ff776e]/28 bg-[#ff776e]/12 p-3 text-sm leading-6 text-[#ffd1cd]"
                  role="alert"
                >
                  {errorMessage}
                </p>
              )}
            </div>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <div className="rounded-[2rem] border border-white/10 bg-[#121513] p-5 shadow-console sm:p-6">
            <h2 className="text-xl font-black text-white">Monitor</h2>
            <div className="mt-4 flex flex-col gap-3">
              <SliderControl
                label="Delay"
                max={MAX_DELAY_MS}
                onChange={setDelayMs}
                step={25}
                value={delayMs}
                valueLabel={`${delayMs} ms`}
              />
              <SliderControl
                label="Echo volume"
                max={100}
                onChange={setEchoVolume}
                step={1}
                value={echoVolume}
                valueLabel={`${echoVolume}%`}
              />
              <SliderControl
                label="Dry voice volume"
                max={100}
                onChange={setDryVolume}
                step={1}
                value={dryVolume}
                valueLabel={`${dryVolume}%`}
              />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <button
                className="min-h-16 rounded-[1.25rem] border border-[#66d7c6]/28 bg-[#66d7c6]/10 px-4 text-left text-base font-bold text-[#b8fff3] transition hover:border-[#66d7c6]/50 hover:bg-[#66d7c6]/16 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#66d7c6]/35"
                onClick={() => {
                  setDelayMs(800)
                  setEchoVolume(95)
                }}
                type="button"
              >
                Speech Jammer Mode
              </button>
              <button
                className="min-h-16 rounded-[1.25rem] border border-[#f5bf69]/25 bg-[#f5bf69]/10 px-4 text-left text-base font-bold text-[#ffe0a8] transition hover:border-[#f5bf69]/48 hover:bg-[#f5bf69]/16 focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#f5bf69]/35"
                onClick={() => {
                  setDelayMs(1000)
                  setEchoVolume(62)
                }}
                type="button"
              >
                Auditorium Mode
              </button>
            </div>
          </div>
        </aside>

        <div className="grid gap-4 lg:col-span-2 lg:grid-cols-3">
          <article className="rounded-[1.7rem] border border-white/10 bg-[#111412] p-5 text-sm leading-6 text-zinc-300">
            <h2 className="mb-2 text-lg font-black text-white">
              Phone setup
            </h2>
            <p>
              Use Safari, not an in-app browser. Wear headphones to prevent
              feedback.
            </p>
          </article>
          <article className="rounded-[1.7rem] border border-white/10 bg-[#111412] p-5 text-sm leading-6 text-zinc-300">
            <h2 className="mb-2 text-lg font-black text-white">
              iPhone testing
            </h2>
            <p>
              Testing from a laptop&apos;s local IP may not allow microphone
              access on iPhone. Use the deployed HTTPS URL.
            </p>
          </article>
          <article className="rounded-[1.7rem] border border-white/10 bg-[#111412] p-5 text-sm leading-6 text-zinc-300">
            <h2 className="mb-2 text-lg font-black text-white">
              Quick start
            </h2>
            <p>
              Deploy to Vercel, open the link on your iPhone in Safari, put on
              headphones, tap Start Mic, then speak slowly through the delayed
              echo.
            </p>
          </article>
        </div>
      </section>
    </main>
  )
}
