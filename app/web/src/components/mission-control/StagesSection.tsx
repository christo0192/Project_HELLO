/**
 * Mission Control: Stages (M031 S2).
 *
 * What each Ashby interview stage counts as on the Business impact page: the
 * Christy stage, R1 to R5, Reference check, Offer, Hired, Archived or Other.
 * One row per stage of the live jobs' interview plan, in plan order, each with
 * a picker. Three admin calls and nothing else:
 *
 *   - GET   .../stage-catalog            the stages, as HELLO last read them
 *   - POST  .../stage-catalog/refresh    read the plans from Ashby again
 *   - PATCH .../stage-catalog/:stageId   label one stage
 *
 * The API labels the obvious stages by default and never overwrites a label
 * set here. "Not labelled" clears a label: the stage returns to its default if
 * it has one, and otherwise counts as Other, so it never drops out of the
 * counts. To say a stage is not a milestone, pick Other.
 *
 * A stage Ashby removed from the plan is kept, label and all, for the history
 * that points at it: it is listed after the live stages as "No longer in the
 * Ashby plan", with no position, and left out of the header's counts.
 *
 * While a label saves, its picker is `busy`, not disabled: it opens and takes
 * nothing, but keeps keyboard focus, so a keyboard or screen-reader user stays
 * on the control they just used (a disabled one drops focus to the page).
 *
 * No candidate data: stage titles, Ashby's stage types, positions and labels.
 * A stage's id addresses the PATCH and is never printed or put in an
 * attribute. Labels are plain words in ink: a milestone is not a state, so it
 * takes no family colour. Loading, failed and empty are separate states; a
 * list that failed to load is never shown as empty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { apiErrorCopy } from '../../lib/api-error-copy';
import {
  MILESTONE_OPTIONS,
  labelSavedText,
  milestoneFromKey,
  milestoneKey,
  milestoneSourceLabel,
  refreshNotice,
  stagePosition,
  stageTitle,
  stageTypeLabel,
  type AshbyStageCatalogResponse,
  type AshbyStageCatalogStage,
} from '../../lib/ashby-stages';
import {
  Button,
  Combobox,
  EmptyPanel,
  ErrorPanel,
  InlineNotice,
  LoadingPanel,
  SectionHeader,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '../design';
import type { ComboboxOption, NoticeTone } from '../design';

const DESCRIPTION =
  'What each Ashby interview stage counts as on Business impact. The Christy stage, R1 to R5, ' +
  'Reference Check, Offer, Hired and Archived are labelled by default. A label you set is kept on every refresh.';

const OPTIONS: ComboboxOption[] = MILESTONE_OPTIONS.map((o) => ({ ...o }));

type Load =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; data: AshbyStageCatalogResponse };

interface Notice {
  tone: NoticeTone;
  text: string;
}

/** A thrown API error's own code: the client keeps it as `code`, or as the message. */
function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code) return code;
  return typeof message === 'string' ? message : null;
}

const LABEL_ERRORS: Readonly<Record<string, string>> = {
  not_found: 'This stage is no longer in the catalogue. Refresh from Ashby and try again.',
  invalid_milestone: "HELLO doesn't accept that label.",
  invalid_stage_id: 'This stage is no longer in the catalogue. Refresh from Ashby and try again.',
};

const REFRESH_ERRORS: Readonly<Record<string, string>> = {
  integration_disabled: "The Ashby integration is turned off, so HELLO can't read the interview plans.",
  mission_control_read_error: "HELLO couldn't read its live job mappings. Try again.",
  mission_control_action_error: "HELLO couldn't save the stages. Try again.",
};

function copyFor(map: Readonly<Record<string, string>>, error: unknown): string {
  const code = codeOf(error);
  return code && Object.hasOwn(map, code) ? map[code] : apiErrorCopy(error);
}

function unreadText(n: number): string {
  return n === 1
    ? "1 live job's interview plan hasn't been read yet. Refresh from Ashby to read it."
    : `${n} live jobs' interview plans haven't been read yet. Refresh from Ashby to read them.`;
}

