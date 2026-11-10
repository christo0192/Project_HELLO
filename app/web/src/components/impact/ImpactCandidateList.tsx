/**
 * The applications behind a number on the Business impact page (owner decision
 * D-M031-3: every staff role sees it), read page by page from
 * `GET /api/impact/candidates`.
 *
 * It is a `SlideOver`: focus moves into it on open and back to the pressed
 * number on close, Tab stays inside, and Escape closes it. Each name opens the
 * candidate's Phone screening tab. It prints what the candidate page already
 * shows and nothing more: no email, no phone, no Ashby id, no archive free text.
 * An application that never became a candidate is still listed, so the list
 * matches its count: it says so, and has no name and nothing to open.
 *
 * It lists only what the reader could open on the candidate page (D-M031-5).
 * The rest are someone else's candidates: the API counts them in `hidden` and
 * never sends them, and the panel says how many in one plain line under the
 * range. When that is all of them, the line is all the panel says: an empty
 * state there would tell the reader nobody is behind the figure. Paging counts
 * the listed applications only.
 *
 * A later page keeps the rows on screen while it loads (marked busy), so the
 * pager the reader just pressed never unmounts under their focus.
 */
import { useEffect, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  Pagination,
  SlideOver,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  cx,
} from '../design';
import { apiErrorCopy } from '../../lib/api-error-copy';
import { formatDate } from '../../lib/datetime';
import { IST_TIME_ZONE } from '../../lib/ist-datetime';
import { formatCount, milestoneLabel } from '../../lib/impact-format';
import {
  fetchImpactCandidates,
  type ImpactCandidateRow,
  type ImpactCandidatesPage,
  type ImpactSummaryParams,
} from '../../lib/impact';
import { Dash, RowHead, type ImpactListRequest } from './ImpactCount';
import { ImpactVerdictWord, ProvisionalMark } from './ImpactVerdict';
import { IMPACT_LIST_PAGE_SIZE, applicationStatusClass } from './rules';

export interface OpenImpactListRequest extends ImpactListRequest {
  /** The window and job the list is read for: the page's, narrowed by the request's scope. */
  params: ImpactSummaryParams;
  /** Those in words: "Last 12 weeks, all jobs". */
  scopeText: string;
}

function IstDate({ value }: { value: string | null }) {
  if (!value) return <Dash />;
  const text = formatDate(value, { day: 'numeric', month: 'short', year: 'numeric', timeZone: IST_TIME_ZONE });
  return <>{text}</>;
}

/**
 * Who the row is: a link to the candidate, or, for an application that never
 * became a candidate, words that say so and nothing to open. That row has no
 * candidate record, so it has no name to print either.
 */
function Who({ row }: { row: ImpactCandidateRow }) {
  if (row.candidateId === null) {
    return (
      <>
        <span className="block font-medium text-ink">Not a candidate yet</span>
        <span className="block text-meta text-ink-secondary">Resume not processed</span>
      </>
    );
  }
  return (
    <Link to={`/candidates/${encodeURIComponent(row.candidateId)}?tab=phone`} className="textlink font-medium text-ink">
      {row.name ?? 'Name not recorded'}
    </Link>
  );
}

/** The applications behind the figure that the reader cannot open, in words. */
function hiddenLine(hidden: number): string {
  return hidden === 1
    ? '1 more belongs to another recruiter and is not listed.'
    : `${formatCount(hidden)} more belong to other recruiters and are not listed.`;
}

function CandidateRow({ row }: { row: ImpactCandidateRow }) {
  const milestone = milestoneLabel(row.currentMilestone);
  const showMilestone = milestone && milestone.toLowerCase() !== (row.currentStageTitle ?? '').trim().toLowerCase();
  return (
    <Tr data-candidate={row.candidateId ?? undefined}>
      <RowHead className="py-2">
        <Who row={row} />
        {row.roleTitle && <span className="block text-meta text-ink-tertiary">{row.roleTitle}</span>}
      </RowHead>
      <Td className="py-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ImpactVerdictWord verdict={row.verdict} score={row.score} />
          {row.provisional && <ProvisionalMark />}
        </span>
      </Td>
      <Td className="py-2">
        {row.currentStageTitle ? <span className="block">{row.currentStageTitle}</span> : <Dash />}
        {showMilestone && <span className="block text-meta text-ink-tertiary">{milestone}</span>}
      </Td>
      <Td className={cx('py-2 font-medium', applicationStatusClass(row.status))}>{row.status ?? <Dash />}</Td>
      <Td className="whitespace-nowrap py-2 tabular-nums">
        <IstDate value={row.enteredChristyAt} />
      </Td>
      <Td className="whitespace-nowrap py-2 tabular-nums">
        <IstDate value={row.lastMoveAt} />
      </Td>
    </Tr>
  );
}

