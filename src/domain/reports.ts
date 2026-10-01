/**
 * The worker → orchestrator report (PRD §12.2, §10.5).
 *
 * **One tool, not five.** `state` and `outputs` are orthogonal: `outputs` applies
 * to any state, so a worker can attach an artifact mid-task without changing what
 * the board thinks it is doing. The alternative — five tools — would make the
 * batching policy below per-tool and therefore five times as likely to disagree
 * with itself.
 *
 * `state` is optional on purpose. A report that only attaches an artifact says
 * nothing about progress, and requiring a state would make a worker either lie
 * about its phase or skip reporting the artifact.
 *
 * @module dsho/domain/reports
 */

/** What a worker is telling the orchestrator. */
export const ReportState = Object.freeze({
  /** Still working; the note is progress the board does not need to react to. */
  checkpoint: 'checkpoint',
  /** Paused on a person: the worker sits at an empty prompt awaiting an answer. */
  needsInput: 'needs_input',
  /** Paused on a person, but on a *decision* the agent cannot make. */
  stuck: 'stuck',
  /** The task is finished. */
  done: 'done',
})

/** The union of every report state, plus "no state given". */
export type ReportState = (typeof ReportState)[keyof typeof ReportState]

/** The states that mean a person is the unblocker. Both are sticky (PRD §7.6). */
export const NEEDS_PERSON_STATES: readonly ReportState[] = [
  ReportState.needsInput,
  ReportState.stuck,
]

/** What a worker produced. */
export const OutputKind = Object.freeze({
  /** A file or directory worth looking at. */
  artifact: 'artifact',
  /** A pull request now exists and belongs to this worker. */
  prCreated: 'pr_created',
  /** A review pass finished. */
  prReviewed: 'pr_reviewed',
})

/** The union of every output kind. */
export type OutputKind = (typeof OutputKind)[keyof typeof OutputKind]

/** One produced thing. */
export interface ReportOutput {
  kind: OutputKind
  /** For `artifact`, a path; for `pr_created`, the PR number or URL. */
  ref: string
}

/** One report, as stored. */
export interface Report {
  id: string
  workerId: string
  issueId: string
  /** Absent when the report only attaches an output. */
  state?: ReportState
  note: string
  /** True when `note` was longer than the cap and had to be shortened. */
  truncated?: boolean
  outputs: readonly ReportOutput[]
  createdAt: number
  /** Set when delivery was planned; absent while the report is still held. */
  deliveredAt?: number
  /** The batch this report was delivered in, for claim-based delivery. */
  batchId?: string
}

/** The reference's `MaxReportTextCharacters`. */
export const MAX_REPORT_CHARACTERS = 1000

/** Something the caller must fix. */
export class ReportError extends Error {
  readonly field: string

  constructor(field: string, problem: string) {
    super(`report ${field}: ${problem}`)
    this.name = 'ReportError'
    this.field = field
  }
}

const STATES: readonly string[] = Object.values(ReportState)
const KINDS: readonly string[] = Object.values(OutputKind)

/** Validates a state, or returns undefined when none was given. */
export function assertReportState(value: string | undefined): ReportState | undefined {
  if (value === undefined || value === '') return undefined
  if (!STATES.includes(value)) {
    throw new ReportError('state', `must be one of ${STATES.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return value as ReportState
}

/** Validates an output list. */
export function assertOutputs(value: readonly ReportOutput[] | undefined): ReportOutput[] {
  const outputs: ReportOutput[] = []
  for (const [index, output] of (value ?? []).entries()) {
    if (!KINDS.includes(output?.kind)) {
      throw new ReportError(`outputs[${index}].kind`, `must be one of ${KINDS.join(' | ')}`)
    }
    if (typeof output.ref !== 'string' || output.ref.trim() === '') {
      throw new ReportError(`outputs[${index}].ref`, 'must be a non-empty string')
    }
    outputs.push({ kind: output.kind, ref: output.ref.trim() })
  }
  return outputs
}

/**
 * Shortens a note to the cap.
 *
 * Marked rather than silently cut: a truncation marker is how a reader knows the
 * worker said more than fits, and a silent cut would make a clipped sentence look
 * like the whole message. The marker is included in the cap, so the result is
 * never longer than promised.
 */
export function truncateNote(note: string, max = MAX_REPORT_CHARACTERS): { note: string; truncated: boolean } {
  const text = note ?? ''
  if (text.length <= max) return { note: text, truncated: false }
  const marker = ' …[truncated]'
  return { note: text.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true }
}

/** Reports whether a state means a person is the unblocker. */
export function needsPerson(state: ReportState | undefined): boolean {
  return state !== undefined && NEEDS_PERSON_STATES.includes(state)
}
