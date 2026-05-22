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

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function SliderControl({
  label,
  max,
  min = 0,
  onChange,
  step,
  unit,
  value,
}: {
  label: string
  max: number
  min?: number
  onChange: (value: number) => void
  step: number
  unit: string
  value: number
}) {
  return (
    <label className="block min-w-0 rounded-lg border border-white/8 bg-white/[0.028] px-3 py-2">
      <span className="mb-1.5 flex items-center justify-between gap-3">
        <span className="font-mono text-[0.72rem] font-bold uppercase text-zinc-400">
          {label}
        </span>
        <span className="flex h-8 items-center overflow-hidden rounded-md border border-white/10 bg-black/35 text-sm text-zinc-200 focus-within:border-[#66d7c6]/55">
          <input
            aria-label={`${label} value`}
            className="h-full w-[4.4rem] border-0 bg-transparent px-2 text-right font-mono font-semibold text-white outline-none"
            max={max}
            min={min}
            onChange={(event) => {
              const nextValue = event.currentTarget.valueAsNumber

              if (!Number.isNaN(nextValue)) {
                onChange(clampValue(nextValue, min, max))
              }
            }}
            step={step}
            type="number"
            value={value}
          />
          <span className="border-l border-white/8 px-2 font-mono text-xs uppercase text-zinc-500">
            {unit}
          </span>
        </span>
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
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startAttemptRef = useRef(0)
  const startingRef = useRef(false)

  const drawScopeFrame = useCallback((samples?: Uint8Array) => {
    const canvas = scopeCanvasRef.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context) {
      return
    }

    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    const pixelWidth = Math.round(width * ratio)
    const pixelHeight = Math.round(height * ratio)

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.lineCap = 'round'
    context.lineJoin = 'round'

    context.beginPath()
    context.moveTo(0, height / 2)
    context.lineTo(width, height / 2)
    context.lineWidth = 1
    context.strokeStyle = 'rgba(148, 163, 184, 0.18)'
    context.stroke()

    if (!samples) {
      return
    }

    context.beginPath()
    for (let index = 0; index < samples.length; index += 1) {
      const x = (index / (samples.length - 1)) * width
      const y = (samples[index] / 255) * height

      if (index === 0) {
        context.moveTo(x, y)
      } else {
        context.lineTo(x, y)
      }
    }

    context.lineWidth = 1.7
    context.strokeStyle = '#8ad8cb'
    context.stroke()
  }, [])

  const stopLevelMeter = useCallback(() => {
    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current)
      meterFrameRef.current = null
    }

    setMicLevel(0)
    drawScopeFrame()
  }, [drawScopeFrame])

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
      drawScopeFrame(samples)
      meterFrameRef.current = requestAnimationFrame(drawMeter)
    }

    drawMeter()
  }, [drawScopeFrame])

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

  useEffect(() => {
    const repaintScope = () => drawScopeFrame()

    repaintScope()
    window.addEventListener('resize', repaintScope)

    return () => window.removeEventListener('resize', repaintScope)
  }, [drawScopeFrame])

  return (
    <main className="min-h-svh bg-[#090a0a] px-3 py-3 text-zinc-100 sm:px-5 sm:py-5">
      <section className="mx-auto grid w-full max-w-5xl min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1.36fr)_minmax(19rem,0.64fr)]">
        <section className="studio-panel min-w-0 rounded-xl border border-white/10 p-4 shadow-[0_18px_48px_rgba(0,0,0,0.28)] sm:p-5">
          <header className="flex flex-col gap-3 border-b border-white/8 pb-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-mono text-xs font-bold uppercase text-[#7ed7ca]">
                Delayed Speech Monitor
              </p>
              <h1 className="mt-1.5 text-[1.7rem] font-bold leading-tight text-white sm:text-3xl">
                Echo Practice
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 font-mono text-xs font-bold uppercase ${
                  status === 'active'
                    ? 'border-[#66d7c6]/35 bg-[#66d7c6]/12 text-[#a4f0e5]'
                    : status === 'blocked'
                      ? 'border-[#ff776e]/35 bg-[#ff776e]/10 text-[#ffc0ba]'
                      : 'border-white/10 bg-white/[0.045] text-zinc-300'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    status === 'active'
                      ? 'bg-[#66d7c6]'
                      : status === 'blocked'
                        ? 'bg-[#ff776e]'
                        : 'bg-zinc-500'
                  }`}
                />
                {status}
              </span>
              <span className="inline-flex h-8 items-center rounded-md border border-white/10 bg-black/25 px-2.5 font-mono text-xs text-zinc-300">
                Delay {delayMs} ms
              </span>
            </div>
          </header>

          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div>
              <p className="font-mono text-[0.7rem] font-bold uppercase text-zinc-500">
                Session
              </p>
              <p className="mt-1 min-h-6 text-sm font-medium text-zinc-100" role="status">
                {statusCopy[status]}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="min-h-12 rounded-lg border border-[#66d7c6]/32 bg-[#17302d] px-4 text-base font-semibold text-[#d8fffa] transition hover:border-[#66d7c6]/58 hover:bg-[#1c3a36] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#66d7c6] disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.035] disabled:text-zinc-500"
                disabled={status === 'active' || status === 'starting'}
                onClick={() => void startMic()}
                type="button"
              >
                Start Mic
              </button>
              <button
                className="min-h-12 rounded-lg border border-[#ff776e]/28 bg-[#241716] px-4 text-base font-semibold text-[#ffd4d0] transition hover:border-[#ff776e]/52 hover:bg-[#301b19] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff776e] disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.035] disabled:text-zinc-500"
                disabled={status === 'off'}
                onClick={stopMic}
                type="button"
              >
                Stop Mic
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-white/10 bg-black/32 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-mono text-xs font-bold uppercase text-zinc-400">
                Mic Input Scope
              </h2>
              <span className="font-mono text-xs text-zinc-500">
                Echo gain {echoVolume}% / dry {dryVolume}%
              </span>
            </div>
            <canvas
              aria-label="Live microphone waveform"
              className="scope-grid mt-2 h-28 w-full rounded-md border border-white/8 bg-[#080a0a]"
              ref={scopeCanvasRef}
            />
            <div className="mt-2.5 flex items-center gap-3">
              <span className="w-20 shrink-0 font-mono text-[0.68rem] font-bold uppercase text-zinc-500">
                Input RMS
              </span>
              <div
                aria-label={`Microphone level ${micLevel} percent`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={micLevel}
                className="h-2 min-w-0 flex-1 overflow-hidden rounded-sm border border-white/8 bg-[#050606]"
                role="meter"
              >
                <div
                  className="meter-fill h-full"
                  style={{ width: `${micLevel}%` }}
                />
              </div>
              <span className="w-10 text-right font-mono text-xs text-zinc-400">
                {micLevel}%
              </span>
            </div>
          </div>

          <p className="mt-3 text-sm leading-6 text-zinc-400">
            Put on headphones before monitoring. Speakers can feed the delayed
            signal back into the microphone.
          </p>

          {errorMessage && (
            <p
              className="mt-3 rounded-lg border border-[#ff776e]/28 bg-[#ff776e]/10 p-3 text-sm leading-6 text-[#ffd1cd]"
              role="alert"
            >
              {errorMessage}
            </p>
          )}
        </section>

        <aside className="studio-panel min-w-0 rounded-xl border border-white/10 p-4 shadow-[0_18px_48px_rgba(0,0,0,0.22)] sm:p-5">
          <div className="flex items-baseline justify-between gap-3 border-b border-white/8 pb-3">
            <h2 className="text-lg font-semibold text-white">Monitor</h2>
            <span className="font-mono text-xs uppercase text-zinc-500">
              Settings
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            <SliderControl
              label="Delay"
              max={MAX_DELAY_MS}
              onChange={setDelayMs}
              step={25}
              unit="ms"
              value={delayMs}
            />
            <SliderControl
              label="Echo Gain"
              max={100}
              onChange={setEchoVolume}
              step={1}
              unit="%"
              value={echoVolume}
            />
            <SliderControl
              label="Dry Monitor"
              max={100}
              onChange={setDryVolume}
              step={1}
              unit="%"
              value={dryVolume}
            />
          </div>

          <p className="mt-2 text-xs leading-5 text-zinc-500">
            Dry Monitor stays at 0% unless you need direct voice monitoring.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <button
              className="min-h-11 rounded-lg border border-white/12 bg-white/[0.045] px-3 text-left text-sm font-semibold text-zinc-100 transition hover:border-[#66d7c6]/42 hover:bg-white/[0.075] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#66d7c6]"
              onClick={() => {
                setDelayMs(800)
                setEchoVolume(95)
              }}
              type="button"
            >
              Speech Jammer Mode
            </button>
            <button
              className="min-h-11 rounded-lg border border-white/12 bg-white/[0.045] px-3 text-left text-sm font-semibold text-zinc-100 transition hover:border-[#f5bf69]/40 hover:bg-white/[0.075] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f5bf69]"
              onClick={() => {
                setDelayMs(1000)
                setEchoVolume(62)
              }}
              type="button"
            >
              Auditorium Mode
            </button>
          </div>

          <div className="mt-3 border-t border-white/8 pt-3 text-sm leading-5 text-zinc-400">
            <p>
              On iPhone, open this HTTPS page in Safari, not an in-app browser.
              Put on headphones, tap Start Mic, allow access, and speak slowly.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              A laptop local-IP test link may not allow microphone access on
              iPhone.
            </p>
          </div>
        </aside>
      </section>
    </main>
  )
}