export interface ImpactCandidateListProps {
  request: OpenImpactListRequest | null;
  onClose: () => void;
  /** The number that was pressed: focus goes back to it. */
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function ImpactCandidateList({ request, onClose, returnFocusRef }: ImpactCandidateListProps) {
  // The page makes a new request object each time a number is pressed, and the panel stays
  // mounted while it is closed. So the page reached, the rows and a failure all belong to one
  // opening: pressing the same number again starts on the first page, with nothing left over.
  const [paging, setPaging] = useState<{ request: OpenImpactListRequest | null; page: number }>({ request, page: 1 });
  const page = paging.request === request ? paging.page : 1;
  const [answer, setAnswer] = useState<{ request: OpenImpactListRequest; data: ImpactCandidatesPage } | null>(null);
  const [failure, setFailure] = useState<{ request: OpenImpactListRequest; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!request) return undefined;
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    fetchImpactCandidates(
      { ...request.params, target: request.target, page, pageSize: IMPACT_LIST_PAGE_SIZE },
      controller.signal,
    )
      .then((data) => {
        if (live) setAnswer({ request, data });
      })
      .catch((error: unknown) => {
        if (live) setFailure({ request, message: apiErrorCopy(error) });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [request, page, attempt]);

  // A later page of the same opening keeps the rows on screen while it loads.
  const data = answer && answer.request === request ? answer.data : null;
  const failed = failure && failure.request === request ? failure.message : null;
  // Paging counts the listed applications only: `hidden` are never sent, so they have no page.
  const total = data?.total ?? 0;
  const hidden = data?.hidden ?? 0;
  const pageSize = IMPACT_LIST_PAGE_SIZE;
  const shownPage = data?.page ?? page;
  const from = total === 0 ? 0 : (shownPage - 1) * pageSize + 1;
  // With every row hidden there is no name to open, so the panel does not promise one.
  const opensNames = data !== null && data.total === 0 ? '' : ' Each name opens the candidate’s Phone screening tab.';
  const description = request
    ? `${formatCount(request.count)} ${request.count === 1 ? 'application' : 'applications'}, ${request.scopeText}.${opensNames}`
    : undefined;

  return (
    <SlideOver
      open={request !== null}
      onClose={onClose}
      title={request?.title ?? ''}
      description={description}
      idPrefix="impact-list"
      returnFocusRef={returnFocusRef}
      size="wide"
    >
      {failed ? (
        <ErrorPanel
          compact
          message={`The applications couldn’t load. ${failed}`}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : data === null ? (
        <LoadingPanel compact label="Loading applications…" />
      ) : total === 0 && hidden > 0 ? (
        // Every application behind the figure is someone else's: say only that.
        <EmptyPanel compact title={hiddenLine(hidden)} />
      ) : data.rows.length === 0 ? (
        <EmptyPanel
          compact
          title="No applications to show"
          hint="The figures may have moved since this page loaded. Close this list and reload the page to see the latest."
        />
      ) : (
        <div aria-busy={loading || undefined}>
          <Table bare flush focusWhenScrolling caption={`Applications: ${request?.title ?? ''}`} style={{ minWidth: '52rem' }}>
            <THead>
              <Tr>
                <Th>Candidate</Th>
                <Th>AI recommendation</Th>
                <Th>Current stage</Th>
                <Th>Status</Th>
                <Th>Entered Christy</Th>
                <Th>Last move</Th>
              </Tr>
            </THead>
            <TBody>
              {/* One person on two jobs is two applications, so the id alone is not a key. */}
              {data.rows.map((row, index) => (
                <CandidateRow key={`${row.candidateId}:${index}`} row={row} />
              ))}
            </TBody>
          </Table>
          <Pagination
            noun="applications"
            hidePageSize
            state={{
              page: shownPage,
              pageSize,
              pageCount: Math.max(1, Math.ceil(total / pageSize)),
              total,
              from,
              to: Math.min(total, from + data.rows.length - 1),
              setPage: (next) => setPaging({ request, page: Math.max(1, next) }),
              setPageSize: () => undefined,
            }}
          />
          {/* Plain text after the range it qualifies, so a screen reader reads the two together. */}
          {hidden > 0 && <p className="px-1 pt-2 text-label text-ink-secondary">{hiddenLine(hidden)}</p>}
        </div>
      )}
    </SlideOver>
  );
}
