/**
 * livekit-phone/ports.ts — the DI seams the reconciliation sweep depends on.
 *
 * Both are READ-ONLY by type. Neither can dial, originate a SIP leg, mutate a
 * room, remove a participant or write a phone row: the only write in this
 * integration goes through `PhoneStores.applyEvent`, which is 0042's audited
 * RPC. That is a property of the interfaces, not of the implementations.
 */

/**
 * The single participant fact reconciliation needs: is OUR leg still in the
 * room? `identity` is `phone-<attempt uuid>` and is the only field read.
 *
 * `attributes` is deliberately ABSENT. A LiveKit SIP participant carries
 * `sip.phoneNumber` and `sip.trunkPhoneNumber`, so a snapshot that exposed the
 * attribute map would put a subscriber number one property access away from
 * every consumer of this port.
 */
export interface LiveKitParticipantSnapshot {
  readonly identity: string;
}

/** A bounded, read-only view of LiveKit room state. */
export interface LiveKitRoomReader {
  /**
   * Participants currently in `room`. Must reject rather than invent on
   * failure; the sweep treats a throw as "unknown" and does nothing.
   */
  listParticipants(room: string): Promise<ReadonlyArray<LiveKitParticipantSnapshot>>;
}

/**
 * One attempt that is DUE for a dropped-webhook check: still in a live state,
 * old enough that its terminating webhook should have arrived, and young
 * enough to still be worth looking at.
 */
export interface DuePhoneAttempt {
  readonly attemptId: string;
  readonly engagementId: string;
  /** The attempt's fencing epoch — passed back to the RPC, never invented. */
  readonly epoch: number;
  /** LiveKit room, or null when the attempt never reached a room. */
  readonly roomName: string | null;
  readonly attemptState: string;
  readonly engagementState: string;
}

/** A bounded, read-only view of the attempts a sweep may consider. */
export interface DuePhoneAttemptReader {
  listDueAttempts(input: {
    /** Only attempts admitted at or before this instant (the minimum age). */
    readonly admittedBefore: Date;
    /** Only attempts admitted at or after this instant (the lookback floor). */
    readonly admittedAfter: Date;
    /**
     * Only attempts whose LEASE IS STILL HELD at this instant.
     *
     * This is not an optimisation — it is the line between two sweepers with
     * opposite contracts. An EXPIRED lease means OUR worker died, and
     * `reclaim_phone_attempt_leases` owns that: it abandons the attempt,
     * sets `outcome_class = null` and CHARGES NO BUDGET, because a dead
     * worker is our failure and not the candidate's attempt. This sweep
     * posts real outcomes, which DO charge. Overlapping the two would let a
     * crash of ours spend a candidate's no-answer budget.
     */
    readonly leaseHeldAt: Date;
    readonly limit: number;
  }): Promise<ReadonlyArray<DuePhoneAttempt>>;
}
