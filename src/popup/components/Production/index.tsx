import { Checkbox, InputNumber, Segmented, Select, Slider, Switch } from 'antd'
import { ChevronDown, ChevronUp, Contrast, Droplet, EyeOff } from 'lucide-react'
import React, { useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'

import { REVEAL_PAGE_SENSITIVE, RevealPageSensitiveResponse } from '../../../utils/messages'
import { CLASSIFIER_BACKENDS, CLASSIFIER_BACKEND_LABELS, ClassifierBackend } from '../../../utils/models'
import {
  setAutoDlFrames,
  setClassifierBackend,
  setDynamicMediaSettings,
  setFilterEffect,
  setFilterStrictness,
  setInterImageAwareness,
  toggleEnabled,
  toggleLogging
} from '../../redux/actions/settings/index'
import { RootState } from '../../redux/reducers'
import { SettingsState } from '../../redux/reducers/settings'
import { StatisticsState } from '../../redux/reducers/statistics'

import { AllowSiteField } from './AllowSiteField'
import {
  Container,
  Stat,
  StatNumber,
  StatCaption,
  PowerRow,
  PowerText,
  PowerTitle,
  PowerHint,
  Card,
  Field,
  EffectField,
  FieldHead,
  FieldLabel,
  FieldValue,
  SliderEnds,
  AllowRow,
  AllowText,
  AllowHost,
  ManageLink,
  AdvancedToggle,
  AdvancedPanel,
  AdvancedRow,
  Hint,
  RevealButton,
  SectionTitle,
  TuningGrid,
  TuningLabel,
  Warning
} from './styles'

type NumericSettingKey =
  | 'dynamicSampleRatio'
  | 'dynamicPositiveRatio'
  | 'dynamicMinSamples'
  | 'dynamicMaxSamples'
  | 'dynamicMaxConcurrentGlobal'
  | 'dynamicMaxConcurrentPerTab'
  | 'dynamicQueueLimitPerTab'
  | 'interImageAwarenessMinCount'
  | 'interImageAwarenessMinRatio'
  | 'autoDlSignatureThreshold'
  | 'autoDlMaxPairsPerVideo'
  | 'autoDlMaxPairsPerSession'

type Tuning = { key: NumericSettingKey, label: string, min: number, max: number, step: number }

const DYNAMIC_TUNING: Tuning[] = [
  { key: 'dynamicSampleRatio', label: 'Sample ratio', min: 0.01, max: 1, step: 0.01 },
  { key: 'dynamicPositiveRatio', label: 'Positive ratio', min: 0.01, max: 1, step: 0.01 },
  { key: 'dynamicMinSamples', label: 'Min samples', min: 1, max: 20, step: 1 },
  { key: 'dynamicMaxSamples', label: 'Max samples', min: 1, max: 30, step: 1 },
  { key: 'dynamicMaxConcurrentGlobal', label: 'Global concurrency', min: 1, max: 4, step: 1 },
  { key: 'dynamicMaxConcurrentPerTab', label: 'Per-tab concurrency', min: 1, max: 2, step: 1 },
  { key: 'dynamicQueueLimitPerTab', label: 'Queue limit per tab', min: 5, max: 100, step: 1 }
]

const AWARENESS_TUNING: Tuning[] = [
  { key: 'interImageAwarenessMinCount', label: 'Page trigger: flagged', min: 1, max: 50, step: 1 },
  { key: 'interImageAwarenessMinRatio', label: 'Page trigger: share', min: 0.05, max: 1, step: 0.05 }
]

const AUTO_DL_TUNING: Tuning[] = [
  { key: 'autoDlSignatureThreshold', label: 'Swing threshold', min: 0.05, max: 1, step: 0.05 },
  { key: 'autoDlMaxPairsPerVideo', label: 'Max pairs per video', min: 1, max: 10, step: 1 },
  { key: 'autoDlMaxPairsPerSession', label: 'Max pairs per session', min: 1, max: 200, step: 1 }
]

export const Production: React.FC = () => {
  const dispatch = useDispatch()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [revealResult, setRevealResult] = useState<string | null>(null)
  const [autoDlNotice, setAutoDlNotice] = useState<string | null>(null)
  const settings = useSelector<RootState>((state) => state.settings) as SettingsState
  const {
    enabled,
    filterStrictness,
    classifierBackend,
    filterEffect,
    logging,
    interImageAwarenessEnabled,
    autoDlFramesEnabled
  } = settings
  const { totalBlocked } = useSelector<RootState>((state) => state.statistics) as StatisticsState

  const setNumber = (key: NumericSettingKey, value: number | null): void => {
    if (value === null) return
    if (key.startsWith('dynamic')) dispatch(setDynamicMediaSettings({ [key]: value }))
    else if (key.startsWith('interImage')) dispatch(setInterImageAwareness({ [key]: value }))
    else dispatch(setAutoDlFrames({ [key]: value }))
  }

  const renderTuning = (rows: Tuning[], disabled = false): React.ReactElement => (
    <TuningGrid>
      {rows.map(({ key, label, min, max, step }) => (
        <React.Fragment key={key}>
          <TuningLabel>{label}</TuningLabel>
          <InputNumber
            size="small"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={settings[key]}
            onChange={value => setNumber(key, value)}
          />
        </React.Fragment>
      ))}
    </TuningGrid>
  )

  // "downloads" is optional in the manifest: it is requested here, from the
  // click that turns the feature on, and dropped again when it is turned off.
  const toggleAutoDlFrames = (checked: boolean): void => {
    setAutoDlNotice(null)
    if (!checked) {
      dispatch(setAutoDlFrames({ autoDlFramesEnabled: false }))
      chrome.permissions.remove({ permissions: ['downloads'] }, () => {
        if (chrome.runtime.lastError !== undefined) { /* handled */ }
      })
      return
    }

    chrome.permissions.request({ permissions: ['downloads'] }, granted => {
      if (chrome.runtime.lastError !== null && chrome.runtime.lastError !== undefined) granted = false
      if (granted) dispatch(setAutoDlFrames({ autoDlFramesEnabled: true }))
      else setAutoDlNotice('Not turned on: the downloads permission was not granted')
    })
  }

  // Affects the current page view only; the stored setting is untouched, so
  // the next page load sweeps again.
  const revealSweptImages = (): void => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id
      if (tabId === undefined) {
        setRevealResult('No active tab')
        return
      }

      chrome.tabs.sendMessage(tabId, { type: REVEAL_PAGE_SENSITIVE }, (response: RevealPageSensitiveResponse) => {
        if (chrome.runtime.lastError !== null && chrome.runtime.lastError !== undefined) {
          setRevealResult('Not available on this page')
          return
        }

        const revealed = response?.revealed ?? 0
        setRevealResult(revealed > 0
          ? `Showing ${revealed} image${revealed === 1 ? '' : 's'} on this page`
          : 'Nothing swept on this page')
      })
    })
  }

  return (
    <Container>
      <Stat>
        <StatNumber>{totalBlocked.toLocaleString()}</StatNumber>
        <StatCaption>images blocked</StatCaption>
      </Stat>

      <PowerRow>
        <PowerText>
          <PowerTitle>Protection</PowerTitle>
          <PowerHint>{enabled ? 'On' : 'Paused'}. Reload open tabs to apply</PowerHint>
        </PowerText>
        <Switch checked={enabled} onChange={() => dispatch(toggleEnabled())} />
      </PowerRow>

      <Card>
        <Field>
          <FieldHead>
            <FieldLabel>Filter strictness</FieldLabel>
            <FieldValue>{filterStrictness}%</FieldValue>
          </FieldHead>
          <Slider
            min={1}
            max={100}
            value={filterStrictness}
            tooltip={{ open: false }}
            onChange={(value: number) => dispatch(setFilterStrictness(value))}
          />
          <SliderEnds>
            <span>Lenient</span>
            <span>Strict</span>
          </SliderEnds>
        </Field>

        <EffectField>
          <FieldLabel>Filter effect</FieldLabel>
          <Segmented<'blur' | 'grayscale' | 'hide'>
            block
            style={{ marginTop: 8 }}
            value={filterEffect}
            onChange={value => dispatch(setFilterEffect(value))}
            options={[
              { label: 'Blur', value: 'blur', icon: <Droplet size={14} /> },
              { label: 'Gray', value: 'grayscale', icon: <Contrast size={14} /> },
              { label: 'Hide', value: 'hide', icon: <EyeOff size={14} /> }
            ]}
          />
        </EffectField>

        <AllowRow>
          <AllowText>
            <FieldLabel>Page-wide protection</FieldLabel>
            <AllowHost>Filters a whole page once enough of its media is flagged</AllowHost>
          </AllowText>
          <Switch
            checked={interImageAwarenessEnabled}
            onChange={checked => dispatch(setInterImageAwareness({ interImageAwarenessEnabled: checked }))}
          />
        </AllowRow>
        {interImageAwarenessEnabled && (
          <>
            <RevealButton onClick={revealSweptImages}>Show this page anyway</RevealButton>
            {revealResult !== null && <Hint>{revealResult}</Hint>}
          </>
        )}

        <AllowSiteField />
        <ManageLink onClick={() => chrome.runtime.openOptionsPage()}>
          Manage allowed sites and text filter
        </ManageLink>
      </Card>

      <div>
        <AdvancedToggle
          aria-expanded={advancedOpen}
          aria-controls="advanced-panel"
          onClick={() => setAdvancedOpen(open => !open)}
        >
          {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          Advanced
        </AdvancedToggle>
        {advancedOpen && (
          <AdvancedPanel id="advanced-panel">
            <AdvancedRow>
              <FieldLabel>Classifier</FieldLabel>
              <Select<ClassifierBackend>
                value={classifierBackend}
                style={{ width: 170 }}
                onChange={value => dispatch(setClassifierBackend(value))}
                options={CLASSIFIER_BACKENDS.map(value => ({ value, label: CLASSIFIER_BACKEND_LABELS[value] }))}
              />
            </AdvancedRow>

            <SectionTitle>Video and GIF sampling</SectionTitle>
            {renderTuning(DYNAMIC_TUNING)}

            <SectionTitle>Page-wide protection</SectionTitle>
            {renderTuning(AWARENESS_TUNING, !interImageAwarenessEnabled)}

            <AdvancedRow>
              <PowerText>
                <FieldLabel>Save frames on score swings</FieldLabel>
                <Hint>{autoDlFramesEnabled ? 'On. Applies to videos classified from now on' : 'For reviewing classifier mistakes'}</Hint>
              </PowerText>
              <Switch size="small" checked={autoDlFramesEnabled} onChange={toggleAutoDlFrames} />
            </AdvancedRow>
            {autoDlNotice !== null && <Hint>{autoDlNotice}</Hint>}
            {autoDlFramesEnabled && (
              <>
                <Warning>
                  When the score of one sampled video frame differs sharply from the previous one,
                  both frames are saved as PNG images, with a JSON file of their scores, to
                  Downloads/nsfw-filter-frames. These frames can be explicit. Nothing is uploaded.
                </Warning>
                {renderTuning(AUTO_DL_TUNING)}
              </>
            )}

            <Checkbox checked={logging} onChange={() => dispatch(toggleLogging())}>
              Show logs in browser console
            </Checkbox>
          </AdvancedPanel>
        )}
      </div>
    </Container>
  )
}
