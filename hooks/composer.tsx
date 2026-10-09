import type { ClientModule } from 'claude-code'

/**
 * The message box under a running agent's detail: a full-width box that wraps what you type
 * and grows a line at a time, instead of a one-line field that scrolls sideways.
 *
 * It runs on the surface itself and edits its own text: characters and pastes insert at the
 * caret, ←/→ and Home/End move it, Backspace/Delete remove, Shift+Enter starts a new line, and
 * Enter posts the text to the hooks module, which delivers it to the agent. Should delivery
 * fail, the hooks module hands the text back (`restore`) and it reappears here.
 */
type Props = {
  agentId: string
  /** Drawn in a terminal: Shift+Enter is not told apart from Enter there, so the hint differs. */
  terminal?: boolean
  placeholder?: string
  /** Text to put back in the box, once per `n`. */
  restore?: { text: string; n: number }
}
type State = { text: string; caret: number; active: boolean; restored: number }

// Keys a surface reports by name. `space` is a key name too, typed as a space; the rest insert
// nothing. A string that is none of these is a character or a paste, inserted as it came.
const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert', 'space',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])
const CARET = '▏'

const Composer: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state

  if (state === undefined) {
    state = { text: '', caret: 0, active: false, restored: 0 }
    surface.onPointer(event => {
      const now = surface.state
      if (now && event.type === 'down' && !now.active) surface.setState({ ...now, active: true })
    })
    surface.onKey(event => {
      const now = surface.state
      if (!now) return
      const { text, caret } = now
      const put = (next: string, at: number) => surface.setState({ ...now, text: next, caret: at, active: true })
      const key = event.key
      const newline = () => put(text.slice(0, caret) + '\n' + text.slice(caret), caret + 1)
      // Ctrl+J is a line feed in a terminal: a new line, never a send.
      if (event.ctrl && key === 'j') return newline()
      if (key === 'return' || key === 'enter') {
        // A new line: Shift+Enter where the surface tells it apart, Alt+Enter anywhere, and in a
        // terminal (which sends Shift+Enter as plain Enter) a backslash right before the caret,
        // as Claude Code's own prompt does: the backslash becomes the line break.
        if (event.shift || event.meta) return newline()
        if (caret > 0 && text[caret - 1] === '\\') return put(text.slice(0, caret - 1) + '\n' + text.slice(caret), caret)
        if (text.trim()) {
          surface.post({ type: 'send', agentId: props.agentId, text })
          surface.setState({ ...now, text: '', caret: 0, active: true })
        }
        return
      }
      if (key === 'escape') return surface.setState({ ...now, active: false })
      if (key === 'backspace') return caret > 0 ? put(text.slice(0, caret - 1) + text.slice(caret), caret - 1) : undefined
      if (key === 'delete') return caret < text.length ? put(text.slice(0, caret) + text.slice(caret + 1), caret) : undefined
      if (key === 'left') return put(text, Math.max(0, caret - 1))
      if (key === 'right') return put(text, Math.min(text.length, caret + 1))
      if (key === 'home') return put(text, text.lastIndexOf('\n', caret - 1) + 1)
      if (key === 'end') {
        const nl = text.indexOf('\n', caret)
        return put(text, nl === -1 ? text.length : nl)
      }
      if (key === 'space') return put(text.slice(0, caret) + ' ' + text.slice(caret), caret + 1)
      if (event.ctrl || event.meta || NAMED.has(key)) return
      // A character, or a paste arriving as one string: insert it at the caret.
      const typed = key.replace(/\r\n?/g, '\n')
      put(text.slice(0, caret) + typed + text.slice(caret), caret + typed.length)
    })
    surface.setState(state)
  }

  // Delivery failed: the hooks module handed the text back. Take it once.
  if (props.restore && props.restore.n !== state.restored) {
    const back = props.restore
    state = { ...state, text: back.text, caret: back.text.length, restored: back.n, active: true }
    surface.setState(state)
  }

  const { text, caret, active } = state
  const shown = active ? text.slice(0, caret) + CARET + text.slice(caret) : text
  const lines = shown.split('\n')

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderDimColor={!active} borderColor={active ? 'text' : undefined} paddingX={1}>
      {text === '' ? (
        <Box flexDirection="row">
          {active && <Text>{CARET}</Text>}
          <Text dimColor>{props.placeholder ?? 'Message this subagent'}</Text>
        </Box>
      ) : (
        lines.map(line => <Text wrap="wrap">{line === '' ? ' ' : line}</Text>)
      )}
      <Box flexDirection="row">
        <Box flexGrow={1} />
        <Text dimColor>{props.terminal ? '↵ send · ctrl+j or \\↵ new line' : '↵ send · ⇧↵ new line'}</Text>
      </Box>
    </Box>
  )
}

export default Composer