export function StagesSection() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  // One notice at a time: a confirmation goes to the status region, a fault to an alert.
  const [status, setStatus] = useState<Notice | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  // Set in the effect, not only at creation: StrictMode runs effects, their
  // cleanups and the effects again, and the second run must leave it true.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const read = useCallback(async (initial: boolean) => {
    if (initial) setLoad({ state: 'loading' });
    try {
      const data = await api.listAshbyStageCatalog();
      if (mounted.current) setLoad({ state: 'ready', data });
    } catch (e) {
      if (!mounted.current) return;
      // A reload after a refresh keeps the list it has; only a first load fails the section.
      setLoad((prev) => (initial || prev.state !== 'ready' ? { state: 'failed', message: `The stages couldn't load. ${apiErrorCopy(e)}` } : prev));
      if (!initial) setAlert(`The stages couldn't reload. ${apiErrorCopy(e)}`);
    }
  }, []);

  useEffect(() => { void read(true); }, [read]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStatus(null);
    setAlert(null);
    try {
      const { refresh: result } = await api.refreshAshbyStageCatalog();
      if (!mounted.current) return;
      const notice = refreshNotice(result);
      if (notice.tone === 'danger') setAlert(notice.text);
      else setStatus({ tone: notice.tone, text: notice.text });
      await read(false);
    } catch (e) {
      if (mounted.current) setAlert(`Couldn't refresh from Ashby. ${copyFor(REFRESH_ERRORS, e)}`);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [read]);

  // One save per stage at a time; the picker is busy meanwhile.
  const savingRef = useRef<Set<string>>(new Set());
  const label = useCallback(async (stage: AshbyStageCatalogStage, key: string) => {
    if (key === milestoneKey(stage.milestone) || savingRef.current.has(stage.id)) return;
    savingRef.current.add(stage.id);
    const milestone = milestoneFromKey(key);
    setSaving((prev) => ({ ...prev, [stage.id]: true }));
    setStatus(null);
    setAlert(null);
    try {
      const { stage: updated } = await api.labelAshbyStage(stage.id, milestone);
      if (!mounted.current) return;
      setLoad((prev) => (prev.state === 'ready'
        ? { state: 'ready', data: { ...prev.data, stages: prev.data.stages.map((s) => (s.id === updated.id ? updated : s)) } }
        : prev));
      setStatus({ tone: 'success', text: labelSavedText(stage, updated, milestone === null) });
    } catch (e) {
      if (mounted.current) setAlert(`Couldn't save the label for ${stageTitle(stage)}. ${copyFor(LABEL_ERRORS, e)}`);
    } finally {
      savingRef.current.delete(stage.id);
      if (mounted.current) setSaving((prev) => { const next = { ...prev }; delete next[stage.id]; return next; });
    }
  }, []);

  const data = load.state === 'ready' ? load.data : null;
  // The header counts the live plan; a removed stage is listed but not counted.
  const counts = useMemo(() => {
    const live = data ? data.stages.filter((s) => s.inPlan) : [];
    return {
      live: live.length,
      labelled: live.filter((s) => s.milestone !== null).length,
      gone: data ? data.stages.length - live.length : 0,
    };
  }, [data]);
  const meta = data && data.stages.length > 0
    ? `${counts.live} ${counts.live === 1 ? 'stage' : 'stages'} · ${counts.labelled} labelled` +
      (counts.gone > 0 ? ` · ${counts.gone} no longer in the plan` : '')
    : undefined;

  return (
    <div className="space-y-5">
      <SectionHeader
        level={2}
        title="Stages"
        meta={meta}
        description={DESCRIPTION}
        actions={
          <Button variant="secondary" onClick={() => { void refresh(); }} disabled={refreshing || load.state === 'loading'}>
            {refreshing ? 'Refreshing…' : 'Refresh from Ashby'}
          </Button>
        }
      />

      {/* Mounted before it has anything to say, so its text is announced. */}
      <div role="status" className={status ? undefined : 'sr-only'}>
        {status && (
          <InlineNotice tone={status.tone} role="none">
            {status.text}
          </InlineNotice>
        )}
      </div>
      {alert && (
        <InlineNotice tone="danger" role="alert">
          {alert}
        </InlineNotice>
      )}

      {load.state === 'loading' && <LoadingPanel label="Loading stages…" />}

      {load.state === 'failed' && <ErrorPanel message={load.message} onRetry={() => { void read(true); }} />}

      {data && data.unreadMappings > 0 && data.stages.length > 0 && (
        <InlineNotice tone="warning" role="none">
          {unreadText(data.unreadMappings)}
        </InlineNotice>
      )}

      {data && data.truncated && (
        <InlineNotice tone="warning" role="none">
          Only part of the catalogue is shown: there are more live jobs or stages than one page holds.
        </InlineNotice>
      )}

      {data && data.stages.length === 0 && (
        data.enabledMappings === 0 ? (
          <EmptyPanel
            title="No live Ashby jobs"
            hint="Stages come from the interview plan of each live job mapping. Turn a mapping on in Ashby Live Jobs first."
          />
        ) : (
          <EmptyPanel
            title="Stages not read yet"
            hint="Press Refresh from Ashby to read the live jobs' interview plan."
          />
        )
      )}

      {data && data.stages.length > 0 && (
        <Table bare flush caption="Ashby stages in plan order: position, stage, Ashby type, what it counts as, and who set that. Stages no longer in the plan come last">
          <THead>
            <Tr>
              <Th className="w-12">#</Th>
              <Th>Stage</Th>
              <Th>Ashby type</Th>
              <Th>Counts as</Th>
              <Th>Set by</Th>
            </Tr>
          </THead>
          <TBody>
            {data.stages.map((stage, index) => {
              const title = stageTitle(stage);
              // Two stages can share a title (a removed R5 and a new R5): the picker says which.
              const name = stage.inPlan ? `What ${title} counts as` : `What ${title}, no longer in the Ashby plan, counts as`;
              return (
                <Tr key={stage.id}>
                  <Td className="tabular-nums text-ink-secondary">{stage.inPlan ? stagePosition(stage.order) : '—'}</Td>
                  <Td className="min-w-[10rem] font-medium text-ink">
                    <span className="block">{title}</span>
                    {!stage.inPlan && <span className="block text-xs font-normal text-ink-tertiary">No longer in the Ashby plan</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-secondary">{stageTypeLabel(stage.type)}</Td>
                  <Td>
                    {/* In flow, not floating: the table's scroller would clip a floating list. */}
                    <Combobox
                      id={`stage-milestone-${index}`}
                      aria-label={name}
                      size="sm"
                      compact
                      searchable={false}
                      value={milestoneKey(stage.milestone)}
                      busy={saving[stage.id] === true}
                      onChange={(key) => { void label(stage, key); }}
                      options={OPTIONS}
                      placeholder="Not labelled"
                      searchLabel={name}
                      listLabel="Milestones"
                      className="w-44 min-w-[11rem]"
                    />
                  </Td>
                  <Td className="whitespace-nowrap text-ink-secondary">{milestoneSourceLabel(stage.milestoneSource)}</Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
