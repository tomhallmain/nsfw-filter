import { Button, Input, Switch } from 'antd'
import React, { useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'

import {
  MAX_TEXT_FILTER_ENTRIES,
  parseEntryLines,
  textEntryError,
  TextEntryKind
} from '../../content/Filter/textMatch'
import { setTextFilter } from '../../popup/redux/actions/settings'
import { RootState } from '../../popup/redux/reducers'
import { SettingsState } from '../../popup/redux/reducers/settings'

import {
  Actions,
  ErrorText,
  FieldCard,
  FieldLabel,
  HintText,
  Inline,
  Section,
  SectionHead,
  SectionTitle,
  Sub
} from './styles'

/** One message per unusable line, numbered as the user sees the text area. */
const lineErrors = (value: string, kind: TextEntryKind, caseSensitive: boolean): string[] => {
  const messages: string[] = []
  let count = 0

  value.split('\n').forEach((line, i) => {
    const entry = line.trim()
    if (entry === '') return

    count++
    const message = count > MAX_TEXT_FILTER_ENTRIES
      ? `Past the limit of ${MAX_TEXT_FILTER_ENTRIES} entries`
      : textEntryError(entry, kind, caseSensitive)
    if (message !== null) messages.push(`Line ${i + 1}: ${message}`)
  })

  return messages
}

const sameEntries = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry === b[i])

export const TextFilterSettings: React.FC = () => {
  const dispatch = useDispatch()
  const {
    textFilterEnabled,
    textFilterWords,
    textFilterPatterns,
    textFilterCaseSensitive
  } = useSelector<RootState>((state) => state.settings) as SettingsState

  // Drafts reach the store only on Save, so a half-typed pattern like `(bad`
  // is never stored.
  const [wordsDraft, setWordsDraft] = useState(textFilterWords.join('\n'))
  const [patternsDraft, setPatternsDraft] = useState(textFilterPatterns.join('\n'))
  const [saved, setSaved] = useState(false)

  const wordErrors = lineErrors(wordsDraft, 'word', textFilterCaseSensitive)
  const patternErrors = lineErrors(patternsDraft, 'regex', textFilterCaseSensitive)
  const words = parseEntryLines(wordsDraft)
  const patterns = parseEntryLines(patternsDraft)
  const unsaved = !sameEntries(words, textFilterWords) || !sameEntries(patterns, textFilterPatterns)
  const canSave = unsaved && wordErrors.length === 0 && patternErrors.length === 0

  const save = (): void => {
    dispatch(setTextFilter({ textFilterWords: words, textFilterPatterns: patterns }))
    setSaved(true)
  }

  return (
    <Section>
      <SectionHead>
        <SectionTitle>Text filter</SectionTitle>
        <Switch
          checked={textFilterEnabled}
          onChange={checked => dispatch(setTextFilter({ textFilterEnabled: checked }))}
        />
      </SectionHead>
      <Sub>
        Replaces matching text on every page with [filtered]. Reload open tabs to
        apply changes.
      </Sub>

      {textFilterEnabled && (
        <FieldCard>
          <FieldLabel htmlFor="text-filter-words">Words</FieldLabel>
          <Input.TextArea
            id="text-filter-words"
            rows={4}
            placeholder="One word or phrase per line"
            value={wordsDraft}
            onChange={event => { setWordsDraft(event.target.value); setSaved(false) }}
          />
          {wordErrors.map(message => <ErrorText key={message}>{message}</ErrorText>)}

          <FieldLabel htmlFor="text-filter-patterns">Regex patterns</FieldLabel>
          <Input.TextArea
            id="text-filter-patterns"
            rows={4}
            placeholder="One regular expression per line"
            value={patternsDraft}
            onChange={event => { setPatternsDraft(event.target.value); setSaved(false) }}
          />
          {patternErrors.map(message => <ErrorText key={message}>{message}</ErrorText>)}
          <HintText>Patterns run on every page; a slow pattern can freeze a tab</HintText>

          <Actions>
            <Inline>
              <Switch
                size="small"
                checked={textFilterCaseSensitive}
                onChange={checked => dispatch(setTextFilter({ textFilterCaseSensitive: checked }))}
              />
              Case-sensitive
            </Inline>
            <Inline>
              {saved && !unsaved && <HintText>Saved</HintText>}
              <Button type="primary" disabled={!canSave} onClick={save}>Save</Button>
            </Inline>
          </Actions>
        </FieldCard>
      )}
    </Section>
  )
}
