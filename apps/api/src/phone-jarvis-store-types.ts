export type PhoneSession = {
  id: string;
  callSid: string | null;
  direction: "inbound" | "outbound";
  captureId: string;
  expiresAt: Date;
  attempts: number;
  authenticated: boolean;
  connection: "pending" | "connecting" | "connected" | "closed";
};
export interface PhoneJarvisStore {
  /** Unique CallSid; duplicates return the same session. */
  createInbound(callSid: string): Promise<PhoneSession>;
  get(id: string): Promise<PhoneSession | null>;
  /** Atomic compare-and-set: pending + null CallSid, or same existing CallSid. */
  bindCall(id: string, callSid: string): Promise<boolean>;
  /** Atomically consume expected attempt and optionally authorize. Must enforce
   * expiry, pending connection, CallSid, attempts < 3 and expected attempt. */
  consumePinAttempt(id: string, callSid: string, expectedAttempt: number, correct: boolean): Promise<PhoneSession | null>;
  /** Atomic authenticated pending -> connecting; refuses expired sessions. */
  claimConnection(id: string, callSid: string): Promise<boolean>;
  markConnected(id: string, callSid: string): Promise<void>;
  /** Terminal status only, monotonic, matching CallSid. No automatic redial. */
  close(id: string, callSid: string, status: string): Promise<void>;
}
