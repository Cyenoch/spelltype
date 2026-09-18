export { createRoomRuntime, RoomRuntime, type RoomRuntimeOptions } from './runtime';
export { RoomRejection, type RoomRejectionCode } from './rejection';
export { reservationStateOf } from './reservation';
export { duelIsOngoing } from './rules';
export {
  InputBudget,
  SocketRegistry,
  createRoomScope,
  type RoomScope,
  type SocketAuth,
} from './scope';
export { handleClientFrame } from './frames';
export { handleLobbyFrame, type LobbyFrame } from './lobby';
export { manualLeave } from './leave';
export { handleInput, type InputFrame } from './combat';
export { advanceOnce, type AdvanceOutcome } from './transitions';
export { snapshotFor, pushSnapshots, sendSnapshotTo } from './snapshots';
export {
  createRoom,
  getRoom,
  updateRoom,
  readRoomRelease,
  type RoomPatch,
  type RoomReleaseState,
} from './storage/room';
export * from './storage/players';
export * from './storage/departures';
export { insertResults } from './storage/results';
export { readEvents, appendEvents } from './storage/events';
export { readVolley, queueCast, clearVolley, type PendingVolley } from './storage/volley';
export { roomPolicyValid, inputGateState, INPUT_GATE_ERROR_MESSAGE } from './input-gate';
export { advanceCombat } from './volleys';
export { INPUT_POLICY_VERSION, INPUT_MIN_MS_PER_CODE_POINT } from './rules';
export { readSpellBook } from './storage/spell-book';
export { registerSessionRoom, unregisterSessionRoom, sessionIsLive } from './storage/room-sessions';
export type { RoomQuery } from './storage/query';
