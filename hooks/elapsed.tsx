import type { ClientModule } from 'claude-code'

/**
 * A live elapsed-time readout that runs on the surface itself.
 *
 * The hooks module hands it the elapsed time as of its drawing (`baseMs`); from there it counts
 * up on the surface's own frame clock, a second at a time, with no event from the engine needed.
 * So "Waiting for 1m 12s" keeps moving while the agent waits on work of its own and nothing else
 * redraws the pane. Each new drawing re-bases it on the hooks module's figure, so it never drifts.
 */
type Props = { baseMs: number; prefix?: string; suffix?: string; dim?: boolean }
type State = { base: number; ticks: number }

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const Elapsed: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const state = surface.state
  if (state === undefined) {
    // Start the clock once, on the first call; it lives as long as the instance.
    surface.every(1000, () => {
      const now = surface.state
      if (now) surface.setState({ base: now.base, ticks: now.ticks + 1 })
    })
    surface.setState({ base: props.baseMs, ticks: 0 })
  } else if (state.base !== props.baseMs) {
    // A new drawing from the hooks module: count on from its figure.
    surface.setState({ base: props.baseMs, ticks: 0 })
  }
  const shown = (state && state.base === props.baseMs ? state.base + state.ticks * 1000 : props.baseMs)
  return (
    <Text dimColor={props.dim ?? true}>
      {props.prefix ?? ''}
      {duration(shown)}
      {props.suffix ?? ''}
    </Text>
  )
}

export default Elapsed
