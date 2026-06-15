/**
 * renderer/panels/LlmAssist.tsx — Task 25
 *
 * "Ask your LLM" flow for unresolved parts (Spec §8.7):
 *
 *   1. Display the generated prompt (built by buildLlmPrompt).
 *   2. "Copy prompt" button → navigator.clipboard.writeText().
 *   3. Paste box: user pastes the LLM's .subckt response.
 *   4. Validate button: send a test deck (subckt + dummy sources) to SimHost via
 *      the injected `validateSubckt` callback. The test deck loads with
 *      `loadCircuit`; if ngspice accepts it without error, it's valid.
 *   5. On validation success → save to user library with provenance 'llm-generated'
 *      via the `onSave` callback (provided by the parent / store integration).
 *   6. Pin-map editor is force-opened after save (never auto-trust LLM pin order).
 *
 * The panel is stateful (paste text, validation state) but pure React — all
 * persistence is done through the injected callbacks so the panel is testable.
 *
 * Unit-tested at the store level (mock validateSubckt). UI render is validated
 * by the build + Phase 6 E2E.
 *
 * Spec §8.7, Task 25.
 */

import React, { useState, useCallback } from 'react'
import { buildLlmPrompt } from '../../../core/models/llmPrompt'
import type { PadInfo } from '../../../core/models/llmPrompt'
import type { Part } from '../../../core/netlist/extract'
import type { PinMap } from '../../../core/models/types'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export interface LlmAssistProps {
  part: Part
  /** Ordered list of pad numbers + optional schematic pin names. */
  padList: PadInfo[]
  /**
   * Called to validate a pasted .subckt block against ngspice.
   * Builds a minimal test deck (subckt + dummy sources) and returns ok/error.
   * Injected so the component stays pure-React and testable with a mock.
   */
  validateSubckt(subcktText: string, part: Part): Promise<ValidationResult>
  /**
   * Called when validation succeeds: persist to the user library.
   * The parent (usually the store integration) saves the binding with
   * provenance 'llm-generated' and opens the pin-map editor.
   */
  onSave(mpn: string, subcktText: string, suggestedPinMap: PinMap): void
  /** Close this panel. */
  onClose(): void
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LlmAssist({
  part,
  padList,
  validateSubckt,
  onSave,
  onClose,
}: LlmAssistProps): React.ReactElement {
  const [pastedText, setPastedText] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  const prompt = buildLlmPrompt(part, padList)

  const mpnFromProps =
    part.properties['MPN'] ??
    part.properties['Part Number'] ??
    part.properties['mpn']
  const mpn = mpnFromProps ?? (part.value || part.ref)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available (e.g. in test runner): silently ignore.
    }
  }, [prompt])

  const handleValidate = useCallback(async () => {
    const text = pastedText.trim()
    if (!text) return
    setValidating(true)
    setValidationResult(null)
    try {
      const result = await validateSubckt(text, part)
      setValidationResult(result)
    } catch (err) {
      setValidationResult({ ok: false, error: String(err) })
    } finally {
      setValidating(false)
    }
  }, [pastedText, validateSubckt, part])

  const handleSave = useCallback(() => {
    if (!validationResult?.ok) return
    // Build a suggested pin map from the padList: pad number → pin name (or positional index).
    const suggestedPinMap: PinMap = {}
    padList.forEach((p, idx) => {
      suggestedPinMap[p.number] = p.name ?? String(idx + 1)
    })
    onSave(mpn, pastedText.trim(), suggestedPinMap)
    setSaved(true)
  }, [validationResult, padList, onSave, mpn, pastedText])

  return (
    <div style={panelStyle} data-testid="llm-assist-panel">
      <div style={headerStyle}>
        <span style={titleStyle}>Ask your LLM — {mpn}</span>
        <button style={closeBtnStyle} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* Step 1: Copy prompt */}
      <section style={sectionStyle}>
        <div style={stepLabelStyle}>Step 1: Copy this prompt into your LLM</div>
        <pre style={promptPreStyle} aria-label="generated LLM prompt">
          {prompt}
        </pre>
        <button
          style={{ ...actionBtnStyle, background: copied ? '#27ae60' : '#2c3e50' }}
          onClick={handleCopy}
          aria-label="Copy prompt to clipboard"
        >
          {copied ? 'Copied!' : 'Copy prompt'}
        </button>
      </section>

      {/* Step 2: Paste response */}
      <section style={sectionStyle}>
        <div style={stepLabelStyle}>Step 2: Paste the .subckt response here</div>
        <textarea
          style={textareaStyle}
          value={pastedText}
          onChange={e => {
            setPastedText(e.target.value)
            setValidationResult(null)
            setSaved(false)
          }}
          placeholder=".subckt NE555 gnd trig out reset ctrl thres disch vcc&#10;* ... model body ...&#10;.ends NE555"
          rows={10}
          aria-label="paste subckt here"
          data-testid="subckt-paste-box"
          spellCheck={false}
        />
      </section>

      {/* Step 3: Validate */}
      <section style={sectionStyle}>
        <div style={stepLabelStyle}>Step 3: Validate against ngspice</div>
        <button
          style={{
            ...actionBtnStyle,
            background: validating ? '#555' : '#2980b9',
            cursor: validating ? 'not-allowed' : 'pointer',
          }}
          onClick={handleValidate}
          disabled={validating || !pastedText.trim()}
          aria-label="Validate pasted subckt"
          data-testid="validate-button"
        >
          {validating ? 'Validating…' : 'Validate with ngspice'}
        </button>

        {validationResult && (
          <div
            style={{
              ...validationResultStyle,
              background: validationResult.ok ? '#1a3a1a' : '#3a1a1a',
              borderColor: validationResult.ok ? '#2ecc71' : '#e74c3c',
            }}
            data-testid={validationResult.ok ? 'validation-ok' : 'validation-error'}
          >
            {validationResult.ok ? (
              <span style={{ color: '#2ecc71' }}>
                ngspice accepted the model — it loaded without errors.
              </span>
            ) : (
              <>
                <span style={{ color: '#e74c3c', fontWeight: 600 }}>
                  ngspice rejected the model:
                </span>
                <pre style={errorPreStyle}>{validationResult.error}</pre>
                <div style={{ color: '#aaa', fontSize: 11, marginTop: 4 }}>
                  Nothing has been saved. Revise the subckt and try again.
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* Step 4: Save (only shown after successful validation) */}
      {validationResult?.ok && !saved && (
        <section style={sectionStyle}>
          <div style={stepLabelStyle}>Step 4: Save to your library</div>
          <div style={{ color: '#d9a', fontSize: 12, marginBottom: 6 }}>
            Important: the pin map below is a suggestion based on pad/pin names.
            You MUST verify it matches the datasheet — wrong pin maps produce
            confidently-wrong simulations.
          </div>
          <button
            style={{ ...actionBtnStyle, background: '#8e44ad' }}
            onClick={handleSave}
            aria-label="Save model to user library"
            data-testid="save-button"
          >
            Save to my library (opens pin-map editor)
          </button>
        </section>
      )}

      {saved && (
        <section style={sectionStyle}>
          <div style={{ color: '#2ecc71', fontSize: 13 }}>
            Saved! The pin-map editor is now open — please verify the terminal
            assignments match the datasheet before simulating.
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#12101a',
  color: '#eee',
  border: '1px solid #3a2a4a',
  borderRadius: 8,
  maxHeight: '90vh',
  overflowY: 'auto',
  minWidth: 400,
  maxWidth: 640,
  fontSize: 13,
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid #2a1a3a',
  background: '#1a1028',
}

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
}

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 16,
  cursor: 'pointer',
  lineHeight: 1,
  padding: '0 4px',
}

const sectionStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid #1a1020',
}

const stepLabelStyle: React.CSSProperties = {
  color: '#aaa',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 8,
}

const promptPreStyle: React.CSSProperties = {
  background: '#0c0a14',
  border: '1px solid #2a1a3a',
  borderRadius: 4,
  padding: '8px 10px',
  fontSize: 11,
  color: '#bbb',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  maxHeight: 200,
  overflowY: 'auto',
  marginBottom: 8,
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  background: '#0c0a14',
  border: '1px solid #2a1a3a',
  borderRadius: 4,
  padding: '8px 10px',
  color: '#ddd',
  fontSize: 12,
  fontFamily: 'monospace',
  resize: 'vertical',
  boxSizing: 'border-box',
}

const actionBtnStyle: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '6px 14px',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 600,
}

const validationResultStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  borderRadius: 4,
  border: '1px solid',
  fontSize: 12,
}

const errorPreStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: '#e74c3c',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 160,
  overflowY: 'auto',
}
